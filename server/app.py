"""yeg-transit server: ETS GTFS in SQLite, live TripUpdates in memory, small JSON API, static web app."""
import csv, difflib, io, json, math, re, os, sqlite3, sys, threading, time, urllib.request, zipfile
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urlencode
from zoneinfo import ZoneInfo

from google.transit import gtfs_realtime_pb2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("DATA_DIR", os.path.join(ROOT, "data"))
WEB = os.path.join(ROOT, "web")
DB = os.path.join(DATA, "gtfs.db")
try:  # written by scripts/deploy.sh into the build context, never committed
    SHA = open(os.path.join(ROOT, "server", "VERSION")).read().strip()
except FileNotFoundError:  # only a missing file means a dev run; an unreadable one must fail loudly, not report "dev"
    SHA = "dev"
GTFS_URL = "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/GTFS/GTFS.zip"
RT_URL = "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/TripUpdate/TripUpdates.pb"
VP_URL = "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb"
ALERTS_URL = "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Alert/Alerts.pb"
TZ = ZoneInfo("America/Edmonton")
SKIPPED = gtfs_realtime_pb2.TripUpdate.StopTimeUpdate.SKIPPED


def fetch(url, timeout):
    # gtfs.edmonton.ca answers 403 to Python's default User-Agent
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "yeg-transit/0.1"}), timeout=timeout)


def secs(t):
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def import_gtfs(zpath, dbpath):
    tmp = dbpath + ".new"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript("""
      PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
      CREATE TABLE stops(stop_id TEXT PRIMARY KEY, code TEXT, name TEXT, lat REAL, lon REAL);
      CREATE TABLE routes(route_id TEXT PRIMARY KEY, short TEXT, long TEXT, color TEXT, text_color TEXT);
      CREATE TABLE trips(trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, headsign TEXT, shape_id TEXT, block_id TEXT);
      CREATE TABLE stop_times(trip_id TEXT, stop_id TEXT, dep INTEGER, headsign TEXT, seq INTEGER);
      CREATE TABLE shapes(shape_id TEXT, seq INTEGER, lat REAL, lon REAL);
      CREATE TABLE service_dates(service_id TEXT, date TEXT);
    """)
    z = zipfile.ZipFile(zpath)
    rows = lambda name: csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig"))
    db.executemany("INSERT INTO stops VALUES(?,?,?,?,?)",
                   ((r["stop_id"], r["stop_code"] or r["stop_id"], r["stop_name"], float(r["stop_lat"]), float(r["stop_lon"]))
                    for r in rows("stops.txt") if r["location_type"] in ("", "0")))
    db.executemany("INSERT INTO routes VALUES(?,?,?,?,?)",
                   ((r["route_id"], r["route_short_name"], r["route_long_name"], r["route_color"], r["route_text_color"])
                    for r in rows("routes.txt")))
    db.executemany("INSERT INTO trips VALUES(?,?,?,?,?,?)",
                   ((r["trip_id"], r["route_id"], r["service_id"], r["trip_headsign"], r.get("shape_id"), r.get("block_id") or None)
                    for r in rows("trips.txt")))
    db.executemany("INSERT INTO stop_times VALUES(?,?,?,?,?)",
                   ((r["trip_id"], r["stop_id"], secs(r["departure_time"] or r["arrival_time"]), r["stop_headsign"] or None,
                     int(r["stop_sequence"]))
                    for r in rows("stop_times.txt") if r["pickup_type"] != "1"))
    if "calendar.txt" in z.namelist():
        # ponytail: calendar.txt weekly ranges are not expanded; ETS ships calendar_dates only (2026-10).
        print("warning: calendar.txt present but ignored", file=sys.stderr)
    db.executemany("INSERT INTO service_dates VALUES(?,?)",
                   ((r["service_id"], r["date"]) for r in rows("calendar_dates.txt") if r["exception_type"] == "1"))
    db.executemany("INSERT INTO shapes VALUES(?,?,?,?)",
                   ((r["shape_id"], int(r["shape_pt_sequence"]), round(float(r["shape_pt_lat"]), 5), round(float(r["shape_pt_lon"]), 5))
                    for r in rows("shapes.txt")) if "shapes.txt" in z.namelist() else ())
    db.executescript("""
      CREATE INDEX st_stop ON stop_times(stop_id, dep);
      CREATE INDEX st_trip ON stop_times(trip_id, seq);
      CREATE INDEX sh_shape ON shapes(shape_id, seq);
      CREATE INDEX sd_date ON service_dates(date, service_id);
      -- A block is one bus's day: its trips one after another (same service_id).
      CREATE INDEX tr_block ON trips(service_id, block_id);
      -- Routes per stop, so search results can tell the bays of a transit centre apart (about 8 s here).
      CREATE TABLE stop_routes AS SELECT stop_id, group_concat(short) AS routes FROM
        (SELECT DISTINCT st.stop_id, r.short FROM stop_times st JOIN trips USING(trip_id) JOIN routes r USING(route_id)
         ORDER BY st.stop_id, r.short) GROUP BY stop_id;
      CREATE UNIQUE INDEX sr_stop ON stop_routes(stop_id);
    """)
    db.commit()
    db.close()
    os.replace(tmp, dbpath)


def refresh_gtfs():
    zpath = os.path.join(DATA, "GTFS.zip")
    with fetch(GTFS_URL, 120) as r, open(zpath + ".part", "wb") as f:
        f.write(r.read())
    os.replace(zpath + ".part", zpath)
    import_gtfs(zpath, DB)
    global VOCAB
    VOCAB = None
    WHERE.clear()


class Live:
    """Latest TripUpdates: trip_id -> ({stop_id: epoch, or None if skipped}, last delay, {stop_id: ETS stop sequence}).
    Latest VehiclePositions: trip_id -> (lat, lon, bearing, epoch, stop sequence it is at or heading to, route_id, direction).
    Active Alerts (stop closed, moved, detoured): stop_id -> [{effect, head, text, routes, until}], every 5 min."""

    def __init__(self):
        self.trips, self.ts, self.error = {}, 0, None
        self.vehicles, self.vp_error = {}, None
        self.assigned, self.on_trip = {}, {}  # trip_id -> vehicle id ETS has put on it; vehicle id -> trip it is driving now
        self.alerts, self.alerts_at = {}, 0

    def poll(self):
        try:
            with fetch(RT_URL, 20) as r:
                feed = gtfs_realtime_pb2.FeedMessage()
                feed.ParseFromString(r.read())
            trips, assigned = {}, {}
            for e in feed.entity:
                tu = e.trip_update
                stops, delay, seqs = {}, 0, {}
                for s in tu.stop_time_update:
                    ev = s.departure if s.HasField("departure") else s.arrival
                    delay = ev.delay or delay
                    # A loop starts and ends at the same stop (918B at WEM): keep the first pass, when it leaves,
                    # not the arrival back 30 min later. Passes ETS has already dropped leave the next one first.
                    if s.stop_id not in stops:
                        stops[s.stop_id] = None if s.schedule_relationship == SKIPPED else (ev.time or None)
                        seqs[s.stop_id] = s.stop_sequence
                trips[tu.trip.trip_id] = (stops, delay, seqs)
                if tu.vehicle.id:
                    assigned[tu.trip.trip_id] = tu.vehicle.id
            self.trips, self.assigned, self.ts, self.error = trips, assigned, feed.header.timestamp, None
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"
            print("live poll failed:", self.error, file=sys.stderr)
        try:
            with fetch(VP_URL, 20) as r:
                feed = gtfs_realtime_pb2.FeedMessage()
                feed.ParseFromString(r.read())
            vps = [e.vehicle for e in feed.entity if e.HasField("vehicle") and e.vehicle.trip.trip_id]
            self.vehicles = {v.trip.trip_id: (v.position.latitude, v.position.longitude, v.position.bearing,
                                              v.timestamp or feed.header.timestamp, v.current_stop_sequence,
                                              v.trip.route_id, v.trip.direction_id) for v in vps}
            self.on_trip = {v.vehicle.id: v.trip.trip_id for v in vps if v.vehicle.id}
            self.vp_error = None
        except Exception as e:
            self.vp_error = f"{type(e).__name__}: {e}"
            print("vehicle poll failed:", self.vp_error, file=sys.stderr)
        if time.time() - self.alerts_at >= 300:
            try:
                self.alerts, self.alerts_at = self.poll_alerts(), time.time()
            except Exception as e:
                print("alerts poll failed:", f"{type(e).__name__}: {e}", file=sys.stderr)

    @staticmethod
    def poll_alerts():
        with fetch(ALERTS_URL, 20) as r:
            feed = gtfs_realtime_pb2.FeedMessage()
            feed.ParseFromString(r.read())
        now, out = time.time(), {}
        text = lambda t: t.translation[0].text.strip() if t.translation else ""
        for e in feed.entity:
            a = e.alert
            periods = [(p.start or 0, p.end or float("inf")) for p in a.active_period]
            if periods and not any(lo <= now < hi for lo, hi in periods):
                continue
            item = {"effect": gtfs_realtime_pb2.Alert.Effect.Name(a.effect), "head": text(a.header_text),
                    "text": text(a.description_text), "routes": sorted({i.route_id for i in a.informed_entity if i.route_id}),
                    "until": max((hi for lo, hi in periods if lo <= now < hi), default=0)}
            for stop_id in {i.stop_id for i in a.informed_entity if i.stop_id}:
                out.setdefault(stop_id, []).append(item)
        return out

    def run(self):
        while True:
            self.poll()
            time.sleep(30)


LIVE = Live()


def service_days(now):
    """(yyyymmdd, epoch of that day's local noon minus 12h) for yesterday..tomorrow; GTFS times run past 24:00."""
    out = []
    for off in (-1, 0, 1):
        d = (now + timedelta(days=off)).date()
        noon = datetime(d.year, d.month, d.day, 12, tzinfo=TZ)
        out.append((d.strftime("%Y%m%d"), int(noon.timestamp()) - 43200))
    return out


def scheduled(db, stop_id, start, end):
    """Scheduled departures at stop_id with epoch in [start, end)."""
    out = []
    for date, base in service_days(datetime.fromtimestamp(start, TZ)):
        lo, hi = start - base, end - base
        if hi < 0 or lo > 30 * 3600:
            continue
        for trip_id, seq, dep, hs, short, color, text_color, ths in db.execute("""
            SELECT st.trip_id, st.seq, st.dep, st.headsign, r.short, r.color, r.text_color, t.headsign
            FROM stop_times st JOIN trips t USING(trip_id) JOIN routes r USING(route_id)
            WHERE st.stop_id=? AND st.dep>=? AND st.dep<?
              AND t.service_id IN (SELECT service_id FROM service_dates WHERE date=?)""",
                (stop_id, lo, hi, date)):
            out.append({"trip": trip_id, "seq": seq, "sched": base + dep, "route": short, "color": color,
                        "text_color": text_color, "headsign": ths or hs or ""})
    out.sort(key=lambda d: d["sched"])
    return out


BUS_SPEED = 8  # m/s, straight line: buses at WEM TC made 6.5 to 13 on 2026-10-22, stops and lights included
TRAINS = {"Capital", "Metro", "Valley"}


def departures(db, stop_id, n):
    now = int(time.time())
    here = db.execute("SELECT lat, lon FROM stops WHERE stop_id=?", (stop_id,)).fetchone()
    out = []
    for d in scheduled(db, stop_id, now - 1800, now + 3 * 3600):
        live = LIVE.trips.get(d["trip"])
        t, seq = d["sched"], d.pop("seq")
        if live:
            stops, delay, seqs = live
            # ETS numbers stops as GTFS does (5,100 of 5,100 on 2026-10-23), plus an end-of-run stop past the last one.
            if seqs.get(stop_id, 0) > seq:  # only a later pass is left: this one has gone (918A ending its loop at WEM)
                continue
            if stop_id in stops and seqs[stop_id] in (0, seq):
                if stops[stop_id] is None:
                    continue
                t = stops[stop_id]
            else:
                t += delay
        d["time"], d["live"] = t, bool(live)
        # ETS holds a late bus's prediction at its old time, so "Due" sat on screens with the bus 1 km out (WEM TC,
        # 2026-10-22). Where the bus is beats what ETS predicts: at the stop, gone past it, or no sooner than it can drive here.
        v = LIVE.vehicles.get(d["trip"])
        if v and v[4] and here and now - v[3] < 120 and d["route"] not in TRAINS:
            mine = db.execute("SELECT min(seq) FROM stop_times WHERE trip_id=? AND stop_id=? AND seq>=?",
                              (d["trip"], stop_id, next_stop(db, d["trip"], v))).fetchone()[0]
            m = math.hypot(v[0] - here[0], (v[1] - here[1]) * math.cos(math.radians(here[0]))) * 111000
            if mine is None:  # it has left this stop; a later ETS time is a loop coming back to end its run (918B at WEM)
                continue
            elif m <= 40:
                d["at"] = True  # pulled in, or waiting here for its time
                out.append(d)
                continue
            else:
                d["time"] = t = max(t, v[3] + int(m / BUS_SPEED))
        if t >= now - 30:
            out.append(d)
    out.sort(key=lambda d: d["time"])
    return out[:n]


FLEET = [None, []]  # the LIVE.vehicles dict the list was built from, the list


def fleet(db):
    """Every bus with a fresh position, as [lat, lon, bearing, route, headsign, trip]. Built once per feed poll
    (LIVE.vehicles is a new dict each time), so the live map costs one ETS download per 30 s however many watch it."""
    vehicles = LIVE.vehicles
    if FLEET[0] is not vehicles:
        now, out = int(time.time()), []
        for trip, v in vehicles.items():
            r = now - v[3] < 300 and db.execute("SELECT r.short, t.headsign FROM trips t JOIN routes r USING(route_id) "
                                                "WHERE t.trip_id=?", (trip,)).fetchone()
            if r:
                out.append([round(v[0], 5), round(v[1], 5), round(v[2] or 0), r[0], r[1] or "", trip])
        FLEET[:] = [vehicles, out]
    return FLEET[1]


def stop_alerts(db, stop_id, code):
    """ETS alerts naming this stop, one per message (ETS repeats it per route), with the stops it says to use instead."""
    merged = {}
    for a in LIVE.alerts.get(stop_id, []):
        m = merged.setdefault(a["head"], {**a, "routes": set()})
        m["routes"].update(a["routes"])
    out = []
    for m in merged.values():
        routes = sorted({(db.execute("SELECT short FROM routes WHERE route_id=?", (r,)).fetchone() or [r.lstrip("0")])[0]
                         for r in m["routes"]}, key=lambda r: (len(r), r))  # alerts write "056" for route 56
        codes = dict.fromkeys(c for c in re.findall(r"[#\[](\d{4,5})\b", m["text"]) if c != code)  # "Use ... #1457", "[5295]"
        use = [stop_row(r) for c in codes for r in db.execute(f"SELECT * FROM {STOPS} WHERE code=?", (c,))]
        until = m["until"] if m["until"] < time.time() + 366 * 86400 else 0  # "no end" comes as inf or the year 3000
        out.append({"effect": m["effect"], "head": m["head"], "text": m["text"], "routes": routes, "until": int(until), "use": use})
    return out


def near_stops(db, lat, lon, metres):
    """[(metres, stop row with routes)] within metres of a point."""
    k = math.cos(math.radians(lat))
    dlat = metres / 111000
    rows = db.execute(f"SELECT * FROM {STOPS} WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                      (lat - dlat, lat + dlat, lon - dlat / k, lon + dlat / k)).fetchall()
    out = [(math.hypot(r[3] - lat, (r[4] - lon) * k) * 111000, r) for r in rows]
    return sorted(x for x in out if x[0] <= metres)


def connections(db, stop_id, route):
    """Where you can change from route at stop_id: the first place down the line each other route and
    direction stops, at the same stop or one within 150 m (a transit centre's other bays, the far side of
    the street). From the route's next trip; routes you could board at stop_id itself are left out."""
    now = int(time.time())
    trip = next((d["trip"] for d in scheduled(db, stop_id, now, now + 30 * 3600) if d["route"] == route), None)
    if not trip:
        return []
    down = db.execute(f"""SELECT s.* FROM stop_times st JOIN {STOPS} s USING(stop_id)
        WHERE st.trip_id=? AND st.seq > (SELECT min(seq) FROM stop_times WHERE trip_id=? AND stop_id=?)
        ORDER BY st.seq""", (trip, trip, stop_id)).fetchall()
    here = set((db.execute("SELECT routes FROM stop_routes WHERE stop_id=?", (stop_id,)).fetchone() or [""])[0].split(","))
    seen, out = set(), []
    for off in down:
        for m, at in near_stops(db, off[3], off[4], 150):
            for r, head in db.execute("""SELECT DISTINCT r.short, t.headsign FROM stop_times st JOIN trips t USING(trip_id)
                    JOIN routes r USING(route_id) WHERE st.stop_id=?""", (at[0],)):
                if r not in here and (r, head) not in seen:
                    seen.add((r, head))
                    out.append({"route": r, "headsign": head or "", "off": off[0], "off_name": off[2], "at": at[0],
                                "at_name": at[2], "walk_m": round(m)})
    return out


def transfer(db, stop_id, route, off, at, to, walk_m):
    """For route's next buses at stop_id: live arrival at off, and whether the 'to' bus at 'at' you'd plan
    on still connects. Change time: 1 min, plus the walk at about 1 m/s."""
    now = int(time.time())
    change = 60 + walk_m
    ride = [d for d in departures(db, stop_id, 500) if d["route"] == route][:4]
    nexts = [d for d in departures(db, at, 500) if d["route"] == to]
    out = []
    for d in ride:
        hop = db.execute("""SELECT b.dep - a.dep FROM stop_times a JOIN stop_times b USING(trip_id)
            WHERE a.trip_id=? AND a.stop_id=? AND b.stop_id=? AND b.seq > a.seq ORDER BY b.seq LIMIT 1""",
                         (d["trip"], stop_id, off)).fetchone()
        if not hop:
            continue
        sched_arr = d["sched"] + hop[0]
        live = LIVE.trips.get(d["trip"])
        arr = sched_arr + (d["time"] - d["sched"])  # running late or early here: assume the same there
        if live and (live[0].get(off) or 0) > d["time"]:  # not a loop's first pass, before you even board
            arr = live[0][off]
        plan = next((n for n in nexts if n["sched"] >= sched_arr + change), None)
        catch = next((n for n in nexts if n["time"] >= arr + change), None)
        slack = plan["time"] - arr - change if plan else None
        status = None if slack is None else "on_track" if slack >= 180 else "tight" if slack >= 0 else "missed"
        out.append({"time": d["time"], "live": d["live"], "arrive": arr, "status": status, "slack": slack,
                    "plan": plan and {k: plan[k] for k in ("time", "live", "headsign")},
                    "next": catch and {k: catch[k] for k in ("time", "live", "headsign")}})
    return {"now": now, "trips": out}


# Local short names neither ETS stop names nor OpenStreetMap know: typed text -> (stop search, place search).
ALIASES = {"wem": ("west edmonton mall", "West Edmonton Mall"), "u of a": ("university", "University of Alberta"),
           "uofa": ("university", "University of Alberta"), "rah": (None, "Royal Alexandra Hospital"),
           "grant mac": ("macewan", "MacEwan University")}
# City of Edmonton parcel addresses (open data, all ~300k buildings): exact where Photon guesses.
ADDRESSES = "https://data.edmonton.ca/resource/ut27-nrpn.json"
STREET_TYPES = {"st": "street", "str": "street", "ave": "avenue", "av": "avenue", "rd": "road", "dr": "drive",
                "cres": "crescent", "cr": "crescent", "blvd": "boulevard", "ct": "court", "cl": "close", "pl": "place",
                "wy": "way", "trl": "trail", "tr": "trail", "ln": "lane", "cir": "circle", "terr": "terrace",
                "pt": "point", "pk": "park", "gr": "grove", "hts": "heights", "lk": "link", "sq": "square"}


def city_addresses(text, near=None):
    """'10220 103 St' -> [{name, sub, lat, lon}] from the city's address list; [] when it isn't a house address.
    Half-typed streets match too ('10220 10' -> 101 Ave, 102 St...), nearest first when we know where you are.
    A bare house number ('10220') gives the nearest buildings with that number, so only when we know where you are."""
    m = re.match(r"^\s*(\d+[a-z]?)(?:\s+(.*))?$", text.lower())
    if not m or (not m[2] and not near):
        return []
    words = [re.sub(r"^(\d+)(st|nd|rd|th)$", r"\1", w) for w in re.split(r"[^a-z0-9]+", m[2] or "") if w]
    words = [w for w in words if w not in ("nw", "sw", "ne", "se")]
    if words and re.fullmatch(r"\d+(st|ave?)", words[0]):  # "103st" typed as one word
        n, t = re.fullmatch(r"(\d+)(\D+)", words[0]).groups()
        words[0:1] = [n, t]
    street = " ".join(STREET_TYPES.get(w, w) if i else w for i, w in enumerate(words)).upper()
    where = f"house_number='{m[1].upper()}'" + (f" AND starts_with(street_name,'{street.replace(chr(39), chr(39) * 2)}')" if words else "")
    url = ADDRESSES + "?" + urlencode({"$select": "house_number,street_name,neighbourhood_name,avg(latitude) as lat,avg(longitude) as lon",
                                       "$where": where, "$group": "house_number,street_name,neighbourhood_name",
                                       "$order": "street_name", "$limit": 40 if words else 300})
    rows = json.load(fetch(url, 4))
    if near:
        k = math.cos(math.radians(near[0]))
        rows.sort(key=lambda r: (float(r["lat"]) - near[0]) ** 2 + ((float(r["lon"]) - near[1]) * k) ** 2)
    return [{"name": f"{r['house_number']} {r['street_name'].title().replace(' Nw', ' NW').replace(' Sw', ' SW')}",
             "sub": ", ".join(x for x in ((r.get("neighbourhood_name") or "").title(), "Edmonton") if x),
             "lat": float(r["lat"]), "lon": float(r["lon"])} for r in rows[:6]]


# Named non-residential places (OpenStreetMap: shops, schools, parks, hospitals...) so searches answer at once
# instead of waiting 2-8 s on Photon. Each row: [name, street or kind, lat, lon, kind].
# ponytail: a snapshot from one Overpass fetch on 2026-10-22; rerun scripts/places.sh when places go stale.
with open(os.path.join(ROOT, "server", "places.json")) as f:
    PLACES = [(p, re.split(r"[^a-z0-9]+", p[0].lower())) for p in json.load(f)]
BIG = {"mall", "university", "college", "hospital", "stadium", "music_venue", "theatre", "arts_centre", "attraction",
       "museum", "zoo", "library", "sports_centre", "community_centre", "conference_centre", "events_venue", "supermarket"}


def local_places(text, near=None):
    """Typed text -> up to 5 matching places: big destinations first, then names that start with it, then closest."""
    words = [w for w in re.split(r"[^a-z0-9]+", text.lower()) if w]
    if not words:
        return []
    hits = [p for p, nw in PLACES if all(any(n.startswith(w) for n in nw) for w in words)]
    k = math.cos(math.radians(near[0])) if near else 0
    hits.sort(key=lambda p: (p[4] not in BIG, not p[0].lower().startswith(words[0]),
                             (p[2] - near[0]) ** 2 + ((p[3] - near[1]) * k) ** 2 if near else len(p[0])))
    return [{"name": p[0], "sub": p[1], "lat": p[2], "lon": p[3]} for p in hits[:5]]


# "Northbound, east side of 97 Street, by Dollarama": the way buses leave the stop (from the busiest GTFS shape),
# the kerb that puts them on (traffic keeps right) and the nearest named place within 40 m. Empty when unknown.
WHERE = {}  # stop_id -> text, cleared when a new GTFS lands


def stop_where(db, stop):
    sid, name, lat, lon = stop[0], stop[2], stop[3], stop[4]
    if sid in WHERE:
        return WHERE[sid]
    k, m = math.cos(math.radians(lat)), 111320
    out = ""
    shape = db.execute("SELECT t.shape_id FROM stop_times st JOIN trips t USING(trip_id) WHERE st.stop_id=? AND t.shape_id<>'' "
                       "GROUP BY t.shape_id ORDER BY count(*) DESC LIMIT 1", (sid,)).fetchone()
    pts = shape and db.execute("SELECT lat, lon FROM shapes WHERE shape_id=? ORDER BY seq", shape).fetchall()
    if pts and len(pts) > 1:
        i = min(range(len(pts)), key=lambda j: (pts[j][0] - lat) ** 2 + ((pts[j][1] - lon) * k) ** 2)
        a = pts[i] if i < len(pts) - 1 else pts[i - 1]
        b = next((p for p in pts[i + 1:] if math.hypot(p[0] - a[0], (p[1] - a[1]) * k) * m > 30), pts[-1])
        d = int((math.degrees(math.atan2((b[1] - a[1]) * k, b[0] - a[0])) + 45) % 360 // 90)  # 0 N, 1 E, 2 S, 3 W
        out = ("Northbound", "Eastbound", "Southbound", "Westbound")[d]
        parts = re.split(r" & | at ", name)
        kind = lambda s: re.sub(r"\s+(NW|SW|NE|SE)$", "", s).split()[-1]
        along, across = (("Street", "St"), ("Avenue", "Ave")) if d % 2 == 0 else (("Avenue", "Ave"), ("Street", "St"))
        street = next((p for p in parts if kind(p) in along), None)
        if not street and len(parts) == 2 and kind(parts[1]) in across and " at " not in name:
            street = parts[0]
        elif not street and len(parts) == 2 and kind(parts[0]) in across:
            street = parts[1]
        if street:
            out += f", {('east', 'south', 'west', 'north')[d]} side of {street}"
    near = min(((math.hypot(p[2] - lat, (p[3] - lon) * k) * m, p[0]) for p, _ in PLACES), default=(99, ""))
    if near[0] <= 40 and near[1].lower() not in name.lower():
        out += (", by " if out else "By ") + near[1]
    WHERE[sid] = out
    return out


WEATHER = {"at": 0, "value": {"extra": 0, "why": "", "soon": "", "temp": None}}
PHOTON, PHOTON_LOCK = {"at": 0, "cache": {}}, threading.Lock()  # cache: Photon URL -> answer, newest 500


def walk_weather():
    """Extra walking minutes for Edmonton's weather right now (0 to 3), from Open-Meteo; cached 15 min.
    The page adds it on top of the walk time you set."""
    if time.time() - WEATHER["at"] < 900:
        return WEATHER["value"]
    url = "https://api.open-meteo.com/v1/forecast?" + urlencode({"latitude": 53.54, "longitude": -113.49, "current":
          "temperature_2m,apparent_temperature,rain,showers,snowfall,snow_depth", "hourly": "precipitation_probability,snowfall",
          "forecast_hours": 12, "timezone": "America/Edmonton"})
    try:
        r = json.load(fetch(url, 5))
        c, hr = r["current"], r.get("hourly") or {}
    except Exception as e:
        print("weather lookup failed:", repr(e), file=sys.stderr)
        WEATHER["at"] = time.time() - 600  # retry in 5 min, keep the last answer meanwhile
        return WEATHER["value"]
    extra, why = 0, []
    if (c.get("snowfall") or 0) > 0:
        extra, why = extra + 2, why + ["snow"]
    elif (c.get("snow_depth") or 0) >= 0.02:
        extra, why = extra + 1, why + ["snowy sidewalks"]
    if (c.get("rain") or 0) + (c.get("showers") or 0) > 0:
        extra, why = extra + 1, why + ["rain"]
    if (c.get("apparent_temperature") or 0) <= -20:
        extra, why = extra + 1, why + ["extreme cold"]
    # The next 12 hours, for the widget's word by the clock: "Rain soon" (within 3 h) or "Rain later", at 50% or more.
    soon, chance = "", [p or 0 for p in hr.get("precipitation_probability") or []]
    wet = [i for i, p in enumerate(chance) if p >= 50]
    if wet:
        soon = ("Snow" if any((x or 0) > 0 for x in hr.get("snowfall") or []) else "Rain") + (" soon" if wet[0] < 3 else " later")
    temp = c.get("temperature_2m")
    WEATHER.update(at=time.time(), value={"extra": min(extra, 3), "why": " and ".join(why), "soon": soon,
                                          "temp": None if temp is None else round(temp)})
    return WEATHER["value"]


FILLER = {"and", "at", "the", "of", "nw", "sw", "ne", "se"}
VOCAB = None  # every word in a stop name, for typo correction; reset by refresh_gtfs


def search_words(db, text):
    """Typed text -> words to match: drop filler, 97th/97st -> 97, swap a misspelt word for the closest stop-name word."""
    global VOCAB
    if VOCAB is None:
        VOCAB = {w for (n,) in db.execute("SELECT DISTINCT name FROM stops") for w in re.split(r"[^a-z0-9]+", n.lower()) if w}
    words = [re.sub(r"^(\d+)(st|nd|rd|th|ave?|street|avenue)$", r"\1", w) for w in re.split(r"[^a-z0-9']+", text.lower())]
    out = []
    for w in [w for w in words if w and w not in FILLER][:5]:
        if not w.isdigit() and len(w) >= 4 and not any(w in v for v in VOCAB):
            split = [[w[:i], w[i:]] for i in range(2, len(w) - 1) if w[:i] in VOCAB and w[i:] in VOCAB]  # millwoods
            out += split[0] if split else [(difflib.get_close_matches(w, VOCAB, 1, 0.75) or [w])[0]]
            continue
        out.append(w)
    return out


STOPS = "(SELECT stops.*, routes FROM stops LEFT JOIN stop_routes USING(stop_id))"


def next_stop(db, trip, v):
    """The bus's next stop sequence. ETS sends its next timepoint instead (a 201 at 107 Ave said 13 with stops 11 and 12
    still ahead, 2026-10-22), so put the bus on the leg between two stops, up to that timepoint, that it is least off.
    ETS can also keep a bus at its first stop long after it left (a 902 1.2 km west of University TC, still at seq 1,
    2026-10-23): then a bus on the route, past its second stop and heading along it, is where it is."""
    rows = db.execute("SELECT st.seq, s.lat, s.lon FROM stop_times st JOIN stops s USING(stop_id) WHERE trip_id=? "
                      "ORDER BY seq", (trip,)).fetchall()
    start = bool(rows) and v[4] <= rows[0][0]
    if not start:
        rows = [r for r in rows if r[0] <= v[4]]
    if len(rows) < 2:
        return v[4]
    k = math.cos(math.radians(v[0]))
    d = lambda a, b: math.hypot(a[0] - b[0], (a[1] - b[1]) * k)
    bus = (v[0], v[1])
    off = lambda ab: d(ab[0][1:], bus) + d(bus, ab[1][1:]) - d(ab[0][1:], ab[1][1:])
    if start:
        # Only its first half: a loop's last legs lead back into its first stop, where a bus may be driving in to start.
        # 150 m slack, as stops are straight lines and roads are not (87 Ave runs on past 120 St before Groat Rd).
        heading = lambda a, b: math.degrees(math.atan2((b[2] - a[2]) * k, b[1] - a[1]))
        early = rows[:len(rows) // 2 + 1]
        legs = [ab for ab in zip(early[1:], early[2:]) if v[2] and abs((heading(*ab) - v[2] + 180) % 360 - 180) < 60]
        if not legs or min(map(off, legs)) * 111000 >= 150:  # bearing 0 is ETS for "unknown"
            return v[4]  # at layover, or driving in to start: it hasn't left yet
        a, b = min(legs, key=off)
    else:
        a, b = min(zip(rows, rows[1:]), key=off)
    return a[0] if d(bus, b[1:]) > d(a[1:], b[1:]) else b[0]  # not at the leg's first stop yet


def stop_row(r):
    return {"id": r[0], "code": r[1], "name": r[2], "lat": r[3], "lon": r[4], "routes": (r[5] or "") if len(r) > 5 else "",
            "alert": (LIVE.alerts.get(r[0]) or [{}])[0].get("head", "")}  # "Closure of stop 1321..." in search results


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def json(self, obj, status=200, cache=0):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", f"max-age={cache}" if cache else "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # App files: make Cloudflare and the browser revalidate, or a deploy hides behind a 4 h edge cache.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        # ponytail: no full Content-Security-Policy yet; Google ads load scripts from many hosts. Every page string goes through esc().
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        super().end_headers()

    def send_error(self, code, message=None, explain=None):
        # A missing page gets our own 404 (with links back in) instead of Python's bare error page.
        if code != 404 or self.path.startswith("/api/"):
            return super().send_error(code, message, explain)
        try:
            with open(os.path.join(WEB, "404.html"), "rb") as f:
                body = f.read()
        except OSError as e:
            print("404 page:", e, file=sys.stderr)
            return super().send_error(code, message, explain)
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        parts = u.path.split("/")[2:]
        try:
            db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
            try:
                return self.route(db, parts, q)
            finally:
                db.close()
        except (ValueError, KeyError) as e:
            self.json({"error": f"bad request: {e}"}, 400)
        except Exception as e:
            print("api error:", repr(e), file=sys.stderr)
            self.json({"error": "server error"}, 500)

    def route(self, db, parts, q):
        if parts == ["health"]:
            return self.json({"live_ts": LIVE.ts, "live_age": int(time.time()) - LIVE.ts if LIVE.ts else None,
                              "live_trips": len(LIVE.trips), "live_error": LIVE.error,
                              "vehicles": len(LIVE.vehicles), "vehicle_error": LIVE.vp_error})
        if parts == ["version"]:
            return self.json({"sha": SHA})
        if parts == ["vehicles"]:
            return self.json({"now": int(time.time()), "buses": fleet(db)}, cache=10)
        if parts == ["weather"]:
            return self.json(walk_weather(), cache=600)
        if len(parts) == 3 and parts[0] == "trips" and parts[2] == "shape":
            pts = db.execute("SELECT lat, lon FROM shapes WHERE shape_id=(SELECT shape_id FROM trips WHERE trip_id=?) "
                             "ORDER BY seq", (parts[1],)).fetchall()
            return self.json(pts, cache=86400)
        if len(parts) == 2 and parts[0] == "trips":
            v, before = LIVE.vehicles.get(parts[1]), False
            if not v:  # not started yet: ETS names the bus it assigned, which is still driving an earlier trip
                v = LIVE.vehicles.get(LIVE.on_trip.get(LIVE.assigned.get(parts[1]), ""))
                before = bool(v)
            if not v:  # no assignment given: the bus is usually still on the trip before it in its block
                try:
                    prev = db.execute("""SELECT o.trip_id FROM trips t JOIN trips o ON o.service_id=t.service_id AND o.block_id=t.block_id
                        WHERE t.trip_id=? AND o.trip_id<>t.trip_id
                          AND (SELECT min(dep) FROM stop_times WHERE trip_id=o.trip_id) < (SELECT min(dep) FROM stop_times WHERE trip_id=t.trip_id)
                        ORDER BY (SELECT min(dep) FROM stop_times WHERE trip_id=o.trip_id) DESC LIMIT 1""", (parts[1],)).fetchone()
                except sqlite3.OperationalError:  # the old schema while an upgrade imports
                    prev = None
                v, before = prev and LIVE.vehicles.get(prev[0]), True
            if not v:
                return self.json({"error": "no position for this bus yet"}, 404)
            now = int(time.time())
            out = {"lat": v[0], "lon": v[1], "bearing": v[2], "age": max(0, now - v[3]),
                   # the rest of the route's buses going the same way, for context on the map
                   "others": [[o[0], o[1]] for t, o in LIVE.vehicles.items()
                              if t != parts[1] and o[5] == v[5] and o[6] == v[6] and now - o[3] < 300]}
            if before:
                out["before"] = True  # finishing an earlier trip; counting stops to yours means nothing yet
            elif v[4] and next_stop(db, parts[1], v) <= (db.execute("SELECT min(seq) FROM stop_times WHERE trip_id=?", (parts[1],)).fetchone()[0] or 0):
                out["waiting"] = True  # ETS seq 1: at layover or driving to the start, so a stop count means nothing yet
            elif "stop" in q and v[4]:
                mine = db.execute("SELECT seq FROM stop_times WHERE trip_id=? AND stop_id=? ORDER BY seq<? , seq",  # a loop route passes twice
                                  (parts[1], q["stop"], v[4])).fetchone()
                if mine:  # stops still to serve before yours; 0 = yours is next, None = it has gone past
                    nxt = next_stop(db, parts[1], v)
                    left = db.execute("SELECT count(*) FROM stop_times WHERE trip_id=? AND seq>=? AND seq<?",
                                      (parts[1], nxt, mine[0])).fetchone()[0]
                    out["stops_away"] = left if mine[0] >= nxt else None
            return self.json(out)
        if parts == ["stops", "search"]:
            text = q["q"].strip()
            text = (ALIASES.get(text.lower(), (None,))[0]) or text
            words = search_words(db, text)
            name_sql = " AND ".join(["name LIKE ?"] * len(words)) or "0"
            rows = db.execute(f"SELECT * FROM {STOPS} WHERE code=? OR stop_id=? UNION ALL "
                              f"SELECT * FROM (SELECT * FROM {STOPS} WHERE {name_sql} AND code<>? LIMIT 300)",
                              (text, text, *[f"%{w}%" for w in words], text)).fetchall()
            if "lat" in q:  # closest first when the phone shared where it is
                lat, lon = float(q["lat"]), float(q["lon"])
                k = math.cos(math.radians(lat))
                rows.sort(key=lambda r: (text not in (r[0], r[1]), (r[3] - lat) ** 2 + ((r[4] - lon) * k) ** 2))
            elif words:  # no location: names that start with the first word, then transit centres and stations, then short names
                hub = ("transit centre", "station")
                rows.sort(key=lambda r: (text not in (r[0], r[1]), not r[2].lower().startswith(words[0]),
                                         not any(h in r[2].lower() for h in hub), len(r[2])))
            return self.json([stop_row(r) for r in rows[:30]], cache=3600)
        if parts == ["places", "local"]:
            near = (float(q["lat"]), float(q["lon"])) if "lat" in q else None
            return self.json(local_places(ALIASES.get(q["q"].strip().lower(), (0, 0))[1] or q["q"], near), cache=86400)
        if parts == ["places"]:
            try:
                homes = city_addresses(q["q"], (float(q["lat"]), float(q["lon"])) if "lat" in q else None)
            except Exception as e:
                homes = []
                print(f"city address lookup failed, using Photon: {e}", flush=True)
            if homes or q["q"].strip().isdigit():  # a bare number means nothing to Photon
                return self.json(homes, cache=86400)
            # Photon is fair-use: at most 2 calls a second from this server, whoever asks; the page shows our own places meanwhile.
            # A flood starves Photon search for everyone (our own places still answer); repeats come from the cache.
            # ponytail: one global cap, not per client; per-IP needs CF-Connecting-IP, or self-host Photon with the Alberta extract.
            url = "https://photon.komoot.io/api/?" + urlencode(
                {"q": (ALIASES.get(q["q"].strip().lower(), (0, 0))[1] or q["q"])[:80], "limit": 8, "lat": round(float(q.get("lat", 53.54)), 2), "lon": round(float(q.get("lon", -113.49)), 2), "bbox": "-113.9,53.35,-113.15,53.75",
                 **({"zoom": 14, "location_bias_scale": 0.1} if "lat" in q else {})})
            with PHOTON_LOCK:
                if url in PHOTON["cache"]:
                    return self.json(PHOTON["cache"][url], cache=86400)
                if time.time() - PHOTON["at"] < 0.5:
                    return self.json({"error": "busy, try again"}, 503)
                PHOTON["at"] = time.time()
            try:
                feats = json.load(fetch(url, 6))["features"]
            except Exception as e:
                print("photon:", repr(e), file=sys.stderr)
                return self.json({"error": "place search failed"}, 502)
            out = []
            for f in feats:
                pr = f["properties"]
                if pr.get("osm_value") in ("stop", "platform", "bus_stop", "station"):
                    continue  # transit stops already come from the GTFS search
                street = " ".join(x for x in (pr.get("housenumber"), pr.get("street")) if x)
                sub = ", ".join(dict.fromkeys(x for x in (street, pr.get("district"), pr.get("city")) if x))
                lon, lat = f["geometry"]["coordinates"]
                out.append({"name": pr.get("name") or street or sub, "sub": sub if pr.get("name") else pr.get("city", ""),
                            "lat": lat, "lon": lon})
            with PHOTON_LOCK:
                PHOTON["cache"][url] = out[:5]
                if len(PHOTON["cache"]) > 500:
                    del PHOTON["cache"][next(iter(PHOTON["cache"]))]
            return self.json(out[:5], cache=86400)
        if parts == ["stops", "near"]:
            lat, lon = float(q["lat"]), float(q["lon"])
            dlat, dlon = 0.006, 0.006 / math.cos(math.radians(lat))  # about 650 m
            rows = db.execute(f"SELECT * FROM {STOPS} WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                              (lat - dlat, lat + dlat, lon - dlon, lon + dlon)).fetchall()
            rows.sort(key=lambda r: (r[3] - lat) ** 2 + ((r[4] - lon) * math.cos(math.radians(lat))) ** 2)
            return self.json([stop_row(r) for r in rows[:20]])
        if len(parts) == 3 and parts[0] == "stops":
            stop = db.execute(f"SELECT * FROM {STOPS} WHERE stop_id=?", (parts[1],)).fetchone()
            if not stop:
                return self.json({"error": "no such stop"}, 404)
            if parts[2] == "departures":
                return self.json({"stop": {**stop_row(stop), "where": stop_where(db, stop)}, "now": int(time.time()), "live_age":
                                  int(time.time()) - LIVE.ts if LIVE.ts else None,
                                  "departures": departures(db, stop[0], min(int(q.get("n", 8)), 30)),
                                  "alerts": stop_alerts(db, stop[0], stop[1])})
            if parts[2] == "connections":
                return self.json(connections(db, stop[0], q["route"]), cache=3600)
            if parts[2] == "transfer":
                return self.json(transfer(db, stop[0], q["route"], q["off"], q["at"], q["to"], int(q.get("walk_m", 0))))
            if parts[2] == "timetable":
                now = int(time.time())
                hours = min(int(q.get("hours", 30)), 48)
                rows = [[d["sched"], d["route"], d["headsign"], d["color"], d["text_color"]]
                        for d in scheduled(db, stop[0], now, now + hours * 3600)]
                return self.json({"stop": stop_row(stop), "from": now, "to": now + hours * 3600, "rows": rows})
        self.json({"error": "not found"}, 404)

    def log_message(self, fmt, *args):
        pass


def main():
    os.makedirs(DATA, exist_ok=True)
    if not os.path.exists(DB) or not sqlite3.connect(DB).execute(
            "SELECT 1 FROM sqlite_master WHERE name='tr_block'").fetchone():  # newest table or index the import makes
        print("importing GTFS...", file=sys.stderr)
        zpath = os.path.join(DATA, "GTFS.zip")
        load = lambda: import_gtfs(zpath, DB) if os.path.exists(zpath) else refresh_gtfs()
        # a new schema: keep serving the old database (older features degrade) while the import runs
        threading.Thread(target=load, daemon=True).start() if os.path.exists(DB) else load()

    def nightly():
        while True:
            time.sleep(24 * 3600)
            try:
                refresh_gtfs()
            except Exception as e:
                print("GTFS refresh failed:", repr(e), file=sys.stderr)

    threading.Thread(target=LIVE.run, daemon=True).start()
    threading.Thread(target=nightly, daemon=True).start()
    port = int(os.environ.get("PORT", 8787))
    print(f"listening on :{port}", file=sys.stderr)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()

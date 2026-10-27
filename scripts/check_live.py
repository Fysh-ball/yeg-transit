"""Do the live times people see match ETS's own feed? Exits 1 and says which bus when they don't.

Run after every release and every 15 min (docs/SETUP.md). Asks the public site, so it checks what a phone gets.
    .venv/bin/python scripts/check_live.py [--page] [https://yegbus.com]

Exit 1: a wrong time. Exit 3: yegbus.com or ETS didn't answer, twice 20 s apart (a laptop switching networks isn't a
wrong time; 2026-10-26 11:16). With --page (the 15-min timer), exit 1 only for a stop and route not already paged in
the last 6 h, and exit 3 at most once an hour; every WRONG line is still printed. Without it, every wrong time fails.

Two ways a time goes wrong, both seen on the 918B loop at WEM on 2026-10-22:
- far off ETS's own time for that bus at that stop (we showed 33 min, ETS said 8);
- far off the timetable plus the bus's current delay (a bus that had left, shown again for its loop's return).
And one ETS agrees with, so only GPS shows it: Due with the bus far away (a 902 at University TC, 1.8 km off
along its route with ETS still holding it at its first stop, 2026-10-23).
The server may push a time later than ETS when the bus can't drive there that fast, so only big gaps count.
"""
import json, math, os, sys, time, urllib.request

from google.transit import gtfs_realtime_pb2

RT_URL = "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/TripUpdate/TripUpdates.pb"
VP_URL = "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb"
RETRY = 20  # seconds before the one retry of a failed fetch
STATE = os.path.expanduser("~/.local/state/yeg-check-paged.json")  # page key -> when it last paged
QUIET = {"wrong": 6 * 3600, "unreachable": 3600}
STOPS = 25  # per run: every /api call is a Cloudflare Pages Function request, 100k a day on the free plan
OFF = 15 * 60  # seconds apart before a time counts as wrong
FAR = 1500  # metres, straight line: a bus shown 1 min or less away can't be further (8 m/s for 3 min, for stale GPS)


class Unreachable(Exception):
    pass


def get(url):
    for wait in (RETRY, None):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "yeg-transit-check/1"}),
                                          timeout=20).read()
        except (OSError, ValueError) as e:  # URLError, HTTPError, timeouts and resets are all OSError
            if wait is None:
                # No < or >: the popup reads its text as markup and drops "<urlopen error ...>" whole (2026-10-26 00:30).
                raise Unreachable(f"no answer from {url.split('/api/')[0]} ({str(e).strip('<>')})") from None
            time.sleep(wait)


def due(keys, page):
    """The page keys to page now: all of them without --page, else those not paged within their quiet time."""
    if not page:
        return keys
    try:
        with open(STATE) as f:
            last = json.load(f)
    except (OSError, ValueError):
        last = {}
    now = time.time()
    new = [k for k in keys if now - last.get(k, 0) >= QUIET[k.split(" ")[0]]]
    last = {k: t for k, t in last.items() if now - t < max(QUIET.values())}
    last.update({k: now for k in new})
    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        with open(STATE, "w") as f:
            json.dump(last, f)
    except OSError as e:
        print("can't save what was paged, so every wrong time pages:", e)
    return new


def main(argv=sys.argv[1:]):
    page = "--page" in argv
    site = next((a for a in argv if not a.startswith("--")), "https://yegbus.com").rstrip("/")
    try:
        wrong, keys, checked = check(site)
    except Unreachable as e:  # ETS's own feed: nothing to compare with
        print(f"UNREACHABLE {e} ({time.strftime('%H:%M')})")
        return 3 if due(["unreachable"], page) else 0
    print(f"{site}: {checked} live buses at {STOPS} stops, {sum(not w.startswith('HELD') for w in wrong)} wrong ({time.strftime('%H:%M')})")
    for w in wrong:
        print(w)
    if not checked and not any(k.startswith("unreachable") for k in keys):
        print("WRONG nothing to check: no live buses came back")  # a check that saw nothing must not pass
        keys.append("wrong nothing")
    paging = due(sorted(set(keys)), page)
    if any(k.startswith("wrong") for k in paging):
        return 1
    return 3 if paging else 0


def check(SITE):
    """Returns (lines to print, page keys, live buses checked)."""
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(get(RT_URL))
    ets, delay, firsts = {}, {}, {}  # (trip, stop) -> first-pass time; trip and (trip, stop) -> delay; stop -> trips starting there
    raw = {}  # trip -> each ETS entry for it, printed with a WRONG line (1407/002, 2026-10-24: site 13 min, delay said 48)
    assigned = {}  # trip -> the bus ETS put on it, which may still be driving an earlier trip
    for e in feed.entity:
        tu = e.trip_update
        assigned.setdefault(tu.trip.trip_id, tu.vehicle.id)
        raw.setdefault(tu.trip.trip_id, []).append(f"veh {tu.vehicle.id or '-'} seq:delay " + " ".join(
            f"{s.stop_sequence}:{(s.departure if s.HasField('departure') else s.arrival).delay // 60:+d}"
            for s in tu.stop_time_update[:8]))
        for i, s in enumerate(tu.stop_time_update):
            ev = s.departure if s.HasField("departure") else s.arrival
            if ev.time:
                ets.setdefault((tu.trip.trip_id, s.stop_id), ev.time)
            # This stop's own delay: a bus that left its first stop early waits at a timing stop, back to delay 0
            # (a 902 at University TC, 18 min early at its start, 2026-10-23).
            delay.setdefault((tu.trip.trip_id, s.stop_id), ev.delay)
            delay.setdefault(tu.trip.trip_id, ev.delay)  # for a stop it has passed, which ETS no longer lists
            if i == 0 and s.stop_sequence == 1:
                firsts.setdefault(s.stop_id, set()).add(tu.trip.trip_id)
    vp = gtfs_realtime_pb2.FeedMessage()
    vp.ParseFromString(get(VP_URL))
    gps = {e.vehicle.trip.trip_id: e.vehicle for e in vp.entity if e.vehicle.trip.trip_id}
    bus_at = {e.vehicle.vehicle.id: e.vehicle for e in vp.entity if e.vehicle.vehicle.id}
    # Where routes start (transit centres, where loops begin and end) first, then the stops most trips pass.
    seen = {}
    for trip, stop in ets:
        seen[stop] = seen.get(stop, 0) + 1
    stops = sorted(seen, key=lambda s: (-len(firsts.get(s, ())), -seen[s]))[:STOPS]
    wrong, keys, checked = [], [], 0
    for stop in stops:
        try:
            d = json.loads(get(f"{SITE}/api/stops/{stop}/departures?n=30"))
        except Unreachable as e:
            wrong.append(f"UNREACHABLE stop {stop}: {e}")
            keys.append("unreachable")
            break  # the rest would each wait out the same retry
        if (d.get("live_age") or 0) > 120:  # both origins down: the edge's last copy, aged (5212/906 at -3 min, 2026-10-26)
            wrong.append(f"UNREACHABLE stop {stop}: only the edge's copy answers, live times {d['live_age'] // 60} min old")
            keys.append("unreachable")
            break
        for x in d["departures"]:
            if not x.get("live") or x["trip"] not in delay:
                continue
            checked += 1
            mine, theirs = x["time"], ets.get((x["trip"], stop))
            expect = x["sched"] + delay.get((x["trip"], stop), delay[x["trip"]])
            bus = f"stop {stop} route {x['route']} trip {x['trip']}: shows {round((mine - d['now']) / 60)} min"
            n = len(wrong)
            # Not started: the bus ETS put on it is still on an earlier trip (3705/055 at Meadows TC, 2026-10-26).
            v = gps.get(x["trip"]) or bus_at.get(assigned.get(x["trip"]) or None)
            m = v and d["now"] - v.timestamp < 120 and math.hypot(v.position.latitude - d["stop"]["lat"], (
                v.position.longitude - d["stop"]["lon"]) * math.cos(math.radians(d["stop"]["lat"]))) * 111000
            # ETS's time and its own delay can disagree: a 560 at Kingsway kept its timetable start, 19 min gone, while
            # 40 min late (2026-10-26). Then anything between them is ETS's word. Later than both is right when the bus's
            # GPS can't get here sooner: 2890/008, ETS said 11 min ago with no delay (2026-10-24; inferred: no GPS was logged).
            said = [t for t in (theirs, expect) if t]
            # Not started, its bus away from its first stop: it drives there first, then the route, further than the
            # straight line here (3053 on 004, 16 km from Lewis Farms: site 60 min, ETS's delay 42, 2026-10-27).
            # ponytail: no stop positions here to add that path up, so it's logged as HELD, not judged; with the
            # trip's stops (data/gtfs.db) it could be checked like the straight line.
            start = m and v.current_stop_sequence == 1 and mine > max(said)  # 0: ETS sent none
            if not min(said) - OFF <= mine <= max(said) + OFF and not start and not (
                    m and mine > max(said) and abs(mine - (v.timestamp + m / 8)) <= OFF):
                says = f"ETS says {round((theirs - d['now']) / 60)} min, " if theirs else ""
                wrong.append(f"WRONG {bus}, {says}timetable plus its delay says {round((expect - d['now']) / 60)} min")
            elif mine > max(said) + OFF:  # taken on the GPS alone: logged, not paged, so a wrong bus on the trip shows
                wrong.append(f"HELD {bus}, ETS says {round((max(said) - d['now']) / 60)} min, its bus {v.vehicle.id} on trip "
                             f"{v.trip.trip_id} is {m / 1000:.1f} km away")  # 3705/055 was never checked (2026-10-27)
            elif mine - d["now"] <= 60 and not x.get("at") and m and m > FAR:
                wrong.append(f"WRONG {bus}, its GPS is {m / 1000:.1f} km away")
            if len(wrong) > n:
                if not wrong[-1].startswith("HELD"):
                    keys.append(f"wrong {stop} {x['route']}")
                wrong[-1] += "".join(f"\n      ETS {r}" for r in raw[x["trip"]])
    return wrong, keys, checked


if __name__ == "__main__":
    sys.exit(main())

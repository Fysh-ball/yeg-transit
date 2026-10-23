"""Do the live times people see match ETS's own feed? Exits 1 and says which bus when they don't.

Run after every release and every 15 min (docs/SETUP.md). Asks the public site, so it checks what a phone gets.
    .venv/bin/python scripts/check_live.py [https://yegbus.com]

Two ways a time goes wrong, both seen on the 918B loop at WEM on 2026-10-22:
- far off ETS's own time for that bus at that stop (we showed 33 min, ETS said 8);
- far off the timetable plus the bus's current delay (a bus that had left, shown again for its loop's return).
And one ETS agrees with, so only GPS shows it: Due with the bus far away (a 902 at University TC, 1.8 km off
along its route with ETS still holding it at its first stop, 2026-10-23).
The server may push a time later than ETS when the bus can't drive there that fast, so only big gaps count.
"""
import json, math, sys, time, urllib.request

from google.transit import gtfs_realtime_pb2

RT_URL = "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/TripUpdate/TripUpdates.pb"
VP_URL = "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb"
SITE = (sys.argv[1] if len(sys.argv) > 1 else "https://yegbus.com").rstrip("/")
STOPS = 25  # per run: every /api call is a Cloudflare Pages Function request, 100k a day on the free plan
OFF = 15 * 60  # seconds apart before a time counts as wrong
FAR = 1500  # metres, straight line: a bus shown 1 min or less away can't be further (8 m/s for 3 min, for stale GPS)


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "yeg-transit-check/1"}), timeout=20).read()


def main():
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(get(RT_URL))
    ets, delay, firsts = {}, {}, {}  # (trip, stop) -> first-pass time; trip -> delay now; stop -> trips starting there
    for e in feed.entity:
        tu = e.trip_update
        for i, s in enumerate(tu.stop_time_update):
            ev = s.departure if s.HasField("departure") else s.arrival
            if ev.time:
                ets.setdefault((tu.trip.trip_id, s.stop_id), ev.time)
            delay.setdefault(tu.trip.trip_id, ev.delay)
            if i == 0 and s.stop_sequence == 1:
                firsts.setdefault(s.stop_id, set()).add(tu.trip.trip_id)
    vp = gtfs_realtime_pb2.FeedMessage()
    vp.ParseFromString(get(VP_URL))
    gps = {e.vehicle.trip.trip_id: e.vehicle for e in vp.entity if e.vehicle.trip.trip_id}
    # Where routes start (transit centres, where loops begin and end) first, then the stops most trips pass.
    seen = {}
    for trip, stop in ets:
        seen[stop] = seen.get(stop, 0) + 1
    stops = sorted(seen, key=lambda s: (-len(firsts.get(s, ())), -seen[s]))[:STOPS]
    wrong, checked = [], 0
    for stop in stops:
        try:
            d = json.loads(get(f"{SITE}/api/stops/{stop}/departures?n=30"))
        except Exception as e:
            wrong.append(f"stop {stop}: no answer from {SITE} ({e})")
            continue
        for x in d["departures"]:
            if not x.get("live") or x["trip"] not in delay:
                continue
            checked += 1
            mine, theirs = x["time"], ets.get((x["trip"], stop))
            expect = x["sched"] + delay[x["trip"]]
            bus = f"stop {stop} route {x['route']} trip {x['trip']}: shows {round((mine - d['now']) / 60)} min"
            if theirs and abs(mine - theirs) > OFF:
                wrong.append(f"{bus}, ETS says {round((theirs - d['now']) / 60)} min")
            elif abs(mine - expect) > OFF:
                wrong.append(f"{bus}, timetable plus its delay says {round((expect - d['now']) / 60)} min")
            elif mine - d["now"] <= 60 and not x.get("at") and (v := gps.get(x["trip"])) and d["now"] - v.timestamp < 120:
                m = math.hypot(v.position.latitude - d["stop"]["lat"],
                               (v.position.longitude - d["stop"]["lon"]) * math.cos(math.radians(d["stop"]["lat"]))) * 111000
                if m > FAR:
                    wrong.append(f"{bus}, its GPS is {m / 1000:.1f} km away")
    print(f"{SITE}: {checked} live buses at {len(stops)} stops, {len(wrong)} wrong ({time.strftime('%H:%M')})")
    for w in wrong:
        print("WRONG", w)
    if not checked:
        print("WRONG nothing to check: no live buses came back")  # a check that saw nothing must not pass
    return 1 if wrong or not checked else 0


if __name__ == "__main__":
    sys.exit(main())

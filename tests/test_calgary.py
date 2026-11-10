"""Calgary's schedule (weekly ranges in calendar.txt plus calendar_dates exceptions, as in its real GTFS 2026-11-10) and its
own stop ids and routes. A tiny feed stands in for the 10 MB one."""
import io, json, os, sqlite3, tempfile, time, unittest, zipfile
from datetime import datetime
from unittest import mock

from test_next_stop import app

FILES = {
    "stops.txt": "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,stop_url,location_type\n"
                 "6451,6451,Crescent Heights High School,,  51.060931,-114.065158,,,0\n"
                 "112,112,Downtown West Kerby Station,,51.0447,-114.0850,,,0\n",
    "routes.txt": "route_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color\n"
                  "1-20800,1,Bowness/Forest Lawn,,3,,,\n",
    "trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id,block_id,shape_id\n1-20800,WK,t1,FOREST LAWN,0,b1,\n",
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n"
                      "t1,08:00:00,08:00:00,6451,1,0,0\nt1,08:10:00,08:10:00,112,2,0,0\n",
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                    "WK,1,1,1,1,1,0,0,20261109,20261120\n",
    "calendar_dates.txt": "service_id,date,exception_type\nWK,20261111,2\nWK,20261121,1\n",
}


def build(path):
    with zipfile.ZipFile(path, "w") as z:
        for n, t in FILES.items():
            z.writestr(n, t)


class Calgary(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        self.addCleanup(__import__("shutil").rmtree, d)
        zp, self.db_path = os.path.join(d, "z.zip"), os.path.join(d, "c.db")
        build(zp)
        app.import_gtfs(zp, self.db_path)
        self.db = sqlite3.connect(self.db_path)

    def test_weekly_ranges_expand_and_exceptions_apply(self):
        days = {r[0] for r in self.db.execute("SELECT date FROM service_dates WHERE service_id='WK'")}
        self.assertIn("20261109", days)          # a Monday in range
        self.assertNotIn("20261114", days)       # Saturday: not a weekday
        self.assertNotIn("20261111", days)       # exception type 2 removes the day (Remembrance Day)
        self.assertIn("20261121", days)          # exception type 1 adds a Saturday
        self.assertEqual(len(days), 10 - 1 + 1)  # 2 weeks of weekdays, minus one, plus one

    def test_stop_ids_carry_the_city_and_times_are_scheduled(self):
        now = int(datetime(2026, 11, 10, 7, 30, tzinfo=app.TZ).timestamp())
        with mock.patch.object(app.time, "time", lambda: now):
            deps, cache = app.cgy_route(self.db, ["stops", "cgy:6451", "departures"], {})
        self.assertEqual(deps["stop"]["id"], "cgy:6451")
        self.assertEqual([(d["route"], d["headsign"], d["live"]) for d in deps["departures"]], [("1", "FOREST LAWN", False)])
        self.assertEqual(deps["departures"][0]["time"], now + 1800)

    def test_search_and_near_and_unknown_stop(self):
        found, _ = app.cgy_route(self.db, ["stops", "search"], {"q": "crescent heights"})
        self.assertEqual([s["id"] for s in found], ["cgy:6451"])
        near, _ = app.cgy_route(self.db, ["stops", "near"], {"lat": "51.0447", "lon": "-114.0850"})
        self.assertEqual(near[0]["id"], "cgy:112")
        self.assertEqual(app.cgy_route(self.db, ["stops", "cgy:9", "departures"], {})[0], {"error": "no such stop"})

    def test_holiday_has_no_bus(self):
        now = int(datetime(2026, 11, 11, 7, 30, tzinfo=app.TZ).timestamp())
        with mock.patch.object(app.time, "time", lambda: now):
            deps, _ = app.cgy_route(self.db, ["stops", "cgy:6451", "departures"], {})
        self.assertEqual(deps["departures"], [])


def feed(trip, stop, when, ts, skip=False):
    from google.transit import gtfs_realtime_pb2 as g
    f = g.FeedMessage(); f.header.gtfs_realtime_version = "2.0"; f.header.timestamp = ts
    e = f.entity.add(); e.id = "1"; e.trip_update.trip.trip_id = trip
    u = e.trip_update.stop_time_update.add(); u.stop_id = stop; u.departure.time = when
    if skip:
        u.schedule_relationship = u.SKIPPED
    return f.SerializeToString()


class CalgaryLive(unittest.TestCase):
    """Realtime: one shared poll, asked only on demand, cached 30 s, backed off on errors, never shown stale."""
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        zp, self.db_path = os.path.join(tmp.name, "z.zip"), os.path.join(tmp.name, "c.db")
        build(zp); app.import_gtfs(zp, self.db_path)
        self.db = sqlite3.connect(self.db_path)
        self.now = int(datetime(2026, 11, 10, 7, 55, tzinfo=app.TZ).timestamp())  # a Tuesday; t1 leaves 6451 at 08:00
        self.live, self.host = app.CgyLive(), app.Host("test", 25, 3000)
        for patch in (mock.patch.object(app, "CGYLIVE", self.live), mock.patch.object(app, "CALGARY_RT", self.host),
                      mock.patch.object(app.time, "time", lambda: self.now)):
            patch.start(); self.addCleanup(patch.stop)

    def ask(self):
        return app.cgy_route(self.db, ["stops", "cgy:6451", "departures"], {})[0]

    def test_a_prediction_replaces_the_timetable_and_is_live(self):
        sched = self.now + 300
        with mock.patch.object(app, "fetch", lambda u, t: io.BytesIO(feed("t1", "6451", sched + 240, self.now - 10))):
            d = self.ask()
        self.assertEqual([(x["time"], x["live"]) for x in d["departures"]], [(sched + 240, True)])
        self.assertEqual(d["live_age"], 10)

    def test_a_skipped_stop_is_dropped(self):
        with mock.patch.object(app, "fetch", lambda u, t: io.BytesIO(feed("t1", "6451", 0, self.now, skip=True))):
            self.assertEqual(self.ask()["departures"], [])

    def test_riders_share_one_poll_for_30_s(self):
        asked = []
        def fetch(u, t):
            asked.append(u); return io.BytesIO(feed("t1", "6451", self.now + 400, self.now))
        with mock.patch.object(app, "fetch", fetch):
            for _ in range(5):
                self.ask()
            self.assertEqual(len(asked), 1)
            self.now += 31; self.ask()
        self.assertEqual(len(asked), 2)

    def test_a_429_backs_off_and_the_old_copy_ages_out_to_scheduled(self):
        from test_outside_hosts import http_error
        asked = []
        def fetch(u, t):
            asked.append(self.now)
            if len(asked) == 1:
                return io.BytesIO(feed("t1", "6451", self.now + 400, self.now))
            raise http_error(429, 600)
        with mock.patch.object(app, "fetch", fetch):
            self.ask()
            self.now += 31; d = self.ask()  # the 429: the 31 s old copy is still shown as live
            self.assertTrue(d["departures"][0]["live"])
            for _ in range(8):  # riders keep asking for 4 min; Retry-After 600 keeps the host unasked
                self.now += 31; d = self.ask()
        self.assertEqual(len(asked), 2)
        self.assertFalse(d["departures"][0]["live"])  # copy older than 120 s: scheduled again, never a stale "live"
        self.assertIsNone(d["live_age"])


class CitiesRoute(unittest.TestCase):
    """The switch that keeps Edmonton riders unchanged, through the real HTTP Handler."""
    def get(self, path):
        import http.client, threading
        srv = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close); self.addCleanup(srv.shutdown)
        c = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=10)
        c.request("GET", path); r = c.getresponse()
        return r.status, json.loads(r.read())

    def test_edmonton_only_unless_calgary_is_enabled_and_imported(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        edm, cgy = os.path.join(tmp.name, "e.db"), os.path.join(tmp.name, "c.db")
        sqlite3.connect(edm).close()
        with mock.patch.object(app, "DB", edm), mock.patch.object(app, "CGY_DB", cgy):
            with mock.patch.object(app, "CITIES", {"cgy"}):
                self.assertEqual(self.get("/api/cities"), (200, {"cities": ["yeg"]}))  # enabled, nothing imported yet
                self.assertEqual(self.get("/api/stops/search?q=x&city=cgy")[0], 404)
                sqlite3.connect(cgy).close()
                self.assertEqual(self.get("/api/cities"), (200, {"cities": ["yeg", "cgy"]}))
            with mock.patch.object(app, "CITIES", set()):
                self.assertEqual(self.get("/api/cities"), (200, {"cities": ["yeg"]}))  # the default: no change for riders
                self.assertEqual(self.get("/api/stops/cgy:6451/departures")[0], 404)


if __name__ == "__main__":
    unittest.main()

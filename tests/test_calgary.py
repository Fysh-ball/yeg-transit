"""Calgary's schedule (weekly ranges in calendar.txt plus calendar_dates exceptions, as in its real GTFS 2026-11-10) and its
own stop ids and routes. A tiny feed stands in for the 10 MB one."""
import io, os, sqlite3, tempfile, time, unittest, zipfile
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


if __name__ == "__main__":
    unittest.main()

"""Transfer warning: route X from A, off at B, walk ~50 m to C for route Y. Run: .venv/bin/python -m unittest discover -s tests"""
import os, sqlite3, sys, unittest
from datetime import datetime
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
import app  # noqa: E402

NOON = int(datetime.now(app.TZ).replace(hour=12, minute=0, second=0, microsecond=0).timestamp())
BASE = NOON - 43200  # service-day base: GTFS times count from local noon minus 12 h


def hm(h, m):  # 12:25 -> GTFS seconds into the service day
    return h * 3600 + m * 60


def fixture():
    db = sqlite3.connect(":memory:")
    db.executescript("""
      CREATE TABLE stops(stop_id TEXT PRIMARY KEY, code TEXT, name TEXT, lat REAL, lon REAL);
      CREATE TABLE routes(route_id TEXT PRIMARY KEY, short TEXT, long TEXT, color TEXT, text_color TEXT);
      CREATE TABLE trips(trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, headsign TEXT, shape_id TEXT);
      CREATE TABLE stop_times(trip_id TEXT, stop_id TEXT, dep INTEGER, headsign TEXT, seq INTEGER);
      CREATE TABLE service_dates(service_id TEXT, date TEXT);
      CREATE TABLE stop_routes(stop_id TEXT, routes TEXT);""")
    db.executemany("INSERT INTO stops VALUES(?,?,?,?,?)", [
        ("A", "A", "Start", 53.49, -113.5), ("B", "B", "Off", 53.5, -113.5), ("C", "C", "Change", 53.50045, -113.5)])
    db.executemany("INSERT INTO routes VALUES(?,?,?,?,?)", [("rx", "X", "", "", ""), ("ry", "Y", "", "", "")])
    db.executemany("INSERT INTO trips VALUES(?,?,?,?,?)", [
        ("t1", "rx", "s", "X North", ""), ("t2", "ry", "s", "Y East", ""), ("t3", "ry", "s", "Y East", "")])
    db.executemany("INSERT INTO stop_times VALUES(?,?,?,?,?)", [
        ("t1", "A", hm(12, 10), "", 1), ("t1", "B", hm(12, 20), "", 2),
        ("t2", "C", hm(12, 25), "", 1), ("t3", "C", hm(12, 45), "", 1)])
    db.execute("INSERT INTO service_dates VALUES('s', ?)", (datetime.fromtimestamp(NOON, app.TZ).strftime("%Y%m%d"),))
    db.executemany("INSERT INTO stop_routes VALUES(?,?)", [("A", "X"), ("B", "X"), ("C", "Y")])
    return db


class Transfer(unittest.TestCase):
    def setUp(self):
        self.db = fixture()
        self.addCleanup(self.db.close)
        p = mock.patch.object(app.time, "time", return_value=NOON)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(setattr, app.LIVE, "trips", app.LIVE.trips)

    def first(self, live):
        app.LIVE.trips = live
        return app.transfer(self.db, "A", "X", "B", "C", "Y", 50)["trips"][0]

    def test_connections_finds_the_bay_across_the_street(self):
        c = app.connections(self.db, "A", "X")
        self.assertEqual([(x["route"], x["off"], x["at"]) for x in c], [("Y", "B", "C")])
        self.assertTrue(45 <= c[0]["walk_m"] <= 55, c[0]["walk_m"])

    def test_on_schedule_is_on_track(self):
        t = self.first({})
        self.assertEqual((t["status"], t["plan"]["time"]), ("on_track", BASE + hm(12, 25)))

    def test_three_min_late_is_tight(self):
        t = self.first({"t1": ({"B": BASE + hm(12, 23)}, 180)})
        self.assertEqual(t["status"], "tight")

    def test_five_min_late_is_missed_with_the_next_one(self):
        t = self.first({"t1": ({"B": BASE + hm(12, 25)}, 300)})
        self.assertEqual((t["status"], t["next"]["time"]), ("missed", BASE + hm(12, 45)))

    def test_late_at_the_start_carries_to_the_change(self):
        t = self.first({"t1": ({"A": BASE + hm(12, 15)}, 300)})  # no prediction for B yet
        self.assertEqual((t["arrive"], t["status"]), (BASE + hm(12, 25), "missed"))


if __name__ == "__main__":
    unittest.main()

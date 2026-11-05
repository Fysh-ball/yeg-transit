"""A tapped bus on the map: how full, how late, its next stop and fleet number. Stops from test_next_stop (a real 201)."""
import time, unittest
from unittest import mock

from test_next_stop import app, fixture


def info(more, delay=150, stop_delay=None):
    now, db = int(time.time()), fixture()
    db.executescript("CREATE TABLE routes(route_id TEXT, short TEXT); CREATE TABLE trips(trip_id TEXT, route_id TEXT, headsign TEXT, block_id TEXT);"
                     "INSERT INTO routes VALUES('r','201'); INSERT INTO trips VALUES('t','r','Kingsway','b9');")
    with mock.patch.object(app.LIVE, "vehicles", {"t": (53.552639, -113.508339, 0, now - 10, 13, "r", 0)}), \
            mock.patch.object(app.LIVE, "vp_more", {"t": more}), mock.patch.object(app.LIVE, "ts", now - 10), \
            mock.patch.object(app.LIVE, "trips", {"t": ({}, delay, {})}), mock.patch.object(app.LIVE, "stop_delay", stop_delay or {}):
        return app.bus_info(db, "t")


class BusInfo(unittest.TestCase):
    def test_what_a_rider_sees(self):
        b = info({"id": "4384", "label": "4384", "speed": 10.0, "occupancy": 1, "stop_id": "1904"})
        self.assertEqual((b["route"], b["full"], b["bus"], b["next"]["code"], b["delay"]), ("201", "Lots of seats", "4384", "1797", 150))
        self.assertEqual(b["nerd"]["Speed"], "36 km/h")
        self.assertEqual(b["nerd"]["Block"], "b9")

    def test_the_next_stops_own_delay_wins(self):
        self.assertEqual(info({}, stop_delay={("t", "1797"): 30})["delay"], 30)

    def test_no_data_says_nothing(self):  # ETS's 7 is "no data": no line, not a wrong one
        b = info({"occupancy": 7})
        self.assertNotIn("full", b)
        self.assertNotIn("Speed", b["nerd"])

    def test_gone_bus(self):
        with mock.patch.object(app.LIVE, "vehicles", {}):
            self.assertIsNone(app.bus_info(fixture(), "t"))

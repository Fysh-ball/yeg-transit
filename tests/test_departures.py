"""Where the bus is beats a stale ETS prediction. Stops from test_next_stop (a real 201); the stop is 1797, seq 11."""
import time, unittest
from unittest import mock

from test_next_stop import app, fixture

AT_1797 = (53.561262, -113.5091)
KM_SOUTH = (53.552252, -113.5091)  # 1 km south, between stops 10 and 11


def run(pos, eta=0, route="201"):
    now = int(time.time())
    sched = [{"trip": "t", "sched": now + eta, "route": route}]
    vehicles = {"t": (*pos, 0, now - 10, 13, "r", 0)}
    with mock.patch.object(app, "scheduled", lambda *a: [dict(d) for d in sched]), \
            mock.patch.object(app.LIVE, "trips", {"t": ({"1797": now + eta}, 0)}), mock.patch.object(app.LIVE, "vehicles", vehicles):
        out = app.departures(fixture(), "1797", 8)
    return out and {"in": out[0]["time"] - now, "at": out[0].get("at", False)}


class Departures(unittest.TestCase):
    def test_far_bus_is_not_due(self):  # ETS says now; 1 km at 8 m/s is about 2 min
        self.assertTrue(110 <= run(KM_SOUTH)["in"] <= 125)

    def test_bus_at_the_stop_stays_after_its_time(self):
        self.assertEqual(run(AT_1797, eta=-90), {"in": -90, "at": True})

    def test_bus_past_the_stop_is_gone(self):
        self.assertFalse(run((53.565882, -113.520017)))  # at stop 12

    def test_a_bus_ahead_of_its_prediction_keeps_it(self):
        self.assertEqual(run(KM_SOUTH, eta=600), {"in": 600, "at": False})

    def test_trains_keep_ets_times(self):
        self.assertEqual(run(KM_SOUTH, route="Capital")["in"], 0)

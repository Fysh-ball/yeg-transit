"""Where the bus is beats a stale ETS prediction. Stops from test_next_stop (a real 201); the stop is 1797, seq 11."""
import io, time, unittest
from unittest import mock

from test_next_stop import app, fixture

AT_1797 = (53.561262, -113.5091)
KM_SOUTH = (53.552252, -113.5091)  # 1 km south, between stops 10 and 11


def run(pos, eta=0, route="201", ets_seq=11):
    now = int(time.time())
    sched = [{"trip": "t", "seq": 11, "sched": now + eta, "route": route}]
    vehicles = {"t": (*pos, 0, now - 10, 13, "r", 0)} if pos else {}
    with mock.patch.object(app, "scheduled", lambda *a: [dict(d) for d in sched]), \
            mock.patch.object(app.LIVE, "trips", {"t": ({"1797": now + eta}, 0, {"1797": ets_seq})}), mock.patch.object(app.LIVE, "vehicles", vehicles):
        out = app.departures(fixture(), "1797", 8)
    return out and {"in": out[0]["time"] - now, "at": out[0].get("at", False)}


class Departures(unittest.TestCase):
    def test_far_bus_is_not_due(self):  # ETS says now; 1 km at 8 m/s is about 2 min
        self.assertTrue(110 <= run(KM_SOUTH)["in"] <= 125)

    def test_bus_at_the_stop_stays_after_its_time(self):
        self.assertEqual(run(AT_1797, eta=-90), {"in": -90, "at": True})

    def test_bus_past_the_stop_is_gone(self):
        self.assertFalse(run((53.565882, -113.520017)))  # at stop 12

    def test_bus_past_the_stop_is_gone_whatever_ets_says(self):  # a loop's return to its first stop, 22 min out
        self.assertFalse(run((53.565882, -113.520017), eta=1320))

    def test_only_a_later_pass_left_means_this_one_has_gone(self):  # 918A at WEM, its GPS already on the next trip
        self.assertFalse(run(None, eta=60, ets_seq=31))
        self.assertEqual(run(None, eta=60), {"in": 60, "at": False})

    def test_a_bus_ahead_of_its_prediction_keeps_it(self):
        self.assertEqual(run(KM_SOUTH, eta=600), {"in": 600, "at": False})

    def test_trains_keep_ets_times(self):
        self.assertEqual(run(KM_SOUTH, route="Capital")["in"], 0)


class LoopTrip(unittest.TestCase):
    def test_a_loop_keeps_its_departure_not_its_return(self):  # 918B leaves WEM, then ends back at WEM
        from google.transit import gtfs_realtime_pb2 as g
        now, feed = int(time.time()), g.FeedMessage()
        feed.header.gtfs_realtime_version, feed.header.timestamp = "2.0", now
        tu = feed.entity.add(id="t").trip_update
        tu.trip.trip_id = "t"
        first = tu.stop_time_update.add(stop_sequence=1, stop_id="5212")
        first.departure.time = now + 480
        last = tu.stop_time_update.add(stop_sequence=34, stop_id="5212")
        last.arrival.time = now + 1980
        live = app.Live()
        with mock.patch.object(app, "fetch", lambda *a: io.BytesIO(feed.SerializeToString())), \
                mock.patch("sys.stderr", io.StringIO()):
            live.poll()
        self.assertEqual(live.trips["t"][0]["5212"], now + 480)

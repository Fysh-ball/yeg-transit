"""check_live pages a wrong time once per stop and route per 6 h, and a site that doesn't answer as unreachable."""
import io, json, os, sys, tempfile, time, unittest, urllib.error
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
try:
    import check_live
except ModuleNotFoundError as e:  # the server image's test gate has no scripts/: check_live runs on the laptop
    raise unittest.SkipTest(f"scripts/check_live.py not here ({e})")
from google.transit import gtfs_realtime_pb2

NOW = 1_800_000_000


def empty():
    f = gtfs_realtime_pb2.FeedMessage()
    f.header.gtfs_realtime_version = "2.0"
    return f


def ets_feed(at=45, delay=2, bus=""):  # ETS's time at stop 1407 and its delay there, in minutes; the timetable says 43
    f = empty()
    tu = f.entity.add(id="1").trip_update
    tu.trip.trip_id, tu.vehicle.id = "T1", bus
    s = tu.stop_time_update.add(stop_sequence=5, stop_id="1407")
    s.departure.time, s.departure.delay = NOW + at * 60, delay * 60
    return f.SerializeToString()


def gps(metres_north, trip="T1", bus="3135"):  # a bus on `trip`, a fresh fix due north of the stop
    f = empty()
    v = f.entity.add(id="1").vehicle
    v.trip.trip_id, v.vehicle.id, v.timestamp = trip, bus, NOW
    v.position.latitude, v.position.longitude = 53.5 + metres_north / 111000, -113.5
    return f.SerializeToString()


def site(shows, live_age=10):  # the site's answer for stop 1407: route 002 at `shows` minutes, timetable says 43
    return json.dumps({"now": NOW, "live_age": live_age, "stop": {"lat": 53.5, "lon": -113.5}, "departures": [
        {"trip": "T1", "route": "002", "live": True, "time": NOW + shows * 60, "sched": NOW + 43 * 60}]}).encode()


class CheckLive(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        for p in (mock.patch.object(check_live, "STATE", os.path.join(d.name, "paged.json")),
                  mock.patch.object(check_live, "HELD_AT", os.path.join(d.name, "held.json")),
                  mock.patch.object(check_live.time, "sleep", lambda s: None)):
            p.start()
            self.addCleanup(p.stop)

    def run_check(self, answers, *argv):
        """answers: url -> list of bytes or exceptions, one per fetch."""
        def urlopen(req, timeout):
            a = answers[req.full_url.split("?")[0]].pop(0)
            if isinstance(a, Exception):
                raise a
            return io.BytesIO(a)
        out = io.StringIO()
        with mock.patch.object(check_live.urllib.request, "urlopen", urlopen), redirect_stdout(out):
            return check_live.main(list(argv)), out.getvalue()

    def answers(self, *site_answers, ets=None, vp=None):
        return {check_live.RT_URL: [ets or ets_feed()], check_live.VP_URL: [vp or empty().SerializeToString()],
                "https://yegbus.com/api/stops/1407/departures": list(site_answers)}

    def test_a_right_time_passes(self):
        self.assertEqual(self.run_check(self.answers(site(45)))[0], 0)

    def test_a_wrong_time_fails(self):  # 1407/002 on 2026-10-24: showed 12 min, ETS said 45
        code, out = self.run_check(self.answers(site(12)))
        self.assertEqual(code, 1)
        self.assertIn("WRONG stop 1407 route 002", out)

    def test_a_wrong_time_pages_once_per_6h_and_always_fails_without_page(self):
        self.assertEqual(self.run_check(self.answers(site(12)), "--page")[0], 1)
        code, out = self.run_check(self.answers(site(12)), "--page")
        self.assertEqual(code, 0)
        self.assertIn("WRONG stop 1407 route 002", out)  # still in the journal
        self.assertEqual(self.run_check(self.answers(site(12)))[0], 1)  # a release check is never quiet
        later = time.time() + 6 * 3600 + 1
        with mock.patch.object(check_live.time, "time", lambda: later):
            self.assertEqual(self.run_check(self.answers(site(12)), "--page")[0], 1)

    def test_ets_disagreeing_with_itself_allows_either(self):  # 560 at Kingsway: timetable start gone, 40 min late
        ets = ets_feed(at=43, delay=40)
        self.assertEqual(self.run_check(self.answers(site(83), ets=ets))[0], 0)
        self.assertEqual(self.run_check(self.answers(site(60), ets=ets))[0], 0)
        self.assertEqual(self.run_check(self.answers(site(110), ets=ets))[0], 1)

    def test_later_than_ets_is_right_only_where_the_gps_says(self):  # 2890/008: ETS said 11 min ago, the bus 4.3 km off
        ets = ets_feed(at=-11, delay=-54)
        self.assertEqual(self.run_check(self.answers(site(9), ets=ets, vp=gps(4300)))[0], 0)
        self.assertEqual(self.run_check(self.answers(site(30), ets=ets, vp=gps(4300)))[0], 1)
        self.assertEqual(self.run_check(self.answers(site(20), ets=ets, vp=gps(300)))[0], 1)  # 300 m off: due in 1 min, not 20

    def test_a_trip_not_started_waits_for_its_bus(self):  # 3705/055: ETS due now, its bus 9.6 km off on an earlier trip
        ets = ets_feed(at=0, delay=-43, bus="3135")
        code, out = self.run_check(self.answers(site(20), ets=ets, vp=gps(9600, trip="T0")), "--page")
        self.assertEqual(code, 0)  # not paged, but logged with where its bus is, in case ETS put the wrong bus on it
        self.assertIn("HELD stop 1407 route 002 trip T1: shows 20 min, ETS says 0 min, its bus 3135 on trip T0 is 9.6 km", out)
        self.assertIn("0 wrong", out)
        self.assertIn("ETS veh 3135", out)
        self.assertEqual(self.run_check(self.answers(site(20), ets=ets, vp=gps(9600, trip="T0", bus="9999")))[0], 1)

    def test_a_held_bus_gone_long_before_its_time_pages(self):  # ETS had the wrong bus on it: riders told 20 min
        ets = ets_feed(at=0, delay=-43, bus="3135")
        vp = gps(9600, trip="T0")
        self.assertEqual(self.run_check(self.answers(site(20), ets=ets, vp=vp))[0], 0)
        gone = json.dumps({"now": NOW, "live_age": 10, "stop": {"lat": 53.5, "lon": -113.5}, "departures": []}).encode()
        # (an empty board also fails as "nothing to check"; the HELD line is what's tested here)
        self.assertIn("WRONG stop 1407 trip T1: gone 20 min before the time we showed", self.run_check(self.answers(gone, ets=ets, vp=vp))[1])
        self.assertNotIn("gone", self.run_check(self.answers(gone, ets=ets, vp=vp))[1])  # checked once, then forgotten

    def test_a_held_bus_gone_near_its_time_is_right(self):
        ets = ets_feed(at=0, delay=-43, bus="3135")
        self.assertEqual(self.run_check(self.answers(site(20), ets=ets, vp=gps(9600, trip="T0")))[0], 0)
        gone = json.dumps({"now": NOW + 15 * 60, "live_age": 10, "stop": {"lat": 53.5, "lon": -113.5}, "departures": []})
        self.assertNotIn("gone", self.run_check(self.answers(gone.encode(), ets=ets, vp=gps(9600, trip="T0")))[1])

    def test_a_bus_yet_to_start_is_held_not_wrong(self):  # 3053/004: at seq 1 per GPS, 16 km from its first stop
        ets = ets_feed(at=-29, delay=-1, bus="3135")  # timetable plus delay: 42 min
        vp = gtfs_realtime_pb2.FeedMessage.FromString(gps(6800))
        vp.entity[0].vehicle.current_stop_sequence = 1
        code, out = self.run_check(self.answers(site(60), ets=ets, vp=vp.SerializeToString()), "--page")
        self.assertEqual(code, 0)
        self.assertIn("HELD", out)
        vp.entity[0].vehicle.current_stop_sequence = 20  # under way: the straight line holds, 60 min is wrong
        self.assertEqual(self.run_check(self.answers(site(60), ets=ets, vp=vp.SerializeToString()))[0], 1)

    def test_the_edges_old_copy_is_unreachable_not_wrong(self):  # 5212/906 shown at -3 min, both origins down
        code, out = self.run_check(self.answers(site(-3, live_age=400)), "--page")
        self.assertEqual(code, 3)
        self.assertIn("only the edge's copy", out)
        self.assertNotIn("WRONG", out)

    def test_a_timeout_is_retried_once(self):
        self.assertEqual(self.run_check(self.answers(TimeoutError("The read operation timed out"), site(45)))[0], 0)

    def test_a_timeout_twice_is_unreachable_not_wrong(self):  # 2026-10-26 11:16, a laptop switching networks
        code, out = self.run_check(self.answers(TimeoutError("timed out"), urllib.error.URLError("no route")), "--page")
        self.assertEqual(code, 3)
        self.assertIn("UNREACHABLE", out)
        self.assertNotIn("WRONG", out)
        self.assertNotIn("<", out)  # the popup reads markup: "<urlopen error" made it fail to show (00:30)

    def test_ets_down_is_unreachable(self):
        a = self.answers()
        a[check_live.RT_URL] = [OSError("reset"), OSError("reset")]
        self.assertEqual(self.run_check(a)[0], 3)


if __name__ == "__main__":
    unittest.main()

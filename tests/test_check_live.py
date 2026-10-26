"""check_live pages a wrong time once per stop and route per 6 h, and a site that doesn't answer as unreachable."""
import io, json, os, sys, tempfile, time, unittest, urllib.error
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import check_live
from google.transit import gtfs_realtime_pb2

NOW = 1_800_000_000


def empty():
    f = gtfs_realtime_pb2.FeedMessage()
    f.header.gtfs_realtime_version = "2.0"
    return f


def ets_feed():
    f = empty()
    tu = f.entity.add(id="1").trip_update
    tu.trip.trip_id = "T1"
    s = tu.stop_time_update.add(stop_sequence=5, stop_id="1407")
    s.departure.time, s.departure.delay = NOW + 45 * 60, 120
    return f.SerializeToString()


def site(shows):  # the site's answer for stop 1407: route 002 at `shows` minutes, timetable says 43
    return json.dumps({"now": NOW, "stop": {"lat": 53.5, "lon": -113.5}, "departures": [
        {"trip": "T1", "route": "002", "live": True, "time": NOW + shows * 60, "sched": NOW + 43 * 60}]}).encode()


class CheckLive(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        for p in (mock.patch.object(check_live, "STATE", os.path.join(d.name, "paged.json")),
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

    def answers(self, *site_answers):
        return {check_live.RT_URL: [ets_feed()], check_live.VP_URL: [empty().SerializeToString()],
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

    def test_a_timeout_is_retried_once(self):
        self.assertEqual(self.run_check(self.answers(TimeoutError("The read operation timed out"), site(45)))[0], 0)

    def test_a_timeout_twice_is_unreachable_not_wrong(self):  # 2026-10-26 11:16, a laptop switching networks
        code, out = self.run_check(self.answers(TimeoutError("timed out"), urllib.error.URLError("no route")), "--page")
        self.assertEqual(code, 3)
        self.assertIn("UNREACHABLE", out)
        self.assertNotIn("WRONG", out)

    def test_ets_down_is_unreachable(self):
        a = self.answers()
        a[check_live.RT_URL] = [OSError("reset"), OSError("reset")]
        self.assertEqual(self.run_check(a)[0], 3)


if __name__ == "__main__":
    unittest.main()

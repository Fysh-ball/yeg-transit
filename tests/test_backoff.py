"""No hammering ETS: a failing feed backs off 10 s to 5 min, and a failing Alerts feed waits its 5 min too."""
import io, unittest
from unittest import mock

from test_next_stop import app


def down(*a):
    raise OSError("ETS down")


class Backoff(unittest.TestCase):
    def test_an_outage_backs_off_to_five_minutes_then_resets(self):
        live, asked, clock = app.Live(), [], [1000.0]
        def feed_of(url, *a):
            asked.append(url)
            raise OSError("ETS down")
        with mock.patch.object(app, "feed_of", feed_of), mock.patch.object(app.time, "time", lambda: clock[0]), \
                mock.patch("sys.stderr", io.StringIO()):
            for _ in range(60):  # 10 min of 10 s loops
                live.poll()
                clock[0] += 10
            self.assertEqual(live.wait["rt"], 300)
            self.assertLessEqual(asked.count(app.RT_URL), 8)  # 10, 20, 40, 80, 160, 300...: not 60
            live.done("rt", True)
            self.assertEqual(live.wait["rt"], 0)
            self.assertTrue(live.due("rt"))

    def test_failing_alerts_wait_five_minutes(self):
        live, clock = app.Live(), [1000.0]
        live.next_at = {"rt": 1e12, "vp": 1e12}  # only the alerts feed in play
        with mock.patch.object(Backoff, "calls", [], create=True), \
                mock.patch.object(app.time, "time", lambda: clock[0]), mock.patch("sys.stderr", io.StringIO()), \
                mock.patch.object(app.Live, "poll_alerts", staticmethod(lambda: Backoff.calls.append(1) or down())):
            for _ in range(30):  # 5 min of 10 s loops
                live.poll()
                clock[0] += 10
            self.assertEqual(len(Backoff.calls), 1)

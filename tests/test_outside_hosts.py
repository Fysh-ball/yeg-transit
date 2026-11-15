"""Outside hosts (data.edmonton.ca, Photon, Open-Meteo) are never hammered: a gap per call, a daily cap,
a cooldown that doubles after each error, and the host's own Retry-After when it is longer."""
import io, json, unittest, urllib.error
from email.message import Message
from unittest import mock

from test_next_stop import app


def http_error(code, retry_after=None):
    h = Message()
    if retry_after is not None:
        h["Retry-After"] = str(retry_after)
    return urllib.error.HTTPError("https://x", code, "no", h, io.BytesIO(b""))


class Hosts(unittest.TestCase):
    def setUp(self):
        self.clock, self.asked = [1000.0], []
        p = mock.patch.object(app.time, "time", lambda: self.clock[0])
        p.start(); self.addCleanup(p.stop)

    def run_with(self, host, answer):
        def fetch(url, timeout):
            self.asked.append(url)
            if isinstance(answer, Exception):
                raise answer
            return io.BytesIO(json.dumps(answer).encode())
        with mock.patch.object(app, "fetch", fetch):
            return host.get_json("https://x/q", 4)

    def test_an_outage_cools_down_and_doubles_then_resets(self):
        h = app.Host("x", 0.5, 1000)
        with mock.patch.object(app.random, "uniform", lambda a, b: 1.0):
            waits = []
            for _ in range(10):
                with self.assertRaises(OSError):
                    self.run_with(h, OSError("down"))
                waits.append(round(h.until - self.clock[0]))
                with self.assertRaises(app.Busy):  # asked again at once: refused here, never reaches the host
                    self.run_with(h, {"ok": 1})
                self.clock[0] = h.until
        self.assertEqual(waits, [2, 4, 8, 16, 32, 64, 128, 256, 300, 300])
        self.assertEqual(len(self.asked), 10)
        self.assertEqual(self.run_with(h, {"ok": 1}), {"ok": 1})
        self.assertEqual(h.wait, 0)

    def test_jitter_spreads_the_cooldown(self):
        h = app.Host("x", 0, 1000)
        with self.assertRaises(OSError):
            self.run_with(h, OSError("down"))
        self.assertTrue(1.6 <= h.until - self.clock[0] <= 2.4)

    def test_a_429_waits_its_retry_after(self):
        h = app.Host("x", 0, 1000)
        with self.assertRaises(urllib.error.HTTPError):
            self.run_with(h, http_error(429, 120))
        self.clock[0] += 100
        with self.assertRaises(app.Busy):
            self.run_with(h, {"ok": 1})
        self.clock[0] += 21
        self.assertEqual(self.run_with(h, {"ok": 1}), {"ok": 1})

    def test_one_call_per_gap(self):
        h = app.Host("x", 1, 1000)
        self.run_with(h, {"ok": 1})
        with self.assertRaises(app.Busy):
            self.run_with(h, {"ok": 1})
        self.clock[0] += 1
        self.run_with(h, {"ok": 1})
        self.assertEqual(len(self.asked), 2)

    def test_the_daily_cap_stops_and_says_so_once(self):
        h, err = app.Host("x", 0, 3), io.StringIO()
        with mock.patch("sys.stderr", err):
            for _ in range(3):
                self.run_with(h, {"ok": 1})
            for _ in range(5):
                with self.assertRaises(app.Busy):
                    self.run_with(h, {"ok": 1})
        self.assertEqual(len(self.asked), 3)
        self.assertEqual(err.getvalue().count("DAILY CAP"), 1)
        self.clock[0] += 86400  # a new day
        self.run_with(h, {"ok": 1})

    def test_city_addresses_are_cached(self):
        rows = [{"house_number": "10220", "street_name": "103 STREET NW", "lat": "53.54", "lon": "-113.5"}]
        app.ADDR_CACHE.clear()
        h = app.Host("x", 0.5, 1000)
        with mock.patch.object(app, "SOCRATA", h), mock.patch.object(app, "fetch", lambda u, t: (self.asked.append(u), io.BytesIO(json.dumps(rows).encode()))[1]):
            for _ in range(5):
                self.assertEqual(app.city_addresses("10220 103 st")[0]["name"], "10220 103 Street NW")
        self.assertEqual(len(self.asked), 1)


if __name__ == "__main__":
    unittest.main()


class ConditionalTimetable(unittest.TestCase):
    """A city's nightly timetable fetch asks "changed since?" (ETag / Last-Modified): a 304 keeps the last import, costs
    the host nothing, and is not an error (Metrobus asks for weekly downloads, 2026-11-15)."""
    def test_second_night_sends_validators_and_a_304_keeps_the_import(self):
        import os, tempfile
        from email.message import Message
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        asked, calls = [], []
        def fetch(url, timeout, headers=None):
            asked.append(headers or {})
            if len(asked) == 2:
                raise urllib.error.HTTPError(url, 304, "Not Modified", Message(), io.BytesIO(b""))
            r = io.BytesIO(b"zip"); r.headers = {"ETag": '"v1"', "Last-Modified": "Sat, 14 Nov 2026 00:00:00 GMT"}
            return r
        host = app.Host("test", 0, 100)
        with mock.patch.object(app, "DATA", tmp.name), mock.patch.object(app, "fetch", fetch), \
                mock.patch.object(app, "feed_host", lambda c: host), \
                mock.patch.object(app, "import_gtfs", lambda z, d: (calls.append(z), open(d, "w").close())):
            app.refresh_city("yyt")
            app.refresh_city("yyt")
        self.assertEqual(asked[0], {})
        self.assertEqual(asked[1], {"If-None-Match": '"v1"', "If-Modified-Since": "Sat, 14 Nov 2026 00:00:00 GMT"})
        self.assertEqual(len(calls), 1)  # the 304 imported nothing
        self.assertEqual(host.until, 0)  # and started no cooldown
        self.assertTrue(os.path.exists(os.path.join(tmp.name, "yyt.zip")))

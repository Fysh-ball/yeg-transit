import io, os, tempfile, unittest
from unittest import mock

from test_next_stop import app


class Refresh(unittest.TestCase):
    def test_a_bad_download_keeps_the_last_good_timetable(self):  # an error page served as 200, or a cut-off zip
        d = tempfile.mkdtemp()
        zpath, db = os.path.join(d, "GTFS.zip"), os.path.join(d, "gtfs.db")
        with open(zpath, "wb") as f:
            f.write(b"the last good zip")
        with mock.patch.object(app, "DATA", d), mock.patch.object(app, "DB", db), \
                mock.patch.object(app, "fetch", lambda *a: io.BytesIO(b"<html>Service Unavailable</html>")):
            with self.assertRaises(Exception):
                app.refresh_gtfs()
        with open(zpath, "rb") as f:
            self.assertEqual(f.read(), b"the last good zip")
        self.assertFalse(os.path.exists(db))

    def test_a_failed_first_import_backs_off_instead_of_exiting(self):
        calls, slept = [], []
        def load():
            calls.append(1)
            if len(calls) < 9:
                raise OSError("ETS down")
            return "ok"
        with mock.patch.object(app.random, "uniform", lambda a, b: 1):
            self.assertEqual(app.first_import(load, slept.append), "ok")
        self.assertEqual(slept, [60, 120, 240, 480, 960, 1920, 3600, 3600])


if __name__ == "__main__":
    unittest.main()

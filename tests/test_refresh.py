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


if __name__ == "__main__":
    unittest.main()

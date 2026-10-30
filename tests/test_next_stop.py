"""Next stop from the bus position, not ETS's next timepoint. Real 201 stops and a real position from 2026-10-22."""
import os, sqlite3, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
import app  # noqa: E402

STOPS = [(9, "11095", 53.544996, -113.508267), (10, "11316", 53.547136, -113.508235), (11, "1797", 53.561262, -113.5091),
         (12, "1904", 53.565882, -113.520017), (13, "1669", 53.5704, -113.53672)]


def fixture():
    db = sqlite3.connect(":memory:")
    db.executescript("CREATE TABLE stops(stop_id TEXT PRIMARY KEY, code TEXT, name TEXT, lat REAL, lon REAL);"
                     "CREATE TABLE stop_times(trip_id TEXT, stop_id TEXT, dep INTEGER, headsign TEXT, seq INTEGER);")
    for seq, sid, lat, lon in STOPS:
        db.execute("INSERT INTO stops VALUES(?,?,?,?,?)", (sid, sid, sid, lat, lon))
        db.execute("INSERT INTO stop_times VALUES('t',?,0,'',?)", (sid, seq))
    return db


class NextStop(unittest.TestCase):
    def test_between_timepoints_is_the_next_real_stop(self):  # ETS said 13; 11 and 12 were still ahead
        self.assertEqual(app.next_stop(fixture(), "t", (53.552639, -113.508339, 0, 0, 13)), 11)

    def test_at_a_stop_counts_that_stop(self):
        self.assertEqual(app.next_stop(fixture(), "t", (53.561262, -113.5091, 0, 0, 13)), 11)

    def test_before_the_first_stop(self):
        self.assertEqual(app.next_stop(fixture(), "t", (53.5430, -113.5082, 0, 0, 13)), 9)

    def test_ets_sequence_is_the_upper_bound(self):  # near stop 12 but ETS says 11 is next: trust the smaller
        self.assertEqual(app.next_stop(fixture(), "t", (53.5655, -113.5195, 0, 0, 11)), 11)

    def test_left_the_first_stop_while_ets_still_says_it(self):  # 902 at University TC, 2026-10-23: heading along the route
        self.assertEqual(app.next_stop(fixture(), "t", (53.552639, -113.508339, 355, 0, 9)), 11)

    def test_left_long_ago_past_half_its_stops(self):  # 004 past University TC (seq 37 of 71) shown 58 min, 2026-10-29
        self.assertEqual(app.next_stop(fixture(), "t", (53.56814, -113.528368, 294, 0, 9)), 13)

    def test_driving_in_along_a_loops_last_leg_has_not_left(self):  # a loop ends at its first stop: its tail leads in
        db = fixture()
        db.execute("INSERT INTO stop_times VALUES('t','11095',0,'',14)")
        self.assertEqual(app.next_stop(db, "t", (53.5577, -113.5225, 146, 0, 9)), 9)

    def test_at_the_first_stop_it_has_not_left(self):
        self.assertEqual(app.next_stop(fixture(), "t", (53.544996, -113.508267, 0, 0, 9)), 9)
        self.assertEqual(app.next_stop(fixture(), "t", (53.5460, -113.50825, 0, 0, 9)), 9)  # between 9 and 10

    def test_driving_in_to_the_start_the_other_way_has_not_left(self):  # on the route, heading back to its first stop
        self.assertEqual(app.next_stop(fixture(), "t", (53.552639, -113.508339, 175, 0, 9)), 9)

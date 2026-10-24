import sqlite3, unittest

from test_next_stop import app


class SearchWords(unittest.TestCase):
    def setUp(self):
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE stops(name TEXT)")
        db.executemany("INSERT INTO stops VALUES(?)", [("Mill Woods Transit Centre",), ("Jasper Ave & 101 St",)])
        self.db, app.VOCAB = db, None
        self.addCleanup(setattr, app, "VOCAB", None)

    def test_a_place_typed_as_one_word_with_a_typo(self):  # stop names say "Mill Woods"
        for typed in ("millwoods", "millwods", "milwoods"):
            self.assertEqual(app.search_words(self.db, typed), ["mill", "woods"], typed)

    def test_a_typo_in_one_word(self):
        self.assertEqual(app.search_words(self.db, "jaspr 101st"), ["jasper", "101"])


if __name__ == "__main__":
    unittest.main()

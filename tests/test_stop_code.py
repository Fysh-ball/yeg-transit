import unittest

from test_next_stop import app


class StopCode(unittest.TestCase):
    def test_the_stop_row_carries_the_code(self):  # web/app.js refills a saved stop's missing code from this (v115)
        self.assertEqual(app.stop_row(("1515", "1515", "Churchill Station", 53.5, -113.4))["code"], "1515")

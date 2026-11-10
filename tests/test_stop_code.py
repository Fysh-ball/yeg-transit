import unittest

from test_next_stop import app


class StopCode(unittest.TestCase):
    def test_the_stop_row_carries_the_code(self):  # web/app.js refills a saved stop's missing code from this (v115)
        self.assertEqual(app.stop_row(("1515", "1515", "Churchill Station", 53.5, -113.4))["code"], "1515")


class WeatherIcon(unittest.TestCase):
    def test_code_to_symbol(self):
        i = app.weather_icon
        self.assertEqual([i(0, 5, 10, 1), i(0, 5, 10, 0), i(2, 5, 10, 1), i(2, 5, 10, 0), i(3, 5, 10, 0)],
                         ["sun", "moon", "partly-day", "partly-night", "cloud"])
        self.assertEqual([i(61, 5, 10, 1), i(73, 5, 10, 0), i(95, 5, 10, 1), i(45, 5, 10, 1), i(None, 5, 10, 1)],
                         ["rain", "snow", "thunder", "fog", "sun"])
        self.assertEqual([i(1, 45, 50, 1), i(3, 10, 65, 0), i(73, 60, 90, 1)], ["wind", "wind", "snow"])  # wind loses to snow

"""Street plowing per stop, from the City's plow-route segments (real rows from data.edmonton.ca 8pdx-hfxi, 2026-11-10)."""
import os, sys, unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
import app  # noqa: E402

ROWS = [{"route_id": "2sw 021 - 16", "road_on": "Allard Gt SW", "seg_stat": "NA", "geometry_line": {"type": "MultiLineString",
         "coordinates": [[[-113.52861859253889, 53.403152166374575], [-113.5285163384686, 53.403135831041276],
                          [-113.5285129430771, 53.401708080377475]]]}},
        {"route_id": "2sw 024 - 16", "road_on": "Andrews Gt SW", "seg_stat": "NA", "geometry_line": {"type": "MultiLineString",
         "coordinates": [[[-113.59054961847468, 53.42803841564239], [-113.58876381052804, 53.42685322215301]]]}}]
ON_ALLARD = ("s1", "1", "Allard Gt & 30 Ave", 53.4025, -113.52840)   # about 7 m east of the Allard Gt line
FAR = ("s2", "2", "Nowhere", 53.5000, -113.40000)


class Snow(unittest.TestCase):
    def setUp(self):
        p = mock.patch.dict(app.SNOW, {"near": {}, "stat": {}, "event": False, "as_of": 1})
        p.start(); self.addCleanup(p.stop)
        app.SNOW["segs"], app.SNOW["grid"] = app.snow_shapes(ROWS)

    def test_no_event_says_nothing(self):
        self.assertEqual(app.stop_snow(ON_ALLARD), {"event": False})

    def test_in_an_event_a_stop_gets_its_road_and_the_citys_words(self):
        app.SNOW.update(event=True, stat={"2sw 021 - 16": "Complete"})
        self.assertEqual(app.stop_snow(ON_ALLARD), {"event": True, "road": "Allard Gt SW", "status": "Complete", "as_of": 1})

    def test_a_stop_off_the_map_is_unknown_not_unplowed(self):
        app.SNOW.update(event=True)
        self.assertEqual(app.stop_snow(FAR), {"event": True, "road": None, "as_of": 1})

    def test_a_road_with_no_status_yet_has_status_none(self):
        app.SNOW.update(event=True, stat={})
        self.assertIsNone(app.stop_snow(ON_ALLARD)["status"])

    def test_refresh_sees_an_event_only_when_a_status_is_not_NA(self):
        answers = {"stat": [{"route_id": "a", "seg_stat": "NA"}], "meta": {"rowsUpdatedAt": 5}}
        def get(url, timeout):
            return answers["meta"] if "/api/views/" in url else answers["stat"]
        app.SNOW["shapes_at"] = 9e12  # shapes already loaded
        with mock.patch.object(app.SOCRATA, "get_json", get), mock.patch.object(app.time, "sleep"):
            app.snow_refresh()
            self.assertFalse(app.SNOW["event"])
            answers["stat"] = [{"route_id": "a", "seg_stat": "NA"}, {"route_id": "b", "seg_stat": "In Progress"}]
            app.snow_refresh()
            self.assertTrue(app.SNOW["event"])
            self.assertEqual(app.SNOW["as_of"], 5)


if __name__ == "__main__":
    unittest.main()

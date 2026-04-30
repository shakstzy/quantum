"""Tests for the cross-source dedupe helper."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import dedupe  # noqa: E402


class TestHaversine(unittest.TestCase):
    def test_zero_distance(self):
        self.assertAlmostEqual(dedupe.haversine_m(30.0, -97.7, 30.0, -97.7), 0.0)

    def test_small_distance(self):
        # ~10 m apart in latitude
        d = dedupe.haversine_m(30.0, -97.7, 30.00009, -97.7)
        self.assertGreater(d, 5)
        self.assertLess(d, 15)


class TestApproxMatch(unittest.TestCase):
    def test_same_house_close_coords(self):
        a = {"lat": 30.0, "lng": -97.7, "beds": 3, "sqft": 1758}
        b = {"lat": 30.00005, "lng": -97.7, "beds": 3, "sqft": 1760}
        self.assertTrue(dedupe._approx_match(a, b))

    def test_different_beds_rejected(self):
        a = {"lat": 30.0, "lng": -97.7, "beds": 3, "sqft": 1758}
        b = {"lat": 30.0, "lng": -97.7, "beds": 4, "sqft": 1760}
        self.assertFalse(dedupe._approx_match(a, b))

    def test_different_sqft_rejected(self):
        a = {"lat": 30.0, "lng": -97.7, "beds": 3, "sqft": 1000}
        b = {"lat": 30.0, "lng": -97.7, "beds": 3, "sqft": 2000}
        self.assertFalse(dedupe._approx_match(a, b))

    def test_far_apart_rejected(self):
        a = {"lat": 30.0, "lng": -97.7, "beds": 3, "sqft": 1758}
        b = {"lat": 30.5, "lng": -97.7, "beds": 3, "sqft": 1758}
        self.assertFalse(dedupe._approx_match(a, b))


class TestMerge(unittest.TestCase):
    def test_merge_deduplicates_same_house(self):
        redfin = [{"source": "redfin", "property_id": 1, "lat": 30.0, "lng": -97.7,
                   "beds": 3, "sqft": 1750, "price": 599000}]
        zillow = [{"source": "zillow", "zpid": "z1", "lat": 30.00005, "lng": -97.7,
                   "beds": 3, "sqft": 1758, "price": 605000}]
        merged = dedupe.merge(redfin, zillow)
        self.assertEqual(len(merged), 1)
        self.assertIn("_other_sources", merged[0])
        self.assertEqual(len(merged[0]["_other_sources"]), 1)

    def test_merge_keeps_distinct_houses(self):
        a = [{"source": "redfin", "property_id": 1, "lat": 30.0, "lng": -97.7,
              "beds": 3, "sqft": 1750}]
        b = [{"source": "zillow", "zpid": "z1", "lat": 30.5, "lng": -97.7,
              "beds": 4, "sqft": 2000}]
        merged = dedupe.merge(a, b)
        self.assertEqual(len(merged), 2)


if __name__ == "__main__":
    unittest.main()

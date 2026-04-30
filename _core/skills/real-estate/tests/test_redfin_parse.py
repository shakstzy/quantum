"""Fixture-driven Redfin parser tests. NO network; conftest enforces it."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

from conftest import enforce_no_network, FIXTURES, NetworkDisabledError  # noqa: E402

enforce_no_network()

import redfin_parse  # noqa: E402


class TestRedfinSearchParse(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ctx_path = FIXTURES / "redfin-search-initial-context.json"
        if not ctx_path.exists():
            raise unittest.SkipTest("missing fixture; run scripts/capture_fixtures.py")
        cls.ctx = json.loads(ctx_path.read_text())

    def test_listings_present(self):
        homes = redfin_parse.parse_search_homes(self.ctx)
        self.assertGreater(len(homes), 0)

    def test_first_home_schema(self):
        homes = redfin_parse.parse_search_homes(self.ctx)
        h = homes[0]
        for key in ("address", "city", "state", "zip", "price", "beds",
                    "baths", "sqft", "url", "status", "property_type",
                    "lat", "lng", "photo_url"):
            self.assertIn(key, h, f"missing key: {key}")

    def test_url_absolute(self):
        homes = redfin_parse.parse_search_homes(self.ctx)
        for h in homes:
            if h.get("url"):
                self.assertTrue(h["url"].startswith("http"), h["url"])
                break

    def test_lat_lng_populated(self):
        homes = redfin_parse.parse_search_homes(self.ctx)
        with_coords = [h for h in homes if h.get("lat") is not None and h.get("lng") is not None]
        # At least 80% should have coords
        self.assertGreater(len(with_coords) / max(len(homes), 1), 0.8,
                           f"only {len(with_coords)}/{len(homes)} have coords")


class TestRedfinPropertyParse(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ctx_path = FIXTURES / "redfin-property-initial-context.json"
        if not ctx_path.exists():
            raise unittest.SkipTest("missing fixture; run scripts/capture_fixtures.py")
        cls.ctx = json.loads(ctx_path.read_text())

    def test_basic_fields_populated(self):
        p = redfin_parse.parse_property(self.ctx)
        for key in ("source", "address", "city", "state", "zip", "price",
                    "beds", "baths", "sqft", "year_built"):
            self.assertIsNotNone(p.get(key), f"{key} should be populated")

    def test_history_is_list(self):
        p = redfin_parse.parse_property(self.ctx)
        self.assertIsInstance(p.get("history"), list)

    def test_schools_is_list(self):
        p = redfin_parse.parse_property(self.ctx)
        self.assertIsInstance(p.get("schools"), list)

    def test_new_high_value_fields_present(self):
        p = redfin_parse.parse_property(self.ctx)
        # These are the additional fields we added in Phase 2.
        for key in ("ai_summary", "commute", "weather", "neighborhood_stats",
                    "parcel_info", "location_score", "sun_exposure",
                    "permits", "buying_power", "popularity", "price_drop",
                    "newest_listings_nearby", "tour_insights",
                    "home_highlight_tags", "avm_historical"):
            self.assertIn(key, p, f"missing high-value key: {key}")

    def test_listing_agent_dict(self):
        p = redfin_parse.parse_property(self.ctx)
        if p.get("listing_agent"):
            self.assertIsInstance(p["listing_agent"], dict)
            for sub in ("name", "license", "phone", "brokerage"):
                self.assertIn(sub, p["listing_agent"])

    def test_no_raw_unless_requested(self):
        p = redfin_parse.parse_property(self.ctx)
        self.assertNotIn("raw", p)
        p2 = redfin_parse.parse_property(self.ctx, include_raw=True)
        self.assertIn("raw", p2)


class TestRedfinNetworkDisabled(unittest.TestCase):
    def test_scraper_funcs_blow_up_on_call(self):
        import redfin
        with self.assertRaises(NetworkDisabledError):
            redfin._fetch_html("https://www.redfin.com/")
        with self.assertRaises(NetworkDisabledError):
            redfin._get_session()


if __name__ == "__main__":
    unittest.main()

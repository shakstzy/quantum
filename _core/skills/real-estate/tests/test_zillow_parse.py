"""Zillow parser tests. Mostly synthetic input (no live captures) plus
optional fixture-driven tests when a fixture is dropped in."""
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

import zillow  # noqa: E402
import zillow_parse  # noqa: E402


def _make_synthetic_search_state() -> dict:
    """Build a __NEXT_DATA__-shaped dict so we don't need a live capture."""
    return {
        "props": {
            "pageProps": {
                "searchPageState": {
                    "queryState": {
                        "mapBounds": {"north": 30.51, "east": -97.55, "south": 30.06, "west": -98.10},
                        "regionSelection": [{"regionId": 10221, "regionType": 6}],
                        "mapZoom": 11,
                    },
                    "cat1": {
                        "totalResultCount": 2,
                        "searchResults": {"listResults": [
                            {
                                "zpid": "29419686",
                                "addressStreet": "8102 Furness Cv",
                                "addressCity": "Austin",
                                "addressState": "TX",
                                "addressZipcode": "78753",
                                "unformattedPrice": 525000,
                                "beds": 5, "baths": 3, "area": 2072,
                                "detailUrl": "/homedetails/8102-Furness-Cv-Austin-TX-78753/29419686_zpid/",
                                "statusType": "FOR_SALE",
                                "imgSrc": "https://example.com/photo.jpg",
                                "hdpData": {"homeInfo": {
                                    "zpid": "29419686",
                                    "homeType": "SINGLE_FAMILY",
                                    "latitude": 30.341, "longitude": -97.691,
                                    "zestimate": 540000,
                                    "rentZestimate": 2700,
                                    "taxAssessedValue": 550325,
                                }},
                            },
                            {
                                "zpid": "999",
                                "address": "1 Test Ln",
                                "addressCity": "Austin",
                                "price": 100,
                                "hdpData": {"homeInfo": {"zpid": "999",
                                                          "latitude": 30.0, "longitude": -97.5}},
                            },
                        ]},
                    },
                },
            },
        },
    }


class TestZillowSearchParse(unittest.TestCase):
    def test_summarize_home_basic(self):
        h = _make_synthetic_search_state()["props"]["pageProps"]["searchPageState"]["cat1"]["searchResults"]["listResults"][0]
        s = zillow_parse.summarize_home(h)
        self.assertEqual(s["zpid"], "29419686")
        self.assertEqual(s["address"], "8102 Furness Cv")
        self.assertEqual(s["price"], 525000)
        self.assertEqual(s["zestimate"], 540000)
        self.assertEqual(s["lat"], 30.341)
        self.assertEqual(s["image_url"], "https://example.com/photo.jpg")

    def test_parse_search_homes(self):
        sps = _make_synthetic_search_state()["props"]["pageProps"]["searchPageState"]
        homes = zillow_parse.parse_search_homes(sps)
        self.assertEqual(len(homes), 2)


class TestZillowPointInPolygon(unittest.TestCase):
    def test_point_inside_square(self):
        # Square around Austin downtown
        poly = [(30.30, -97.80), (30.30, -97.70), (30.20, -97.70), (30.20, -97.80)]
        self.assertTrue(zillow._point_in_polygon(30.25, -97.75, poly))

    def test_point_outside_square(self):
        poly = [(30.30, -97.80), (30.30, -97.70), (30.20, -97.70), (30.20, -97.80)]
        self.assertFalse(zillow._point_in_polygon(30.40, -97.75, poly))

    def test_polygon_too_small(self):
        self.assertFalse(zillow._point_in_polygon(0, 0, [(0, 0), (1, 1)]))

    def test_polygon_to_bbox(self):
        poly = [(30.30, -97.80), (30.10, -97.70), (30.20, -97.90)]
        n, e, s, w = zillow._polygon_to_bbox(poly)
        self.assertEqual(n, 30.30)
        self.assertEqual(s, 30.10)
        self.assertEqual(e, -97.70)
        self.assertEqual(w, -97.90)


class TestZillowSlugify(unittest.TestCase):
    def test_city_state(self):
        self.assertEqual(zillow._slugify_city_state("Austin, TX"), "austin-tx")
        self.assertEqual(zillow._slugify_city_state("Round Rock, TX"), "round-rock-tx")
        self.assertEqual(zillow._slugify_city_state("Austin, Texas"), "austin-tx")

    def test_bare_zip(self):
        self.assertEqual(zillow._slugify_city_state("78704"), "78704")

    def test_existing_slug(self):
        self.assertEqual(zillow._slugify_city_state("austin-tx"), "austin-tx")

    def test_unparseable_no_dash(self):
        # No comma, no dash, not a zip -> can't slugify
        self.assertIsNone(zillow._slugify_city_state("justsometext"))

    def test_existing_slug_passthrough(self):
        # Anything that already looks like a slug (has a dash, is alphanumeric)
        # passes through unchanged. Not a bug; Zillow accepts /<slug>/.
        self.assertEqual(zillow._slugify_city_state("just-some-text"), "just-some-text")


class TestZillowFilterState(unittest.TestCase):
    def test_status_active_default(self):
        fs = zillow._filter_state()
        self.assertEqual(fs["sortSelection"]["value"], "globalrelevanceex")
        self.assertEqual(fs["isAllHomes"]["value"], True)

    def test_status_pending_filters(self):
        fs = zillow._filter_state(status="pending")
        self.assertIn("isPendingListingsSelected", fs)

    def test_price_filter(self):
        fs = zillow._filter_state(max_price=600000, min_price=300000)
        self.assertEqual(fs["price"], {"max": 600000, "min": 300000})

    def test_year_built_filter(self):
        fs = zillow._filter_state(year_built_min=2000, year_built_max=2020)
        self.assertEqual(fs["built"], {"min": 2000, "max": 2020})


class TestZillowCustomRegionId(unittest.TestCase):
    def test_extract_from_url(self):
        url = ("https://www.zillow.com/homes/?searchQueryState="
               + "%7B%22customRegionId%22%3A%22abc123%22%7D")
        self.assertEqual(zillow._custom_region_id_from_url(url), "abc123")

    def test_no_qs(self):
        self.assertIsNone(zillow._custom_region_id_from_url("https://www.zillow.com/homes/"))


class TestZillowFixture(unittest.TestCase):
    """Optional: only runs if a Zillow __NEXT_DATA__ fixture is present."""

    @classmethod
    def setUpClass(cls):
        p = FIXTURES / "zillow-property-next-data.json"
        if not p.exists():
            raise unittest.SkipTest("zillow-property-next-data.json missing; capture later")
        cls.data = json.loads(p.read_text())

    def test_property_basic(self):
        p = zillow_parse.parse_property(self.data)
        self.assertEqual(p["source"], "zillow")
        for key in ("zpid", "address", "price", "beds", "baths", "sqft"):
            self.assertIn(key, p)


class TestZillowNetworkDisabled(unittest.TestCase):
    def test_scraper_blows_up(self):
        with self.assertRaises(NetworkDisabledError):
            zillow._fetch_html("https://www.zillow.com/")
        with self.assertRaises(NetworkDisabledError):
            zillow._get_session()


if __name__ == "__main__":
    unittest.main()

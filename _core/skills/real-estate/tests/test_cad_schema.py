"""Smoke tests for the EARS / True Prodigy fixed-width parser.

The schema offsets are easy to mis-paste from the layout doc. These tests
pin the critical fields against a hand-constructed line that mirrors the
real PROP.TXT layout so off-by-ones get caught immediately.
"""
from __future__ import annotations

import unittest

from scripts.cad import schema


class TestCoerce(unittest.TestCase):
    def test_string_strips(self):
        self.assertEqual(schema._coerce("  hello  ", "str"), "hello")
        self.assertIsNone(schema._coerce("   ", "str"))

    def test_tf(self):
        self.assertTrue(schema._coerce("T", "tf"))
        self.assertTrue(schema._coerce("Y", "tf"))
        self.assertFalse(schema._coerce("F", "tf"))
        self.assertFalse(schema._coerce("N", "tf"))
        self.assertIsNone(schema._coerce("", "tf"))
        self.assertIsNone(schema._coerce("X", "tf"))

    def test_int_no_scale(self):
        self.assertEqual(schema._coerce("000551875", "int"), 551875)

    def test_float_with_implied_decimals(self):
        # 0.1577 acres for 5509 Casco Walk
        self.assertAlmostEqual(
            schema._coerce("00000000000000001577", "float", scale=4), 0.1577, places=6,
        )

    def test_float_no_scale(self):
        self.assertEqual(schema._coerce("6869", "float"), 6869.0)

    def test_blank_returns_none(self):
        self.assertIsNone(schema._coerce("    ", "int"))
        self.assertIsNone(schema._coerce("    ", "float"))


def _build_prop_line(*, prop_id: str = "929360", prop_type_cd: str = "R",
                     val_year: str = "2026", situs_num: str = "5509",
                     situs_street: str = "CASCO", situs_street_suffix: str = "WALK",
                     situs_zip: str = "78724",
                     owner_name: str = "BALAKRISHNAN AMBAL SANKARI",
                     appraised_val: str = "551875",
                     legal_acreage: str = "0000000000001577",  # 0.1577 acres, 16 chars
                     ) -> str:
    """Construct a synthetic 9813-char Property line with critical fields filled."""
    line = list(" " * 9813)
    def put(start_1based: int, length: int, value: str, *, right_align: bool = False) -> None:
        s = start_1based - 1
        v = value[:length]
        if right_align:
            v = v.rjust(length, "0" if v and v[0].isdigit() else " ")
        else:
            v = v.ljust(length)
        for i, c in enumerate(v):
            line[s + i] = c
    put(1, 12, prop_id, right_align=True)
    put(13, 5, prop_type_cd)
    put(18, 5, val_year, right_align=True)
    put(609, 70, owner_name)
    put(1040, 10, "")  # situs_street_prefix blank
    put(1050, 50, situs_street)
    put(1100, 10, situs_street_suffix)
    put(1140, 10, situs_zip)
    put(1660, 16, legal_acreage)
    put(1916, 15, appraised_val, right_align=True)
    put(1946, 15, appraised_val, right_align=True)  # assessed = appraised in test
    put(4214, 14, appraised_val, right_align=True)  # market_value_pretax
    put(4460, 15, situs_num)
    return "".join(line)


class TestParseProperty(unittest.TestCase):
    def setUp(self):
        self.line = _build_prop_line()

    def test_id_year_type(self):
        r = schema.parse_line(self.line, schema.PROPERTY_FIELDS)
        self.assertEqual(r["prop_id"], 929360)
        self.assertEqual(r["prop_type_cd"], "R")
        self.assertEqual(r["val_year"], 2026)

    def test_situs(self):
        r = schema.parse_line(self.line, schema.PROPERTY_FIELDS)
        self.assertEqual(r["situs_num"], "5509")
        self.assertEqual(r["situs_street"], "CASCO")
        self.assertEqual(r["situs_street_suffix"], "WALK")
        self.assertEqual(r["situs_zip"], "78724")

    def test_owner(self):
        r = schema.parse_line(self.line, schema.PROPERTY_FIELDS)
        self.assertEqual(r["owner_name"], "BALAKRISHNAN AMBAL SANKARI")

    def test_money_no_scaling(self):
        r = schema.parse_line(self.line, schema.PROPERTY_FIELDS)
        self.assertEqual(r["appraised_val"], 551875)
        self.assertEqual(r["assessed_val"], 551875)
        self.assertEqual(r["market_value_pretax"], 551875)

    def test_acreage_implied_decimals(self):
        r = schema.parse_line(self.line, schema.PROPERTY_FIELDS)
        # raw "0000000000001577" with scale=4 -> 0.1577
        self.assertAlmostEqual(r["legal_acreage"], 0.1577, places=4)


class TestParseLandDetail(unittest.TestCase):
    def test_size_acres_scaled(self):
        line = list(" " * 200)
        # prop_id at 1-12, val_year at 13-16, land_seg_id at 17-28
        for i, c in enumerate("000000929360"): line[i] = c
        for i, c in enumerate("2026"): line[12 + i] = c
        for i, c in enumerate("000000000001"): line[16 + i] = c
        # size_acres at 70-83 (14 chars), 4 implied decimals: "00000000001577" = 0.1577
        for i, c in enumerate("00000000001577"): line[69 + i] = c
        # size_sqft at 84-97 (14 chars): "00000000006869"
        for i, c in enumerate("00000000006869"): line[83 + i] = c
        s = "".join(line)
        r = schema.parse_line(s, schema.LAND_DETAIL_FIELDS)
        self.assertEqual(r["prop_id"], 929360)
        self.assertEqual(r["val_year"], 2026)
        self.assertAlmostEqual(r["size_acres"], 0.1577, places=4)
        self.assertEqual(r["size_sqft"], 6869.0)


if __name__ == "__main__":
    unittest.main()

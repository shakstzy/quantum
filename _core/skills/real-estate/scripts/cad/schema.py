"""EARS / True Prodigy fixed-width column specs.

Source: TP_Legacy8.0.32-AppraisalExportLayout.xlsx (TCAD).
This is the standard True Prodigy CAD export format used by ~30+ TX
counties (Travis, Williamson, Hays, Bastrop, Caldwell, Comal, Guadalupe,
many more). Other CAD vendors (Tyler, Pritchard & Abbott, Harris Govern)
have similar but distinct schemas; add separate spec dicts when needed.

Each entry: (start_inclusive_1based, length, type, dest_column[, scale])
The optional 5th element is the decimal scale for fields encoded WITHOUT
a decimal point (TP-Legacy convention) - e.g. acres are stored as
integers with 4 implied decimals: "0000000000023553" -> 2.3553 acres.

We keep ONLY the fields we actually use - the full Property record has
500+ fields and is 9813 chars wide, but we don't need most of it.
"""
from __future__ import annotations

# Fixed-width spec for True Prodigy "Property" file (PROP.TXT).
# Indexes match the schema doc: start (1-based), length, parser type, output column.
PROPERTY_FIELDS: list[tuple[int, int, str, str]] = [
    # ID + year
    (1,    12, "int",   "prop_id"),
    (13,    5, "str",   "prop_type_cd"),       # R=Real, P=Personal, M=Mobile, etc.
    (18,    5, "int",   "val_year"),
    # Geo / legal handle
    (547,  50, "str",   "geo_id"),
    # Owner
    (609,  70, "str",   "owner_name"),
    (694,  60, "str",   "mail_addr_line1"),
    (754,  60, "str",   "mail_addr_line2"),
    (874,  50, "str",   "mail_addr_city"),
    (924,  50, "str",   "mail_addr_state"),
    (979,   5, "str",   "mail_addr_zip"),
    # Situs (the actual property address). The street NUMBER lives at 4460,
    # not in the prefix - this is a quirk of the True Prodigy schema. We pull
    # both ranges and combine into situs_full at ingest time.
    (1040, 10, "str",   "situs_street_prefix"),
    (1050, 50, "str",   "situs_street"),
    (1100, 10, "str",   "situs_street_suffix"),
    (1110, 30, "str",   "situs_city"),
    (1140, 10, "str",   "situs_zip"),
    (4460, 15, "str",   "situs_num"),
    (4475,  5, "str",   "situs_unit"),
    # Legal
    (1150, 255, "str",  "legal_desc"),
    (1660, 16, "float", "legal_acreage", 4),       # 4 implied decimals
    (1676, 10, "str",   "subdivision_cd"),
    (1696, 50, "str",   "block"),
    (1746, 50, "str",   "tract_or_lot"),
    (2772, 20, "float", "land_acres_sum", 4),  # sum of land segments, 4 implied decimals
    (4136, 40, "str",   "dba"),
    (4214, 14, "int",   "market_value_pretax"),  # pre-computed market value (prop tax basis)
    # Values
    (1796, 15, "int",   "land_hstd_val"),
    (1811, 15, "int",   "land_non_hstd_val"),
    (1826, 15, "int",   "imprv_hstd_val"),
    (1841, 15, "int",   "imprv_non_hstd_val"),
    (1856, 15, "int",   "ag_use_val"),
    (1871, 15, "int",   "ag_market_val"),
    (1916, 15, "int",   "appraised_val"),
    (1931, 15, "int",   "ten_pct_cap"),
    (1946, 15, "int",   "assessed_val"),
    # Deed (latest filed; TX is a non-disclosure state for sale price)
    (1994, 20, "str",   "deed_book_id"),
    (2014, 20, "str",   "deed_book_page"),
    (2034, 25, "str",   "deed_dt"),
    # Mortgage
    (2071, 70, "str",   "mortgage_co_name"),
    # Exemptions
    (2609,  1, "tf",    "hs_exempt"),
    (2610,  1, "tf",    "ov65_exempt"),
    (2662,  1, "tf",    "dp_exempt"),
    (2663,  1, "tf",    "dv1_exempt"),    # 10-30%
    (2665,  1, "tf",    "dv2_exempt"),    # 31-50%
    (2667,  1, "tf",    "dv3_exempt"),    # 51-70%
    (2669,  1, "tf",    "dv4_exempt"),    # 71-100%
    (2671,  1, "tf",    "ex_exempt"),
    # ARB protest flag
    (1981,  1, "tf",    "arb_protest"),
]

# Fixed-width spec for True Prodigy "ImprovementDetail" file (IMP_DET.TXT).
# This is where year_built and per-building sqft live.
IMPROVEMENT_DETAIL_FIELDS: list[tuple[int, int, str, str]] = [
    (1,   12, "int",   "prop_id"),
    (13,   4, "int",   "val_year"),
    (17,  12, "int",   "imprv_id"),
    (29,  12, "int",   "imprv_det_id"),
    (41,  10, "str",   "imprv_det_type_cd"),
    (51,  25, "str",   "imprv_det_type_desc"),
    (76,  10, "str",   "imprv_det_class_cd"),
    (86,   4, "int",   "yr_built"),
    (90,   4, "int",   "depreciation_yr"),
    (94,  15, "float", "imprv_det_area"),     # sqft
    (109, 14, "int",   "imprv_det_val"),
    # skip sketch_cmds at 123-622, 500 chars we don't need
]

# Fixed-width spec for "LandDetail" file (LAND_DET.TXT).
# Lot info per land segment (a parcel can have multiple, e.g. residence + ag).
LAND_DETAIL_FIELDS: list[tuple[int, int, str, str]] = [
    (1,   12, "int",   "prop_id"),
    (13,   4, "int",   "val_year"),
    (17,  12, "int",   "land_seg_id"),
    (29,  10, "str",   "land_type_cd"),
    (39,  25, "str",   "land_type_desc"),
    (64,   5, "str",   "state_cd"),
    (69,   1, "tf",    "is_homesite"),
    (70,  14, "float", "size_acres", 4),    # 4 implied decimals per spec
    (84,  14, "float", "size_sqft"),         # whole sqft, no decimal scaling
    (98,  14, "float", "effective_front"),
    (112, 14, "float", "effective_depth"),
    (141, 14, "int",   "land_seg_mkt_val"),
    (155,  1, "tf",    "ag_apply"),
    (171, 14, "int",   "ag_value"),
]


def _coerce(raw: str, kind: str, scale: int = 0):
    """Coerce a fixed-width slice into a Python value. Returns None on blanks.

    `scale` is the number of implied decimal places (TP-Legacy convention):
    "1577" with scale=4 -> 0.1577.
    """
    s = raw.strip()
    if not s:
        return None
    if kind == "str":
        return s
    if kind == "tf":
        # 'T'/'Y' = true, 'F'/'N' = false
        u = s.upper()
        if u in ("T", "Y", "1"): return True
        if u in ("F", "N", "0"): return False
        return None
    if kind == "int":
        try:
            v = int(s)
            return v // (10 ** scale) if scale > 0 else v
        except ValueError:
            return None
    if kind == "float":
        try:
            v = float(s)
            return v / (10 ** scale) if scale > 0 else v
        except ValueError:
            return None
    return s


def parse_line(line: str, fields: list[tuple]) -> dict:
    """Parse one fixed-width line per spec. Out-of-bounds slices yield None.

    Each spec entry is (start, length, type, name) or
    (start, length, type, name, scale).
    """
    out: dict = {}
    n = len(line)
    for spec in fields:
        if len(spec) == 5:
            start, length, kind, name, scale = spec
        else:
            start, length, kind, name = spec
            scale = 0
        # Schema is 1-based inclusive; Python slice is 0-based [start-1:start-1+length]
        s = start - 1
        e = s + length
        if s >= n:
            out[name] = None
            continue
        out[name] = _coerce(line[s:min(e, n)], kind, scale)
    return out

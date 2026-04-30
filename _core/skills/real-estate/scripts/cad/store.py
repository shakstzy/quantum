"""DuckDB store for CAD parcel data.

Single database at ~/.quantum/real-estate/cad/cad.duckdb covers all
counties. The `county` column on every table is the partition key; queries
that don't specify a county scan everything.

Ingest is idempotent: re-running for the same (county, val_year) replaces
that slice. So a quarterly refresh just downloads the newest export and
re-runs ingest.
"""
from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path
from typing import Iterable, Iterator

import duckdb
import pyarrow as pa

from .schema import (
    IMPROVEMENT_DETAIL_FIELDS,
    LAND_DETAIL_FIELDS,
    PROPERTY_FIELDS,
    parse_line,
)


def _bulk_insert(con: duckdb.DuckDBPyConnection, table: str, columns: list[str],
                 col_data: dict[str, list], *, on_conflict: str | None = None) -> int:
    """Fast bulk insert via pyarrow registration. Returns rows inserted.

    `on_conflict`: a clause like "(county, prop_id, prop_type_cd, val_year) DO NOTHING"
    to silently drop duplicates (UDI multi-owner parcels collapse to first-seen).
    """
    if not col_data or not col_data[columns[0]]:
        return 0
    tbl = pa.Table.from_pydict(col_data)
    con.register("__bulk_in", tbl)
    try:
        sql = (
            f"INSERT INTO {table} ({', '.join(columns)}) "
            f"SELECT {', '.join(columns)} FROM __bulk_in"
        )
        if on_conflict:
            sql += f" ON CONFLICT {on_conflict}"
        con.execute(sql)
    finally:
        con.unregister("__bulk_in")
    return len(col_data[columns[0]])


DEFAULT_DB_PATH = Path.home() / ".quantum" / "real-estate" / "cad" / "cad.duckdb"


def open_db(path: Path | None = None) -> duckdb.DuckDBPyConnection:
    """Open (and create + migrate) the CAD DuckDB."""
    p = path or DEFAULT_DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(p))
    _migrate(con)
    return con


def _migrate(con: duckdb.DuckDBPyConnection) -> None:
    """Create tables/indexes if they don't exist."""
    con.execute("""
        CREATE TABLE IF NOT EXISTS parcels (
            county VARCHAR NOT NULL,
            prop_id VARCHAR NOT NULL,
            prop_type_cd VARCHAR NOT NULL,
            val_year INTEGER NOT NULL,
            geo_id VARCHAR,
            owner_name VARCHAR,
            mail_addr_line1 VARCHAR,
            mail_addr_line2 VARCHAR,
            mail_addr_city VARCHAR,
            mail_addr_state VARCHAR,
            mail_addr_zip VARCHAR,
            situs_num VARCHAR,
            situs_unit VARCHAR,
            situs_street_prefix VARCHAR,
            situs_street VARCHAR,
            situs_street_suffix VARCHAR,
            situs_city VARCHAR,
            situs_zip VARCHAR,
            situs_full VARCHAR,           -- num + prefix + street + suffix + unit
            situs_norm VARCHAR,           -- lowercase, no punctuation, for LIKE
            legal_desc VARCHAR,
            legal_acreage DOUBLE,
            land_acres_sum DOUBLE,
            subdivision_cd VARCHAR,
            block VARCHAR,
            tract_or_lot VARCHAR,
            dba VARCHAR,
            market_value_pretax BIGINT,
            land_hstd_val BIGINT,
            land_non_hstd_val BIGINT,
            imprv_hstd_val BIGINT,
            imprv_non_hstd_val BIGINT,
            ag_use_val BIGINT,
            ag_market_val BIGINT,
            market_val BIGINT,            -- land_hstd + land_non_hstd + imprv_hstd + imprv_non_hstd
            appraised_val BIGINT,
            ten_pct_cap BIGINT,
            assessed_val BIGINT,
            deed_book_id VARCHAR,
            deed_book_page VARCHAR,
            deed_dt VARCHAR,
            mortgage_co_name VARCHAR,
            hs_exempt BOOLEAN,
            ov65_exempt BOOLEAN,
            dp_exempt BOOLEAN,
            dv1_exempt BOOLEAN,
            dv2_exempt BOOLEAN,
            dv3_exempt BOOLEAN,
            dv4_exempt BOOLEAN,
            ex_exempt BOOLEAN,
            arb_protest BOOLEAN,
            ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (county, prop_id, prop_type_cd, val_year)
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS improvements_detail (
            county VARCHAR NOT NULL,
            prop_id VARCHAR NOT NULL,
            val_year INTEGER NOT NULL,
            imprv_id VARCHAR,
            imprv_det_id VARCHAR,
            imprv_det_type_cd VARCHAR,
            imprv_det_type_desc VARCHAR,
            imprv_det_class_cd VARCHAR,
            yr_built INTEGER,
            depreciation_yr INTEGER,
            imprv_det_area DOUBLE,
            imprv_det_val BIGINT
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS land_detail (
            county VARCHAR NOT NULL,
            prop_id VARCHAR NOT NULL,
            val_year INTEGER NOT NULL,
            land_seg_id VARCHAR,
            land_type_cd VARCHAR,
            land_type_desc VARCHAR,
            state_cd VARCHAR,
            is_homesite BOOLEAN,
            size_acres DOUBLE,
            size_sqft DOUBLE,
            effective_front DOUBLE,
            effective_depth DOUBLE,
            land_seg_mkt_val BIGINT,
            ag_apply BOOLEAN,
            ag_value BIGINT
        )
    """)
    # Lookup indexes
    con.execute("CREATE INDEX IF NOT EXISTS idx_parcels_situs_zip ON parcels(situs_zip)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_parcels_situs_norm ON parcels(situs_norm)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_parcels_geo ON parcels(geo_id)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_imprv_prop ON improvements_detail(county, prop_id, val_year)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_land_prop ON land_detail(county, prop_id, val_year)")


_DIRECTIONAL_EXPAND = {
    "n": "north", "s": "south", "e": "east", "w": "west",
    "ne": "northeast", "nw": "northwest", "se": "southeast", "sw": "southwest",
}
_DIRECTIONAL_CONTRACT = {v: k for k, v in _DIRECTIONAL_EXPAND.items()}

# Street-type aliases. Index stores the abbreviated form ("BLVD"); user
# queries may use either form. Normalizing both sides to the abbreviation
# makes "1219 South Lamar Boulevard" match "1219 S LAMAR BLVD".
_STREET_TYPE_CONTRACT = {
    "boulevard": "blvd", "blvd": "blvd",
    "street": "st", "st": "st",
    "avenue": "ave", "ave": "ave",
    "drive": "dr", "dr": "dr",
    "road": "rd", "rd": "rd",
    "lane": "ln", "ln": "ln",
    "court": "ct", "ct": "ct",
    "place": "pl", "pl": "pl",
    "circle": "cir", "cir": "cir",
    "trail": "trl", "trl": "trl", "tr": "trl",
    "highway": "hwy", "hwy": "hwy",
    "parkway": "pkwy", "pkwy": "pkwy",
    "terrace": "ter", "ter": "ter",
    "cove": "cv", "cv": "cv",
    "square": "sq", "sq": "sq",
    "loop": "loop",
    "way": "way",
    "walk": "walk",
    "run": "run",
    "path": "path",
    "pass": "pass",
    "bend": "bnd", "bnd": "bnd",
    "ridge": "rdg", "rdg": "rdg",
    "crossing": "xing", "xing": "xing",
    "expressway": "expy", "expy": "expy",
    "freeway": "fwy", "fwy": "fwy",
}


def _contract_token(t: str) -> str:
    """Apply directional + street-type abbreviation rules to a single token."""
    if t in _DIRECTIONAL_CONTRACT:
        return _DIRECTIONAL_CONTRACT[t]
    if t in _STREET_TYPE_CONTRACT:
        return _STREET_TYPE_CONTRACT[t]
    return t


def _norm_situs(num: str | None, prefix: str | None, street: str | None,
                suffix: str | None, unit: str | None = None) -> tuple[str, str]:
    """Build situs_full (display) and situs_norm (lookup key).

    situs_norm contains the canonical short-form of every word: directionals
    AND street-type words (boulevard / blvd, drive / dr) are stored as their
    abbreviation, so LIKE queries match regardless of which form the user
    typed. The string is space-padded on both ends so token-boundary LIKE
    patterns ('% blvd %') don't false-match short tokens.
    """
    parts = [p for p in [num, prefix, street, suffix] if p and p.strip()]
    full = " ".join(p.strip() for p in parts)
    if unit and unit.strip():
        full = f"{full} #{unit.strip()}"
    # Normalize: lowercase, drop punctuation, contract directionals + street types,
    # then space-pad so '% s %' won't false-match 'casco' (s is in the middle).
    bare = "".join(c.lower() if c.isalnum() else " " for c in full)
    tokens = [_contract_token(t) for t in bare.split()]
    return full, " " + " ".join(tokens) + " "


def _stream_records(path: Path, fields: list, county: str, batch: int = 50_000) -> Iterator[list[dict]]:
    """Stream a fixed-width file as batches of dict rows."""
    rows: list[dict] = []
    with open(path, "rb") as f:
        for raw in f:
            try:
                line = raw.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")
            except Exception:
                continue
            if not line.strip():
                continue
            rec = parse_line(line, fields)
            rec["county"] = county
            rows.append(rec)
            if len(rows) >= batch:
                yield rows
                rows = []
    if rows:
        yield rows


# Property types we keep. Everything else (Personal property, Mineral, Auto)
# is excluded — Travis CAD files them under the same prop_id as the real
# parcel they sit on, which would collide on PK and pollute lookups.
KEEP_PROP_TYPES = {"R", "MH"}


_PARCEL_COLUMNS = [
    "county", "prop_id", "prop_type_cd", "val_year", "geo_id", "owner_name",
    "mail_addr_line1", "mail_addr_line2", "mail_addr_city", "mail_addr_state", "mail_addr_zip",
    "situs_num", "situs_unit",
    "situs_street_prefix", "situs_street", "situs_street_suffix", "situs_city", "situs_zip",
    "situs_full", "situs_norm",
    "legal_desc", "legal_acreage", "land_acres_sum",
    "subdivision_cd", "block", "tract_or_lot",
    "dba", "market_value_pretax",
    "land_hstd_val", "land_non_hstd_val", "imprv_hstd_val", "imprv_non_hstd_val",
    "ag_use_val", "ag_market_val", "market_val", "appraised_val", "ten_pct_cap", "assessed_val",
    "deed_book_id", "deed_book_page", "deed_dt", "mortgage_co_name",
    "hs_exempt", "ov65_exempt", "dp_exempt",
    "dv1_exempt", "dv2_exempt", "dv3_exempt", "dv4_exempt", "ex_exempt",
    "arb_protest",
]


def ingest_parcels(con: duckdb.DuckDBPyConnection, path: Path, county: str,
                   *, val_year: int, progress: bool = True) -> int:
    """Ingest PROP.TXT for a county/year via PyArrow + INSERT INTO SELECT.

    Replaces existing slice for that (county, val_year). Filters to real
    property only - skips P (business equipment), MN (mineral), AU (auto).
    """
    con.execute("DELETE FROM parcels WHERE county = ? AND val_year = ?", [county, val_year])

    total = 0
    skipped = 0
    t0 = time.monotonic()
    for batch in _stream_records(path, PROPERTY_FIELDS, county, batch=100_000):
        # Per-column accumulators - pyarrow.Table.from_pydict wants column-orientation.
        cd: dict[str, list] = {c: [] for c in _PARCEL_COLUMNS}
        for r in batch:
            ptc = (r.get("prop_type_cd") or "").upper()
            if ptc not in KEEP_PROP_TYPES:
                skipped += 1
                continue
            if not r.get("prop_id"):
                skipped += 1
                continue
            full, norm = _norm_situs(
                r.get("situs_num"),
                r.get("situs_street_prefix"),
                r.get("situs_street"),
                r.get("situs_street_suffix"),
                r.get("situs_unit"),
            )
            land = (r.get("land_hstd_val") or 0) + (r.get("land_non_hstd_val") or 0)
            imprv = (r.get("imprv_hstd_val") or 0) + (r.get("imprv_non_hstd_val") or 0)
            market = land + imprv if (land or imprv) else None
            cd["county"].append(r.get("county"))
            cd["prop_id"].append(str(r.get("prop_id")))
            cd["prop_type_cd"].append(ptc)
            cd["val_year"].append(r.get("val_year") or val_year)
            cd["geo_id"].append(r.get("geo_id"))
            cd["owner_name"].append(r.get("owner_name"))
            cd["mail_addr_line1"].append(r.get("mail_addr_line1"))
            cd["mail_addr_line2"].append(r.get("mail_addr_line2"))
            cd["mail_addr_city"].append(r.get("mail_addr_city"))
            cd["mail_addr_state"].append(r.get("mail_addr_state"))
            cd["mail_addr_zip"].append(r.get("mail_addr_zip"))
            cd["situs_num"].append(r.get("situs_num"))
            cd["situs_unit"].append(r.get("situs_unit"))
            cd["situs_street_prefix"].append(r.get("situs_street_prefix"))
            cd["situs_street"].append(r.get("situs_street"))
            cd["situs_street_suffix"].append(r.get("situs_street_suffix"))
            cd["situs_city"].append(r.get("situs_city"))
            cd["situs_zip"].append(r.get("situs_zip"))
            cd["situs_full"].append(full)
            cd["situs_norm"].append(norm)
            cd["legal_desc"].append(r.get("legal_desc"))
            cd["legal_acreage"].append(r.get("legal_acreage"))
            cd["land_acres_sum"].append(r.get("land_acres_sum"))
            cd["subdivision_cd"].append(r.get("subdivision_cd"))
            cd["block"].append(r.get("block"))
            cd["tract_or_lot"].append(r.get("tract_or_lot"))
            cd["dba"].append(r.get("dba"))
            cd["market_value_pretax"].append(r.get("market_value_pretax"))
            cd["land_hstd_val"].append(r.get("land_hstd_val"))
            cd["land_non_hstd_val"].append(r.get("land_non_hstd_val"))
            cd["imprv_hstd_val"].append(r.get("imprv_hstd_val"))
            cd["imprv_non_hstd_val"].append(r.get("imprv_non_hstd_val"))
            cd["ag_use_val"].append(r.get("ag_use_val"))
            cd["ag_market_val"].append(r.get("ag_market_val"))
            cd["market_val"].append(market)
            cd["appraised_val"].append(r.get("appraised_val"))
            cd["ten_pct_cap"].append(r.get("ten_pct_cap"))
            cd["assessed_val"].append(r.get("assessed_val"))
            cd["deed_book_id"].append(r.get("deed_book_id"))
            cd["deed_book_page"].append(r.get("deed_book_page"))
            cd["deed_dt"].append(r.get("deed_dt"))
            cd["mortgage_co_name"].append(r.get("mortgage_co_name"))
            cd["hs_exempt"].append(r.get("hs_exempt"))
            cd["ov65_exempt"].append(r.get("ov65_exempt"))
            cd["dp_exempt"].append(r.get("dp_exempt"))
            cd["dv1_exempt"].append(r.get("dv1_exempt"))
            cd["dv2_exempt"].append(r.get("dv2_exempt"))
            cd["dv3_exempt"].append(r.get("dv3_exempt"))
            cd["dv4_exempt"].append(r.get("dv4_exempt"))
            cd["ex_exempt"].append(r.get("ex_exempt"))
            cd["arb_protest"].append(r.get("arb_protest"))
        # UDI parcels (multi-owner real property) yield duplicate PK; first-wins.
        n = _bulk_insert(con, "parcels", _PARCEL_COLUMNS, cd,
                         on_conflict="(county, prop_id, prop_type_cd, val_year) DO NOTHING")
        total += n
        if progress:
            elapsed = time.monotonic() - t0
            sys.stderr.write(
                f"\r  parcels: {total:,} kept / {skipped:,} skipped  ({total/elapsed:.0f}/s)"
            )
            sys.stderr.flush()
    if progress:
        sys.stderr.write("\n")
    # The on_conflict path inflates `total` by candidates submitted, not rows inserted.
    # Recompute from DB so the final count is honest.
    actual = con.execute(
        "SELECT COUNT(*) FROM parcels WHERE county = ? AND val_year = ?",
        [county, val_year],
    ).fetchone()
    return actual[0] if actual else total


_IMPRV_COLUMNS = [
    "county", "prop_id", "val_year", "imprv_id", "imprv_det_id",
    "imprv_det_type_cd", "imprv_det_type_desc", "imprv_det_class_cd",
    "yr_built", "depreciation_yr", "imprv_det_area", "imprv_det_val",
]


def ingest_improvements_detail(con: duckdb.DuckDBPyConnection, path: Path, county: str,
                                *, val_year: int, progress: bool = True) -> int:
    con.execute("DELETE FROM improvements_detail WHERE county = ? AND val_year = ?", [county, val_year])
    total = 0
    t0 = time.monotonic()
    for batch in _stream_records(path, IMPROVEMENT_DETAIL_FIELDS, county, batch=200_000):
        cd: dict[str, list] = {c: [] for c in _IMPRV_COLUMNS}
        for r in batch:
            if not r.get("prop_id"):
                continue
            cd["county"].append(r.get("county"))
            cd["prop_id"].append(str(r.get("prop_id")))
            cd["val_year"].append(r.get("val_year") or val_year)
            cd["imprv_id"].append(str(r.get("imprv_id")) if r.get("imprv_id") is not None else None)
            cd["imprv_det_id"].append(str(r.get("imprv_det_id")) if r.get("imprv_det_id") is not None else None)
            cd["imprv_det_type_cd"].append(r.get("imprv_det_type_cd"))
            cd["imprv_det_type_desc"].append(r.get("imprv_det_type_desc"))
            cd["imprv_det_class_cd"].append(r.get("imprv_det_class_cd"))
            cd["yr_built"].append(r.get("yr_built"))
            cd["depreciation_yr"].append(r.get("depreciation_yr"))
            cd["imprv_det_area"].append(r.get("imprv_det_area"))
            cd["imprv_det_val"].append(r.get("imprv_det_val"))
        total += _bulk_insert(con, "improvements_detail", _IMPRV_COLUMNS, cd)
        if progress:
            elapsed = time.monotonic() - t0
            sys.stderr.write(f"\r  imprv_det: {total:,} rows  ({total/elapsed:.0f}/s)")
            sys.stderr.flush()
    if progress:
        sys.stderr.write("\n")
    return total


_LAND_COLUMNS = [
    "county", "prop_id", "val_year", "land_seg_id",
    "land_type_cd", "land_type_desc", "state_cd", "is_homesite",
    "size_acres", "size_sqft", "effective_front", "effective_depth",
    "land_seg_mkt_val", "ag_apply", "ag_value",
]


def ingest_land_detail(con: duckdb.DuckDBPyConnection, path: Path, county: str,
                       *, val_year: int, progress: bool = True) -> int:
    con.execute("DELETE FROM land_detail WHERE county = ? AND val_year = ?", [county, val_year])
    total = 0
    t0 = time.monotonic()
    for batch in _stream_records(path, LAND_DETAIL_FIELDS, county, batch=200_000):
        cd: dict[str, list] = {c: [] for c in _LAND_COLUMNS}
        for r in batch:
            if not r.get("prop_id"):
                continue
            cd["county"].append(r.get("county"))
            cd["prop_id"].append(str(r.get("prop_id")))
            cd["val_year"].append(r.get("val_year") or val_year)
            cd["land_seg_id"].append(str(r.get("land_seg_id")) if r.get("land_seg_id") is not None else None)
            cd["land_type_cd"].append(r.get("land_type_cd"))
            cd["land_type_desc"].append(r.get("land_type_desc"))
            cd["state_cd"].append(r.get("state_cd"))
            cd["is_homesite"].append(r.get("is_homesite"))
            cd["size_acres"].append(r.get("size_acres"))
            cd["size_sqft"].append(r.get("size_sqft"))
            cd["effective_front"].append(r.get("effective_front"))
            cd["effective_depth"].append(r.get("effective_depth"))
            cd["land_seg_mkt_val"].append(r.get("land_seg_mkt_val"))
            cd["ag_apply"].append(r.get("ag_apply"))
            cd["ag_value"].append(r.get("ag_value"))
        total += _bulk_insert(con, "land_detail", _LAND_COLUMNS, cd)
        if progress:
            elapsed = time.monotonic() - t0
            sys.stderr.write(f"\r  land:      {total:,} rows  ({total/elapsed:.0f}/s)")
            sys.stderr.flush()
    if progress:
        sys.stderr.write("\n")
    return total


# ---------------------------------------------------------------------------
# Lookup queries
# ---------------------------------------------------------------------------

def _norm_query(s: str) -> str:
    """Normalize a free-form address query the same way we normalize situs.

    Directionals AND street-types contract to their abbreviation. The output
    is the canonical token string (no leading/trailing pad - the caller adds
    that when constructing LIKE patterns).
    """
    bare = "".join(c.lower() if c.isalnum() else " " for c in s)
    tokens = [_contract_token(t) for t in bare.split()]
    return " ".join(tokens)


_CITY_TRAILING = re.compile(
    r",?\s+(austin|lakeway|pflugerville|leander|manor|round\s+rock|westlake|"
    r"bee\s+cave|buda|kyle|spicewood|cedar\s+park|west\s+lake\s+hills|"
    r"sunset\s+valley|jonestown|lago\s+vista|hudson\s+bend|del\s+valle)?"
    r"(?:\s*,?\s*(?:tx|texas))?"
    r"\s*\d{5}\s*$",
    re.I,
)


def lookup_address(con: duckdb.DuckDBPyConnection, address: str, *,
                   county: str | None = None, val_year: int | None = None) -> list[dict]:
    """Find parcels matching an address.

    Strategy:
    1. Strip the trailing "<city>, <state>, <zip>" segment ONLY (don't drop
       city tokens globally - 'cedar', 'park', 'bee', 'cave' etc. are real
       street-name fragments in Travis County).
    2. Extract zip5 separately for an indexed equality on situs_zip.
    3. Tokenize the remaining street part. Each token contributes a
       word-boundary LIKE clause: '% <token> %' against the space-padded
       situs_norm, so 's' won't false-match 'casco'.
    4. Drop super-short tokens (length 1) UNLESS they're a directional, since
       a single-letter substring matches almost anything.
    """
    # Find 5-digit zip
    zip_m = re.search(r"\b(\d{5})\b", address)
    zip5 = zip_m.group(1) if zip_m else None

    # Strip ONLY the trailing "[, City] [, State] zip" suffix - keep early city
    # tokens that look like street names (e.g. "100 Cedar Park Cv Austin TX").
    stripped = _CITY_TRAILING.sub("", address.strip())
    # If no trailing city pattern matched, also strip a bare "TX 12345" tail
    stripped = re.sub(r",?\s+(?:tx|texas)\s+\d{5}\s*$", "", stripped, flags=re.I)
    stripped = re.sub(r"\s+\d{5}\s*$", "", stripped)
    norm_q = _norm_query(stripped)

    # Token-boundary matching against space-padded situs_norm
    raw_tokens = [t for t in norm_q.split() if t]
    tokens = [t for t in raw_tokens
              if len(t) >= 2 or t in _DIRECTIONAL_CONTRACT.values()]

    where: list[str] = []
    params: list = []
    for t in tokens:
        where.append("situs_norm LIKE ?")
        params.append(f"% {t} %")
    if not where:
        return []
    if zip5:
        where.append("situs_zip = ?")
        params.append(zip5)
    if county:
        where.append("county = ?")
        params.append(county)
    if val_year:
        where.append("val_year = ?")
        params.append(val_year)

    sql = f"""
        WITH ranked AS (
            SELECT *,
                   ROW_NUMBER() OVER (PARTITION BY county, prop_id ORDER BY val_year DESC) AS rn
              FROM parcels
             WHERE {' AND '.join(where)}
        )
        SELECT * FROM ranked WHERE rn = 1 LIMIT 25
    """
    cur = con.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def score_candidate(candidate: dict, address: str) -> int:
    """Higher score = better match for the input address.

    Used to pick among multiple candidates instead of the naive
    'shortest situs_norm wins' (which fails when a parent parcel
    has a shorter situs_norm than the requested unit).
    """
    score = 0
    # Extract street number from input
    num_m = re.match(r"^\s*(\d+)\b", address)
    if num_m and candidate.get("situs_num"):
        if str(candidate["situs_num"]).strip() == num_m.group(1):
            score += 1000   # exact street-number match: dominant
    # Extract zip from input
    zip_m = re.search(r"\b(\d{5})\b", address)
    if zip_m and candidate.get("situs_zip") == zip_m.group(1):
        score += 100
    # Unit in input must match unit in candidate
    unit_m = re.search(r"\b(?:apt|unit|#)\s*([0-9a-z]+)\b", address, flags=re.I)
    cand_unit = (candidate.get("situs_unit") or "").strip()
    if unit_m:
        if cand_unit.lower() == unit_m.group(1).lower():
            score += 50
    elif cand_unit:
        # Input has no unit but candidate is a sub-unit - penalize so the
        # parent parcel (which usually has cand_unit blank) wins.
        score -= 20
    # Tie-breaker: closer length to input wins, all else equal
    norm_len = len((candidate.get("situs_norm") or "").strip())
    score -= max(0, norm_len - 30)
    return score


def get_property_full(con: duckdb.DuckDBPyConnection, county: str, prop_id: str,
                      *, val_year: int | None = None) -> dict | None:
    """Get the full picture for one parcel: parcel + improvements + land segments."""
    if val_year is None:
        r = con.execute("""
            SELECT MAX(val_year) FROM parcels WHERE county = ? AND prop_id = ?
        """, [county, prop_id]).fetchone()
        val_year = r[0] if r and r[0] else None
        if val_year is None:
            return None

    # Parcel
    cur = con.execute(
        "SELECT * FROM parcels WHERE county = ? AND prop_id = ? AND val_year = ?",
        [county, prop_id, val_year],
    )
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    if not rows:
        return None
    parcel = dict(zip(cols, rows[0]))

    # Improvements (year_built + sqft live here)
    cur = con.execute("""
        SELECT imprv_det_type_cd, imprv_det_type_desc, imprv_det_class_cd,
               yr_built, imprv_det_area, imprv_det_val
          FROM improvements_detail
         WHERE county = ? AND prop_id = ? AND val_year = ?
         ORDER BY imprv_det_val DESC NULLS LAST
    """, [county, prop_id, val_year])
    icols = [d[0] for d in cur.description]
    imprvs = [dict(zip(icols, row)) for row in cur.fetchall()]

    # TP-Legacy improvement-detail rows mix REAL areas (1ST, 2ND, GARAGE, PORCH)
    # with COUNTS stored as area (BEDROOMS, BATHROOM, HALF BATHROOM). Use the
    # type_cd to disambiguate.
    FLOOR_CODES = {"1ST", "2ND", "3RD", "4TH", "BS", "BSMT", "BSM"}
    BED_BATH_CODES = {"250": "half_baths", "251": "full_baths", "252": "beds"}

    # year_built = earliest yr_built across actual structure rows (not bed/bath counts)
    structure_imprvs = [i for i in imprvs
                         if (i.get("imprv_det_type_cd") or "").upper() in FLOOR_CODES]
    if not structure_imprvs:
        structure_imprvs = [i for i in imprvs if i.get("imprv_det_type_cd") not in BED_BATH_CODES]
    yrs = [i["yr_built"] for i in structure_imprvs if i.get("yr_built") and i["yr_built"] > 1700]
    yr_built = min(yrs) if yrs else None

    # Living area = sum of all FLOOR_CODE areas (1st + 2nd + ...)
    floor_imprvs = [i for i in imprvs if (i.get("imprv_det_type_cd") or "").upper() in FLOOR_CODES]
    living_sqft = sum((i.get("imprv_det_area") or 0) for i in floor_imprvs) or None

    # Bed / bath COUNTS encoded as imprv_det_area on type rows 250/251/252
    counts: dict[str, float] = {}
    for i in imprvs:
        cd = i.get("imprv_det_type_cd")
        if cd in BED_BATH_CODES and i.get("imprv_det_area") is not None:
            counts[BED_BATH_CODES[cd]] = i["imprv_det_area"]

    # Land
    cur = con.execute("""
        SELECT land_type_cd, land_type_desc, state_cd, is_homesite,
               size_acres, size_sqft, effective_front, effective_depth,
               land_seg_mkt_val, ag_apply, ag_value
          FROM land_detail
         WHERE county = ? AND prop_id = ? AND val_year = ?
    """, [county, prop_id, val_year])
    lcols = [d[0] for d in cur.description]
    lands = [dict(zip(lcols, row)) for row in cur.fetchall()]

    return {
        "parcel": parcel,
        "year_built": yr_built,
        "living_sqft": living_sqft,
        "beds": counts.get("beds"),
        "full_baths": counts.get("full_baths"),
        "half_baths": counts.get("half_baths"),
        "improvements": imprvs,
        "land": lands,
    }


def get_db_summary(con: duckdb.DuckDBPyConnection) -> dict:
    """Health check: how many parcels per county/year do we have?"""
    rows = con.execute("""
        SELECT county, val_year, COUNT(*) AS parcels,
               MIN(ingested_at) AS oldest_ingest,
               MAX(ingested_at) AS newest_ingest
          FROM parcels
         GROUP BY county, val_year
         ORDER BY county, val_year DESC
    """).fetchall()
    return {
        "counties": [
            {"county": r[0], "val_year": r[1], "parcels": r[2],
             "oldest_ingest": r[3], "newest_ingest": r[4]}
            for r in rows
        ],
    }

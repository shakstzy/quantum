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
import sys
import time
from pathlib import Path
from typing import Iterable, Iterator

import duckdb

from .schema import (
    IMPROVEMENT_DETAIL_FIELDS,
    LAND_DETAIL_FIELDS,
    PROPERTY_FIELDS,
    parse_line,
)


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
            situs_street_prefix VARCHAR,
            situs_street VARCHAR,
            situs_street_suffix VARCHAR,
            situs_city VARCHAR,
            situs_zip VARCHAR,
            situs_full VARCHAR,           -- prefix + street + suffix, single string
            situs_norm VARCHAR,           -- lowercase, no punctuation, for LIKE
            legal_desc VARCHAR,
            legal_acreage DOUBLE,
            subdivision_cd VARCHAR,
            block VARCHAR,
            tract_or_lot VARCHAR,
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


def _norm_situs(prefix: str | None, street: str | None, suffix: str | None) -> tuple[str, str]:
    """Build situs_full (display) and situs_norm (lookup key)."""
    parts = [p for p in [prefix, street, suffix] if p and p.strip()]
    full = " ".join(p.strip() for p in parts)
    # Normalize: lowercase, collapse whitespace, drop punctuation
    norm = "".join(c.lower() if c.isalnum() else " " for c in full)
    norm = " ".join(norm.split())
    return full, norm


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


def ingest_parcels(con: duckdb.DuckDBPyConnection, path: Path, county: str,
                   *, val_year: int, progress: bool = True) -> int:
    """Ingest PROP.TXT for a county/year via DuckDB Appender (fast path).

    Replaces existing slice for that (county, val_year). Filters to real
    property only - skips P (business equipment), MN (mineral), AU (auto).
    """
    con.execute("DELETE FROM parcels WHERE county = ? AND val_year = ?", [county, val_year])

    # Column order MUST match table declaration; Appender is positional.
    appender = con.appender("parcels")
    total = 0
    skipped = 0
    t0 = time.monotonic()
    for batch in _stream_records(path, PROPERTY_FIELDS, county, batch=100_000):
        for r in batch:
            ptc = (r.get("prop_type_cd") or "").upper()
            if ptc not in KEEP_PROP_TYPES:
                skipped += 1
                continue
            if not r.get("prop_id"):
                skipped += 1
                continue
            full, norm = _norm_situs(r.get("situs_street_prefix"),
                                      r.get("situs_street"),
                                      r.get("situs_street_suffix"))
            land = (r.get("land_hstd_val") or 0) + (r.get("land_non_hstd_val") or 0)
            imprv = (r.get("imprv_hstd_val") or 0) + (r.get("imprv_non_hstd_val") or 0)
            market = land + imprv if (land or imprv) else None
            appender.append_row(
                r.get("county"), str(r.get("prop_id")), ptc, r.get("val_year") or val_year,
                r.get("geo_id"), r.get("owner_name"),
                r.get("mail_addr_line1"), r.get("mail_addr_line2"), r.get("mail_addr_city"),
                r.get("mail_addr_state"), r.get("mail_addr_zip"),
                r.get("situs_street_prefix"), r.get("situs_street"), r.get("situs_street_suffix"),
                r.get("situs_city"), r.get("situs_zip"),
                full, norm,
                r.get("legal_desc"), r.get("legal_acreage"), r.get("subdivision_cd"),
                r.get("block"), r.get("tract_or_lot"),
                r.get("land_hstd_val"), r.get("land_non_hstd_val"),
                r.get("imprv_hstd_val"), r.get("imprv_non_hstd_val"),
                r.get("ag_use_val"), r.get("ag_market_val"), market,
                r.get("appraised_val"), r.get("ten_pct_cap"), r.get("assessed_val"),
                r.get("deed_book_id"), r.get("deed_book_page"), r.get("deed_dt"),
                r.get("mortgage_co_name"),
                r.get("hs_exempt"), r.get("ov65_exempt"), r.get("dp_exempt"),
                r.get("dv1_exempt"), r.get("dv2_exempt"), r.get("dv3_exempt"), r.get("dv4_exempt"),
                r.get("ex_exempt"), r.get("arb_protest"),
                None,  # ingested_at takes default at flush; Appender requires every column
            )
            total += 1
        if progress:
            elapsed = time.monotonic() - t0
            sys.stderr.write(
                f"\r  parcels: {total:,} kept / {skipped:,} skipped  ({total/elapsed:.0f}/s)"
            )
            sys.stderr.flush()
    appender.close()
    # Backfill ingested_at on the rows we just inserted
    con.execute(
        "UPDATE parcels SET ingested_at = CURRENT_TIMESTAMP WHERE ingested_at IS NULL AND county = ? AND val_year = ?",
        [county, val_year],
    )
    if progress:
        sys.stderr.write("\n")
    return total


def ingest_improvements_detail(con: duckdb.DuckDBPyConnection, path: Path, county: str,
                                *, val_year: int, progress: bool = True) -> int:
    con.execute("DELETE FROM improvements_detail WHERE county = ? AND val_year = ?", [county, val_year])
    appender = con.appender("improvements_detail")
    total = 0
    t0 = time.monotonic()
    for batch in _stream_records(path, IMPROVEMENT_DETAIL_FIELDS, county, batch=200_000):
        for r in batch:
            if not r.get("prop_id"):
                continue
            appender.append_row(
                r.get("county"), str(r.get("prop_id")), r.get("val_year") or val_year,
                str(r.get("imprv_id")) if r.get("imprv_id") is not None else None,
                str(r.get("imprv_det_id")) if r.get("imprv_det_id") is not None else None,
                r.get("imprv_det_type_cd"), r.get("imprv_det_type_desc"), r.get("imprv_det_class_cd"),
                r.get("yr_built"), r.get("depreciation_yr"),
                r.get("imprv_det_area"), r.get("imprv_det_val"),
            )
            total += 1
        if progress:
            elapsed = time.monotonic() - t0
            sys.stderr.write(f"\r  imprv_det: {total:,} rows  ({total/elapsed:.0f}/s)")
            sys.stderr.flush()
    appender.close()
    if progress:
        sys.stderr.write("\n")
    return total


def ingest_land_detail(con: duckdb.DuckDBPyConnection, path: Path, county: str,
                       *, val_year: int, progress: bool = True) -> int:
    con.execute("DELETE FROM land_detail WHERE county = ? AND val_year = ?", [county, val_year])
    appender = con.appender("land_detail")
    total = 0
    t0 = time.monotonic()
    for batch in _stream_records(path, LAND_DETAIL_FIELDS, county, batch=200_000):
        for r in batch:
            if not r.get("prop_id"):
                continue
            appender.append_row(
                r.get("county"), str(r.get("prop_id")), r.get("val_year") or val_year,
                str(r.get("land_seg_id")) if r.get("land_seg_id") is not None else None,
                r.get("land_type_cd"), r.get("land_type_desc"), r.get("state_cd"), r.get("is_homesite"),
                r.get("size_acres"), r.get("size_sqft"),
                r.get("effective_front"), r.get("effective_depth"),
                r.get("land_seg_mkt_val"), r.get("ag_apply"), r.get("ag_value"),
            )
            total += 1
        if progress:
            elapsed = time.monotonic() - t0
            sys.stderr.write(f"\r  land:      {total:,} rows  ({total/elapsed:.0f}/s)")
            sys.stderr.flush()
    appender.close()
    if progress:
        sys.stderr.write("\n")
    return total


# ---------------------------------------------------------------------------
# Lookup queries
# ---------------------------------------------------------------------------

def _norm_query(s: str) -> str:
    """Normalize a free-form address query the same way we normalize situs."""
    norm = "".join(c.lower() if c.isalnum() else " " for c in s)
    return " ".join(norm.split())


def lookup_address(con: duckdb.DuckDBPyConnection, address: str, *,
                   county: str | None = None, val_year: int | None = None) -> list[dict]:
    """Find parcels matching an address.

    Strategy: extract any 5-digit zip from the input and match by
    situs_zip + LIKE on the street component. Returns a small list of
    candidates (typically 1, sometimes 2-3 for condo/duplex).
    """
    import re
    # Find 5-digit zip
    zip_m = re.search(r"\b(\d{5})\b", address)
    zip5 = zip_m.group(1) if zip_m else None

    # Strip zip + state + city for street-only normalization
    no_state = re.sub(r",?\s+(TX|TEXAS)\s*", " ", address, flags=re.I)
    no_zip = re.sub(r"\b\d{5}\b", "", no_state)
    parts = [p.strip() for p in no_zip.split(",") if p.strip()]
    street_part = parts[0] if parts else address
    street_norm = _norm_query(street_part)

    where = ["situs_norm LIKE ?"]
    params: list = [f"%{street_norm}%"]
    if zip5:
        where.append("situs_zip = ?")
        params.append(zip5)
    if county:
        where.append("county = ?")
        params.append(county)
    if val_year:
        where.append("val_year = ?")
        params.append(val_year)
    else:
        # Default to most recent year per (county, prop_id)
        pass

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

    # Aggregate: year_built = earliest yr_built among "main" structures
    # Living-area sqft = sum of areas where type_cd looks like main living (heuristic)
    main_imprvs = [i for i in imprvs if i.get("imprv_det_type_cd") and
                   any(k in (i["imprv_det_type_cd"] or "").upper() for k in ("MA", "1ST", "MAIN", "RES", "LA"))]
    yr_built = None
    if main_imprvs:
        yrs = [i["yr_built"] for i in main_imprvs if i.get("yr_built") and i["yr_built"] > 1700]
        yr_built = min(yrs) if yrs else None
    else:
        yrs = [i["yr_built"] for i in imprvs if i.get("yr_built") and i["yr_built"] > 1700]
        yr_built = min(yrs) if yrs else None
    living_sqft = sum((i.get("imprv_det_area") or 0) for i in main_imprvs) or None

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

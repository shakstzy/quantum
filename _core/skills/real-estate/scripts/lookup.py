"""Address-to-house lookup. The simple path Adithya cares about:

Input: a free-text address ("9400 Shady Oaks Dr Austin TX 78729")
Output: every reasonable field about that house, pulled from BOTH Redfin
and Zillow, with the two views side-by-side plus a merged top-level view
so you don't have to pick a winner.

Resolution path:
  1. Brave-search `site:redfin.com <address>` -> first /<ST>/<City>/.../home/<id> URL
  2. Brave-search `site:zillow.com <address>`  -> first /homedetails/.../<zpid>_zpid/ URL
  3. Hit each property page (1 live hit per site, max 2 hits total).
  4. Merge: prefer values from the source that has them; flag conflicts.

Why brave-search for both: neither site exposes a stable public address->id
API. Their own autocomplete endpoints are WAF-walled. Brave returns the
canonical site URLs reliably for any indexable listing.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any
from urllib.parse import urlparse

import redfin  # type: ignore
import zillow  # type: ignore

# URL shape regexes
RF_PROPERTY_RE = re.compile(r"redfin\.com/[A-Z]{2}/[^/]+/[^/]+/home/\d+")
ZW_PROPERTY_RE = re.compile(r"zillow\.com/homedetails/[^/]+/\d+_zpid")


def _brave_first_url(query: str, site: str) -> str | None:
    """Run brave-search and return the first URL whose host matches `site`
    AND whose path matches the property-URL shape.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    brave = os.path.normpath(os.path.join(here, "..", "..", "brave-search", "search.sh"))
    if not os.path.exists(brave):
        return None
    full_q = f"site:{site} {query}"
    try:
        out = subprocess.check_output([brave, full_q, "8"], timeout=20).decode()
    except Exception:
        return None
    try:
        data = json.loads(out)
    except Exception:
        return None
    results = (data.get("web") or {}).get("results") or data.get("results") or []
    pattern = RF_PROPERTY_RE if site == "redfin.com" else ZW_PROPERTY_RE
    for r in results:
        url = r.get("url") or ""
        if pattern.search(url):
            return url
    return None


def find_redfin_url(address: str) -> str | None:
    return _brave_first_url(address, "redfin.com")


def find_zillow_url(address: str) -> str | None:
    return _brave_first_url(address, "zillow.com")


def _merge_views(rf: dict, zw: dict) -> dict:
    """Merge a Redfin property dict and a Zillow property dict into one
    flat top-level view. Values prefer Redfin when both populate (more
    reliably parsed in this skill), with Zillow filling the gaps.

    `_conflicts` lists fields where both sources have a value but they
    disagree by more than a noise threshold, so the caller can decide.
    """
    rf = rf or {}
    zw = zw or {}
    if rf.get("error") or not isinstance(rf, dict):
        rf = {}
    if zw.get("error") or not isinstance(zw, dict):
        zw = {}

    out: dict[str, Any] = {}
    conflicts: list[dict] = []

    def _take(key, *aliases, prefer="redfin", numeric_tol=None):
        rf_val = next((rf.get(a) for a in (key, *aliases) if rf.get(a) is not None), None)
        zw_val = next((zw.get(a) for a in (key, *aliases) if zw.get(a) is not None), None)
        if rf_val is None and zw_val is None:
            return
        # Conflict detection
        if rf_val is not None and zw_val is not None:
            disagree = False
            if numeric_tol is not None:
                try:
                    a, b = float(rf_val), float(zw_val)
                    if abs(a - b) > numeric_tol:
                        disagree = True
                except (TypeError, ValueError):
                    disagree = (str(rf_val).strip().lower() != str(zw_val).strip().lower())
            else:
                disagree = (str(rf_val).strip().lower() != str(zw_val).strip().lower())
            if disagree:
                conflicts.append({"field": key, "redfin": rf_val, "zillow": zw_val})
        out[key] = rf_val if (prefer == "redfin" and rf_val is not None) else (zw_val if zw_val is not None else rf_val)

    # Identity
    _take("address")
    _take("city")
    _take("state")
    _take("zip")
    _take("lat", "latitude")
    _take("lng", "longitude")

    # Money
    _take("price", numeric_tol=10000)  # 10k tolerance for last-update lag
    _take("redfin_estimate")
    _take("zestimate", prefer="zillow")
    _take("rent_estimate")
    _take("rent_zestimate", prefer="zillow")
    _take("tax_assessed_value", prefer="zillow")
    _take("price_per_sqft", numeric_tol=20)
    _take("monthly_hoa_fee", "hoa_per_month")
    _take("annual_homeowners_insurance", prefer="zillow")
    _take("property_tax_rate", prefer="zillow")

    # Specs
    _take("beds", "bedrooms")
    _take("baths", "bathrooms", numeric_tol=0.01)
    _take("full_baths", "bathroomsFull")
    _take("half_baths", "bathroomsHalf")
    _take("sqft", "livingArea", numeric_tol=10)
    _take("year_built", numeric_tol=1)
    _take("lot_size", numeric_tol=200)
    _take("home_type", "property_type")
    _take("home_status", "status")
    _take("days_on_market", "time_on_zillow")

    # History + nested data (each side keeps its own; no merge of arrays)
    out["price_history"] = (rf.get("history") or zw.get("price_history") or [])
    out["tax_history"] = (zw.get("tax_history") or rf.get("tax_info") or [])
    out["schools"] = (rf.get("schools") or zw.get("schools") or [])

    # Listing agent — prefer whichever has more populated fields
    rf_agent = rf.get("listing_agent") or {}
    zw_agent = zw.get("listing_agent") or {}
    rf_score = sum(1 for v in rf_agent.values() if v) if isinstance(rf_agent, dict) else 0
    zw_score = sum(1 for v in zw_agent.values() if v) if isinstance(zw_agent, dict) else 0
    out["listing_agent"] = rf_agent if rf_score >= zw_score else zw_agent

    # Photos: prefer the longer list
    rf_photos = rf.get("photos") or []
    zw_photos = zw.get("photos") or []
    out["photos"] = rf_photos if len(rf_photos) >= len(zw_photos) else zw_photos
    out["photo_count"] = max(len(rf_photos), len(zw_photos)) or None

    # Open houses: union (each source may know about different ones)
    out["open_houses"] = (rf.get("open_houses") or []) + (zw.get("open_houses") or [])

    # Zillow-only enrichments worth surfacing at top level
    for k in ("description", "virtual_tour_url", "walk_score", "transit_score",
             "bike_score", "climate_risk", "nearby_homes", "nearby_cities",
             "nearby_neighborhoods", "interior_features", "exterior_features",
             "parking_features", "garage_spaces", "heating", "cooling",
             "appliances", "fireplace", "flooring", "stories", "view_description",
             "pool_features", "is_new_construction", "mls_id", "mls_name"):
        if zw.get(k) is not None:
            out.setdefault(k, zw[k])

    # Redfin-only enrichments
    for k in ("ai_summary", "commute", "weather", "sun_exposure", "parcel_info",
             "parcel_boundaries", "zoning", "permits", "popularity",
             "price_drop", "neighborhood_stats", "newest_listings_nearby",
             "tour_insights", "buying_power", "home_highlight_tags",
             "avm_historical", "risk_factors", "amenities", "comps", "apn",
             "list_date", "sold_date"):
        if rf.get(k) is not None:
            out.setdefault(k, rf[k])

    out["_conflicts"] = conflicts
    return out


def lookup(address: str, *, include_raw: bool = False) -> dict:
    """The simple `address -> all the data` path.

    Errors per source are caught and surfaced as `{"error": ...}` so a
    Zillow PX block doesn't block the Redfin half.
    """
    rf_url = find_redfin_url(address)
    zw_url = find_zillow_url(address)

    rf: dict = {"error": "no Redfin URL found"} if not rf_url else {}
    if rf_url:
        try:
            rf = redfin.property_details(rf_url, include_raw=include_raw)
        except Exception as e:
            rf = {"error": str(e), "url": rf_url}

    zw: dict = {"error": "no Zillow URL found"} if not zw_url else {}
    if zw_url:
        try:
            zw = zillow.property_details(zw_url, include_raw=include_raw)
        except Exception as e:
            zw = {"error": str(e), "url": zw_url}

    merged = _merge_views(rf, zw)
    # Address-match warning. Brave-search returns the closest indexed
    # listing, which may not be the exact house the user typed. Flag when
    # the resolved Redfin and Zillow addresses disagree.
    rf_addr = (rf.get("address") or "") if isinstance(rf, dict) else ""
    zw_addr = (zw.get("address") or "") if isinstance(zw, dict) else ""
    addr_match = "ok"
    if rf_addr and zw_addr and rf_addr.split(",")[0].strip().lower() != zw_addr.split(",")[0].strip().lower():
        addr_match = "mismatch"
    if rf.get("error") and zw.get("error"):
        addr_match = "neither_resolved"
    elif rf.get("error") or zw.get("error"):
        addr_match = "single_source"
    return {
        "input_address": address,
        "redfin_url": rf_url,
        "zillow_url": zw_url,
        "address_match": addr_match,
        "redfin": rf,
        "zillow": zw,
        "merged": merged,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="lookup")
    ap.add_argument("address", help='free-text address, e.g. "9400 Shady Oaks Dr Austin TX 78729"')
    ap.add_argument("--include-raw", action="store_true",
                    help="include the full nested API payloads from each source")
    ap.add_argument("--merged-only", action="store_true",
                    help="print only the merged view, not the per-source dumps")
    args = ap.parse_args(argv)

    result = lookup(args.address, include_raw=args.include_raw)
    if args.merged_only:
        out = result["merged"]
    else:
        out = result
    json.dump(out, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()

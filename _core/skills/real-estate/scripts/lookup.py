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
import zillow_parse  # type: ignore

# URL shape regexes
RF_PROPERTY_RE = re.compile(r"redfin\.com/[A-Z]{2}/[^/]+/[^/]+/home/\d+")
ZW_PROPERTY_RE = re.compile(r"zillow\.com/homedetails/[^/]+/\d+_zpid")


def _zillow_slug(address: str) -> str | None:
    """Build a Zillow-style address slug from free-text.

    Zillow's canonical search slug is `<num>-<street-words-hyphenated>-<city>-<ST>-<zip>`.
    Example: '5509 Casco Walk Austin TX 78724' -> '5509-Casco-Walk-Austin-TX-78724'.
    Returns None if we can't parse out at least street + city + state.
    """
    s = (address or "").strip()
    if not s:
        return None
    # Drop trailing punctuation, collapse repeats, hyphenate words.
    s = re.sub(r"[,]+", " ", s)
    s = re.sub(r"\s+", "-", s)
    return s


_STREET_NUM_RE = re.compile(r"^\s*(\d+)\b")
_STREET_TYPE_TOKENS = {
    "st", "street", "ave", "avenue", "blvd", "boulevard", "rd", "road",
    "dr", "drive", "ln", "lane", "ct", "court", "pl", "place", "cir",
    "circle", "trl", "trail", "hwy", "highway", "pkwy", "parkway",
    "ter", "terrace", "way", "cv", "cove", "loop", "sq", "square", "walk",
}


def _street_number(address: str) -> str | None:
    """Pull the leading street number from a free-text address."""
    m = _STREET_NUM_RE.match(address)
    return m.group(1) if m else None


def _street_name_token(address: str) -> str | None:
    """Pull the FIRST street-name word from a free-text address.

    For '5509 Casco Walk Austin TX 78724' -> 'casco'.
    Skips the leading number, returns the next non-direction-non-type word.
    """
    if not address:
        return None
    s = re.sub(r"[,]+", " ", address).lower()
    tokens = s.split()
    if not tokens:
        return None
    # Drop leading street number(s)
    start = 0
    while start < len(tokens) and re.fullmatch(r"\d+", tokens[start]):
        start += 1
    # Optionally drop leading direction tokens (N, S, E, W, North, etc.)
    directions = {"n", "s", "e", "w", "ne", "nw", "se", "sw",
                  "north", "south", "east", "west",
                  "northeast", "northwest", "southeast", "southwest"}
    while start < len(tokens) and tokens[start] in directions:
        start += 1
    if start >= len(tokens):
        return None
    name = tokens[start]
    # If first token is itself a street type (rare), skip it
    if name in _STREET_TYPE_TOKENS and start + 1 < len(tokens):
        name = tokens[start + 1]
    # Strip trailing punctuation (keep alnum)
    name = re.sub(r"[^a-z0-9]+", "", name)
    return name or None


def _brave_first_url(query: str, site: str, *,
                     require_street_num: str | None = None,
                     require_street_name: str | None = None) -> str | None:
    """Run brave-search; return only a URL whose path matches BOTH the
    street number AND the street-name token (when supplied).

    Brave's index for new-build / off-MLS listings is patchy: a search for
    '5509 Casco Walk' often ranks '5501 Casco Walk' (an indexed neighbor)
    or even '5509 Hibiscus Dr' (different street, same number) above the
    actual 5509 Casco Walk. Returning either would silently mislead the
    user. Requiring number AND street-name is the pragmatic fix without a
    real reverse-geocoder.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    brave = os.path.normpath(os.path.join(here, "..", "..", "brave-search", "search.sh"))
    if not os.path.exists(brave):
        return None
    full_q = f"site:{site} {query}"
    try:
        out = subprocess.check_output([brave, full_q, "10"], timeout=20).decode()
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
        if not pattern.search(url):
            continue
        if require_street_num and not _url_has_street_num(url, require_street_num):
            continue
        if require_street_name and not _url_has_street_name(url, require_street_name):
            continue
        return url
    return None


def _url_has_street_num(url: str, num: str) -> bool:
    """True if URL contains `/<num>-` as a street-number boundary."""
    return bool(re.search(rf"/{re.escape(num)}-", url))


def _url_has_street_name(url: str, name: str) -> bool:
    """True if URL's address slug contains the street-name token (case-
    insensitive). Looks for '-<name>-' or '-<name>$' (end of segment)."""
    return bool(re.search(rf"-{re.escape(name)}(?:-|/|$)", url, re.IGNORECASE))


def _is_redfin_property_url(s: str) -> bool:
    return bool(RF_PROPERTY_RE.search(s or ""))


def _is_zillow_property_url(s: str) -> bool:
    return bool(ZW_PROPERTY_RE.search(s or ""))


def find_redfin_url(address_or_url: str) -> str | None:
    """Resolve to a Redfin property URL. Accepts:
      - a full Redfin property URL -> returned as-is
      - a free-text address -> brave-search, filtered by exact street number
    """
    if _is_redfin_property_url(address_or_url):
        return address_or_url
    return _brave_first_url(
        address_or_url, "redfin.com",
        require_street_num=_street_number(address_or_url),
    )


def find_zillow_url(address_or_url: str) -> str | None:
    """Resolve to a Zillow property URL.

    Strategy:
      1. If the input is already a Zillow homedetails URL, return it.
      2. Slug the address and hit /homes/<slug>/. Zillow 301-redirects
         exact-address slugs to the canonical /homedetails/<zpid>_zpid/ page.
         No Brave needed; works on active AND off-market listings.
      3. Fall back to Brave with street-number filter as last resort.
    """
    if _is_zillow_property_url(address_or_url):
        return address_or_url
    # Direct redirect path (zero search-engine dependency)
    slug = _zillow_slug(address_or_url)
    if slug:
        try:
            s = zillow._get_session()
            url = f"https://www.zillow.com/homes/{slug}/"
            r = s.get(url, timeout=20, allow_redirects=False)
            loc = r.headers.get("Location") or r.headers.get("location")
            if loc:
                if loc.startswith("/"):
                    loc = "https://www.zillow.com" + loc
                if _is_zillow_property_url(loc):
                    return loc
                # Two-hop: /homedetails/<zpid>_zpid/ -> with full slug
                if "/homedetails/" in loc:
                    r2 = s.get(loc, timeout=20, allow_redirects=False)
                    loc2 = r2.headers.get("Location") or r2.headers.get("location")
                    if loc2 and _is_zillow_property_url(loc2):
                        return loc2 if loc2.startswith("http") else "https://www.zillow.com" + loc2
                    return loc
        except Exception:
            pass  # fall through to Brave
    return _brave_first_url(
        address_or_url, "zillow.com",
        require_street_num=_street_number(address_or_url),
    )


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


def lookup(address: str, *, include_raw: bool = False,
           redfin_url: str | None = None, zillow_url: str | None = None) -> dict:
    """Address (or URLs) -> all the data, both sites, merged.

    Caller can short-circuit resolution by passing one or both URLs
    directly via redfin_url / zillow_url. Useful when Brave's index
    doesn't have the exact listing (common for new builds, off-MLS, or
    just-listed homes) but the user knows the canonical URL.

    Errors per source are caught and surfaced as {"error": ...} so a
    Zillow failure doesn't block the Redfin half.
    """
    rf_url = redfin_url or find_redfin_url(address)
    zw_url = zillow_url or find_zillow_url(address)

    rf: dict
    if not rf_url:
        rf = {"error": (
            "no exact Redfin URL found via Brave (street number not in top results). "
            "Pass --redfin-url <url> if you have it."
        )}
    else:
        try:
            rf = redfin.property_details(rf_url, include_raw=include_raw)
        except Exception as e:
            rf = {"error": str(e), "url": rf_url}

    zw: dict
    if not zw_url:
        zw = {"error": (
            "no exact Zillow URL found via Brave. Pass --zillow-url <url> if you have it."
        )}
    else:
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
    ap.add_argument("address", help='free-text address, OR a Redfin/Zillow URL')
    ap.add_argument("--include-raw", action="store_true",
                    help="include the full nested API payloads from each source")
    ap.add_argument("--merged-only", action="store_true",
                    help="print only the merged view, not the per-source dumps")
    ap.add_argument("--redfin-url", help="skip Brave; use this Redfin property URL directly")
    ap.add_argument("--zillow-url", help="skip Brave; use this Zillow property URL directly")
    args = ap.parse_args(argv)

    result = lookup(
        args.address, include_raw=args.include_raw,
        redfin_url=args.redfin_url, zillow_url=args.zillow_url,
    )
    if args.merged_only:
        out = result["merged"]
    else:
        out = result
    json.dump(out, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()

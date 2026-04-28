"""Redfin scraper using public HTML pages.

Redfin's WAF (CloudFront) blocks direct hits to /stingray/do/* and
/stingray/api/home/details/* but lets the public HTML pages through. Those
pages are server-rendered and embed every API response Redfin's React app
needs into a `reactServerState.InitialContext` <script> blob, including the
XSSI-prefixed JSON we'd otherwise call directly.

So the strategy is:
  1. GET the HTML page humans visit (city / zipcode / property URL).
  2. Pull the InitialContext JSON.
  3. Reach into `ReactServerAgent.cache.dataCache[<key>].res.text`, strip the
     `{}&&` XSSI guard, parse the inner JSON.
  4. Fall through to the gis-csv/gis JSON endpoints (NOT WAF-blocked) when
     the cache entry isn't there.

Region resolution (free-text -> region_id, region_type) goes through the
brave-search skill: query "site:redfin.com <city>" and parse the URL path.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any
from urllib.parse import quote, urlparse

from curl_cffi import requests as curl_requests

XSSI_PREFIX = "{}&&"
BASE = "https://www.redfin.com"
DEFAULT_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.redfin.com/",
}
INITIAL_CTX_RE = re.compile(
    r"reactServerState\.InitialContext\s*=\s*(\{.*?\});", re.DOTALL
)
# city URLs look like /city/<id>/<state>/<name>
CITY_URL_RE = re.compile(r"/city/(\d+)/([A-Z]{2})/([^/]+)")
# zip URLs like /zipcode/78704
ZIP_URL_RE = re.compile(r"/zipcode/(\d+)")
# neighborhood URLs like /neighborhood/<id>/...
NEIGHBORHOOD_URL_RE = re.compile(r"/neighborhood/(\d+)/")

# Region type IDs Redfin's GIS endpoint uses (NOT the autocomplete IDs).
GIS_REGION_TYPE = {"city": 6, "zip": 2, "neighborhood": 1, "county": 5, "state": 4}

# Property URL: /TX/Austin/2403-E-2nd-St-78702/home/29841515
PROPERTY_URL_RE = re.compile(r"/[A-Z]{2}/[^/]+/[^/]+/home/(\d+)")


_session: curl_requests.Session | None = None


def _get_session() -> curl_requests.Session:
    """Return a warmed session. We hit the homepage once to acquire cookies."""
    global _session
    if _session is None:
        s = curl_requests.Session(impersonate="chrome131")
        s.get(BASE + "/", headers=DEFAULT_HEADERS, timeout=20)
        _session = s
    return _session


def _fetch_html(url: str) -> str:
    s = _get_session()
    r = s.get(url, headers=DEFAULT_HEADERS, timeout=25)
    if r.status_code != 200:
        raise RuntimeError(f"redfin GET {url} -> HTTP {r.status_code}: {r.text[:200]}")
    return r.text


def _initial_context(html: str) -> dict:
    m = INITIAL_CTX_RE.search(html)
    if not m:
        raise RuntimeError("redfin: reactServerState.InitialContext not in HTML; layout changed?")
    return json.loads(m.group(1))


def _cache_entry(ctx: dict, path_prefix: str) -> dict | None:
    """Pull the parsed body of a cached API response by URL path prefix."""
    cache = (ctx.get("ReactServerAgent.cache") or {}).get("dataCache") or {}
    for key, entry in cache.items():
        if not key.startswith(path_prefix):
            continue
        text = ((entry.get("res") or {}).get("text")) or ""
        if text.startswith(XSSI_PREFIX):
            text = text[len(XSSI_PREFIX):]
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            continue
    return None


# ---------------------------------------------------------------------------
# Region resolution
# ---------------------------------------------------------------------------

def _brave_search_first_redfin_url(query: str) -> str | None:
    """Use the brave-search skill to find the Redfin URL for a query.

    Resolves the brave-search shell script relative to this skill's location
    (../../brave-search/search.sh under _core/skills/) so the path stays
    valid even if the QUANTUM repo is moved or the user changes.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    brave = os.path.normpath(os.path.join(here, "..", "..", "brave-search", "search.sh"))
    if not os.path.exists(brave):
        return None
    q = f"site:redfin.com {query}"
    try:
        out = subprocess.check_output([brave, q, "5"], timeout=20).decode()
    except Exception:
        return None
    try:
        data = json.loads(out)
    except Exception:
        return None
    results = (data.get("web") or {}).get("results") or data.get("results") or []
    for r in results:
        url = r.get("url") or ""
        # Prefer city/<id>/.../houses-for-sale URLs
        if CITY_URL_RE.search(url) or ZIP_URL_RE.search(url):
            return url
    if results:
        return results[0].get("url")
    return None


def resolve_region(query: str) -> dict:
    """Return {region_id, region_type, url, path} for a free-text query.

    Resolution order:
      1. If `query` already looks like a Redfin URL or path, parse it.
      2. Else, ask Brave for `site:redfin.com <query>` and pick the first
         /city/<id>, /zipcode/<id>, or /neighborhood/<id> URL.
    """
    # Direct URL or path
    looks_like_url = query.startswith("http") or query.startswith("/")
    candidate = query if looks_like_url else None
    if candidate is None:
        candidate = _brave_search_first_redfin_url(query)
    if not candidate:
        raise RuntimeError(
            f"redfin: could not resolve {query!r}; pass a Redfin URL or check brave-search auth"
        )
    path = urlparse(candidate).path or candidate
    if m := CITY_URL_RE.search(path):
        return {"region_id": int(m.group(1)), "region_type": GIS_REGION_TYPE["city"],
                "kind": "city", "state": m.group(2), "name": m.group(3),
                "url": BASE + f"/city/{m.group(1)}/{m.group(2)}/{m.group(3)}"}
    if m := ZIP_URL_RE.search(path):
        return {"region_id": int(m.group(1)), "region_type": GIS_REGION_TYPE["zip"],
                "kind": "zip", "url": BASE + f"/zipcode/{m.group(1)}"}
    if m := NEIGHBORHOOD_URL_RE.search(path):
        return {"region_id": int(m.group(1)), "region_type": GIS_REGION_TYPE["neighborhood"],
                "kind": "neighborhood", "url": BASE + path}
    raise RuntimeError(f"redfin: URL {candidate!r} doesn't match a known region pattern")


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def _build_filter_segment(*, max_price=None, min_price=None, min_beds=None,
                          min_baths=None, min_sqft=None, home_types=None) -> str | None:
    parts = []
    if home_types:
        parts.append("property-type=" + ",".join(home_types))
    if max_price is not None:
        parts.append(f"max-price={_money(max_price)}")
    if min_price is not None:
        parts.append(f"min-price={_money(min_price)}")
    if min_beds is not None:
        parts.append(f"min-beds={min_beds}")
    if min_baths is not None:
        parts.append(f"min-baths={min_baths}")
    if min_sqft is not None:
        parts.append(f"min-sqft={min_sqft}")
    return "/filter/" + ",".join(parts) if parts else ""


def _money(n: int) -> str:
    if n >= 1_000_000 and n % 1_000_000 == 0:
        return f"{n // 1_000_000}m"
    if n >= 1_000 and n % 1_000 == 0:
        return f"{n // 1_000}k"
    return str(n)


def search(
    query: str,
    *,
    max_price: int | None = None,
    min_price: int | None = None,
    min_beds: int | None = None,
    min_baths: float | None = None,
    min_sqft: int | None = None,
    home_types: list[str] | None = None,
    num_homes: int = 50,
    region_id: int | None = None,
    region_type: int | None = None,
) -> dict:
    if region_id is not None and region_type is not None:
        # Manual override: skip Brave + the HTML-parse path. We don't know the
        # state/city slug to build the canonical URL, so go straight to the
        # gis-csv endpoint (which only needs the numeric IDs).
        region = {
            "region_id": int(region_id),
            "region_type": int(region_type),
            "kind": {6: "city", 2: "zip", 1: "neighborhood",
                     5: "county", 4: "state"}.get(int(region_type), "region"),
            "url": None,
        }
        return _search_via_gis(
            region, num_homes=num_homes,
            max_price=max_price, min_price=min_price,
            min_beds=min_beds, min_baths=min_baths,
            min_sqft=min_sqft, home_types=home_types,
        )
    region = resolve_region(query)
    filter_seg = _build_filter_segment(
        max_price=max_price, min_price=min_price, min_beds=min_beds,
        min_baths=min_baths, min_sqft=min_sqft, home_types=home_types,
    )
    url = region["url"] + (filter_seg or "")
    html = _fetch_html(url)
    ctx = _initial_context(html)
    # Listings live in the cached /stingray/api/gis response, not /api/region.
    gis_resp = _cache_entry(ctx, "/stingray/api/gis?")
    if not gis_resp:
        return _search_via_gis(region, num_homes=num_homes,
                               max_price=max_price, min_price=min_price,
                               min_beds=min_beds, min_baths=min_baths,
                               min_sqft=min_sqft, home_types=home_types)
    homes = ((gis_resp.get("payload") or {}).get("homes")) or []
    return {
        "source": "redfin",
        "query": query,
        "region": region,
        "url": url,
        "count": len(homes),
        "homes": [_summarize_home(h) for h in homes][:num_homes],
    }


_HT_NAME_TO_UIPT = {
    "house": "1", "condo": "2", "townhouse": "3",
    "multi-family": "4", "multi": "4", "land": "5",
    "other": "6", "mobile": "7", "coop": "8",
}


def _search_via_gis(region: dict, **kw) -> dict:
    """Fallback path: /stingray/api/gis-csv.

    The `market` param is informational only when `region_id` + `region_type`
    are supplied; results scope to the region. We omit it rather than
    hardcoding a city, which used to cause cross-city contamination.
    """
    s = _get_session()
    raw_types = kw.get("home_types") or []
    uipts = [_HT_NAME_TO_UIPT.get(t, t) for t in raw_types]
    if not uipts:
        uipts = ["1", "2", "3", "4", "5", "6", "7", "8"]
    params = {
        "al": 1, "num_homes": min(kw.get("num_homes", 50), 450),
        "ord": "redfin-recommended-asc", "page_number": 1,
        "region_id": region["region_id"], "region_type": region["region_type"],
        "sf": "1,2,3,5,6,7", "status": 9,
        "uipt": ",".join(uipts),
        "v": 8,
    }
    if kw.get("max_price") is not None:
        params["max_price"] = kw["max_price"]
    if kw.get("min_price") is not None:
        params["min_price"] = kw["min_price"]
    if kw.get("min_beds") is not None:
        params["num_beds"] = kw["min_beds"]
    if kw.get("min_baths") is not None:
        params["num_baths"] = kw["min_baths"]
    if kw.get("min_sqft") is not None:
        params["min_sqft"] = kw["min_sqft"]
    r = s.get(BASE + "/stingray/api/gis-csv", params=params,
              headers={**DEFAULT_HEADERS, "Accept": "text/csv"}, timeout=25)
    if r.status_code != 200:
        raise RuntimeError(f"redfin gis-csv -> HTTP {r.status_code}: {r.text[:200]}")
    rows = _parse_csv(r.text)
    return {
        "source": "redfin",
        "query": region.get("name") or region.get("url"),
        "region": region,
        "url": r.url,
        "count": len(rows),
        "homes": rows,
    }


def _parse_csv(text: str) -> list[dict]:
    import csv
    import io
    reader = csv.DictReader(io.StringIO(text))
    out = []
    for row in reader:
        # Redfin slips a "In accordance with local MLS rules..." disclaimer
        # row into the CSV that DictReader parses as a row with all-empty
        # values past the first column. Skip rows without an address.
        if not (row.get("ADDRESS") or "").strip():
            continue
        # Normalize a few columns to friendlier names.
        out.append({
            "address": row.get("ADDRESS"),
            "city": row.get("CITY"),
            "state": row.get("STATE OR PROVINCE"),
            "zip": row.get("ZIP OR POSTAL CODE"),
            "price": _to_int(row.get("PRICE")),
            "beds": _to_int(row.get("BEDS")),
            "baths": _to_float(row.get("BATHS")),
            "sqft": _to_int(row.get("SQUARE FEET")),
            "lot_size": _to_int(row.get("LOT SIZE")),
            "year_built": _to_int(row.get("YEAR BUILT")),
            "url": row.get("URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING)") or row.get("URL"),
            "status": row.get("STATUS"),
            "property_type": row.get("PROPERTY TYPE"),
            "days_on_market": _to_int(row.get("DAYS ON MARKET")),
            "hoa_per_month": _to_int(row.get("HOA/MONTH")),
            "price_per_sqft": _to_float(row.get("$/SQUARE FEET")),
        })
    return out


def _to_int(v):
    """Coerce a CSV value to int, tolerating currency symbols and commas."""
    if v in (None, ""):
        return None
    if isinstance(v, str):
        v = v.replace("$", "").replace(",", "").strip()
        if not v:
            return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _to_float(v):
    if v in (None, ""):
        return None
    if isinstance(v, str):
        v = v.replace("$", "").replace(",", "").strip()
        if not v:
            return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


_PROPERTY_TYPE_BY_CODE = {
    1: "single-family", 2: "condo", 3: "townhouse",
    4: "multi-family", 5: "land", 6: "other",
    7: "mobile", 8: "co-op",
}


def _summarize_home(h: dict) -> dict:
    """Flatten a Redfin GIS-API home into the same shape used by the CSV path.

    Both paths produce dicts with: address, city, state, zip, price, beds,
    baths, sqft, lot_size, year_built, url, status, days_on_market,
    property_type, hoa_per_month, price_per_sqft. JSON-only extras
    (mls_id, property_id, listing_id) are nullable on the CSV side.
    """
    addr = h.get("streetLine") or {}
    price = h.get("price") or {}
    hoa = h.get("hoa") or {}
    code = h.get("propertyType")
    return {
        "mls_id": h.get("mlsId"),
        "property_id": h.get("propertyId"),
        "listing_id": h.get("listingId"),
        "address": addr.get("value") if isinstance(addr, dict) else h.get("streetLine"),
        "city": h.get("city"),
        "state": (h.get("state") or {}).get("value") if isinstance(h.get("state"), dict) else h.get("state"),
        "zip": h.get("zip"),
        "price": price.get("value") if isinstance(price, dict) else price,
        "price_per_sqft": (h.get("pricePerSqFt") or {}).get("value") if isinstance(h.get("pricePerSqFt"), dict) else h.get("pricePerSqFt"),
        "beds": h.get("beds"),
        "baths": h.get("baths"),
        "sqft": (h.get("sqFt") or {}).get("value") if isinstance(h.get("sqFt"), dict) else h.get("sqFt"),
        "lot_size": (h.get("lotSize") or {}).get("value") if isinstance(h.get("lotSize"), dict) else h.get("lotSize"),
        "year_built": (h.get("yearBuilt") or {}).get("value") if isinstance(h.get("yearBuilt"), dict) else h.get("yearBuilt"),
        "hoa_per_month": hoa.get("value") if isinstance(hoa, dict) else hoa,
        "url": f"{BASE}{h.get('url')}" if h.get("url") and not h.get("url", "").startswith("http") else h.get("url"),
        "status": h.get("mlsStatus"),
        "listing_type": h.get("listingType"),
        "property_type": _PROPERTY_TYPE_BY_CODE.get(code) if isinstance(code, int) else None,
        "days_on_market": (h.get("timeOnRedfin") or {}).get("days") if isinstance(h.get("timeOnRedfin"), dict) else None,
    }


# ---------------------------------------------------------------------------
# Property
# ---------------------------------------------------------------------------

def property_details(url_or_path: str, *, include_raw: bool = False) -> dict:
    if not url_or_path.startswith("http"):
        url_or_path = BASE + (url_or_path if url_or_path.startswith("/") else "/" + url_or_path)
    html = _fetch_html(url_or_path)
    ctx = _initial_context(html)

    initial = _cache_entry(ctx, "/stingray/api/home/details/initialInfo") or {}
    above = _cache_entry(ctx, "/stingray/api/home/details/aboveTheFold") or {}
    # Note: belowTheFold lives at the v1 path on property pages.
    below = (_cache_entry(ctx, "/stingray/api/v1/home/details/belowTheFold")
             or _cache_entry(ctx, "/stingray/api/home/details/belowTheFold")
             or {})
    avm = _cache_entry(ctx, "/stingray/api/home/details/avm") or {}
    rental = _cache_entry(ctx, "/stingray/api/home/details/rental-estimate") or {}
    similars = _cache_entry(ctx, "/stingray/api/home/details/similars/listings") or {}
    schools = (_cache_entry(ctx, "/stingray/api/v1/home/details/belowTheFold/schoolsAndDistrictsInfo")
               or {})
    risk = _cache_entry(ctx, "/stingray/api/v1/home/details/belowTheFold/riskFactorData") or {}

    p_initial = initial.get("payload") or {}
    p_above = above.get("payload") or {}
    p_below = below.get("payload") or {}
    p_avm = avm.get("payload") or {}

    asi = p_above.get("addressSectionInfo") or {}
    history_events = ((p_below.get("propertyHistoryInfo") or {}).get("events")) or []
    public_records = p_below.get("publicRecordsInfo") or {}

    out = {
        "source": "redfin",
        "url": url_or_path,
        "property_id": p_initial.get("propertyId"),
        "listing_id": p_initial.get("listingId"),
        "status": (asi.get("status") or {}).get("displayValue"),
        "address": (asi.get("streetAddress") or {}).get("assembledAddress"),
        "city": asi.get("city"),
        "state": asi.get("state"),
        "zip": asi.get("zip"),
        "lat_long": asi.get("latLong"),
        "price": (asi.get("priceInfo") or {}).get("amount"),
        "price_per_sqft": asi.get("pricePerSqFt"),
        "beds": asi.get("beds"),
        "baths": asi.get("baths"),
        "sqft": (asi.get("sqFt") or {}).get("value"),
        "year_built": asi.get("yearBuilt"),
        "lot_size": asi.get("lotSize"),
        "property_type_code": asi.get("propertyType"),
        "redfin_estimate": p_avm.get("predictedValue") or (p_avm.get("predictedPrice") or {}).get("amount"),
        "rent_estimate": (rental.get("payload") or {}).get("predictedValue"),
        "history": history_events,
        "public_records": public_records,
        "schools": (schools.get("payload") or {}).get("schools") or [],
        "risk_factors": (risk.get("payload") or {}),
        "comps": _summarize_comps(similars),
        "amenities": p_below.get("amenitiesInfo") or {},
    }
    if include_raw:
        out["raw"] = {
            "initial": p_initial, "above": p_above, "below": p_below,
            "avm": p_avm, "similars": similars,
        }
    return out


def _summarize_comps(similars: dict) -> list[dict]:
    homes = ((similars.get("payload") or {}).get("homes")) or []
    return [_summarize_home(h) for h in homes][:20]


def price_history(url_or_path: str) -> list[dict]:
    return property_details(url_or_path).get("history") or []


def comps(url_or_path: str) -> list[dict]:
    return property_details(url_or_path).get("comps") or []


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _print(obj):
    json.dump(obj, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="redfin")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("resolve", help="resolve a query to a region")
    sp.add_argument("query")

    sp = sub.add_parser("search", help="search listings in a city / zip / neighborhood")
    sp.add_argument("query")
    sp.add_argument("--max-price", type=int)
    sp.add_argument("--min-price", type=int)
    sp.add_argument("--min-beds", type=int)
    sp.add_argument("--min-baths", type=float)
    sp.add_argument("--min-sqft", type=int)
    sp.add_argument("--home-types", help="comma-separated: house,condo,townhouse,multi-family,land,mobile,coop")
    sp.add_argument("--num-homes", type=int, default=50)
    sp.add_argument("--region-id", type=int, help="manual override; pair with --region-type")
    sp.add_argument("--region-type", type=int, help="6=city, 2=zip, 1=neighborhood, 5=county, 4=state")

    sp = sub.add_parser("property", help="full details for a single listing")
    sp.add_argument("url")
    sp.add_argument("--include-raw", action="store_true", help="include the full nested API payloads")

    sp = sub.add_parser("history", help="price/listing history for a property")
    sp.add_argument("url")

    sp = sub.add_parser("comps", help="comparable / similar listings for a property")
    sp.add_argument("url")

    args = ap.parse_args(argv)

    if args.cmd == "resolve":
        _print(resolve_region(args.query))
    elif args.cmd == "search":
        # Public-URL filter slugs that Redfin's /city/.../filter/ path expects.
        # `_search_via_gis` translates these to numeric `uipt` IDs internally.
        ht = None
        if args.home_types:
            ht = [t.strip() for t in args.home_types.split(",") if t.strip()]
        _print(search(
            args.query,
            max_price=args.max_price, min_price=args.min_price,
            min_beds=args.min_beds, min_baths=args.min_baths,
            min_sqft=args.min_sqft, home_types=ht, num_homes=args.num_homes,
            region_id=args.region_id, region_type=args.region_type,
        ))
    elif args.cmd == "property":
        _print(property_details(args.url, include_raw=args.include_raw))
    elif args.cmd == "history":
        _print(price_history(args.url))
    elif args.cmd == "comps":
        _print(comps(args.url))


if __name__ == "__main__":
    main()

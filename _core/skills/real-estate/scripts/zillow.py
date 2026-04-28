"""Zillow scraper using browser TLS impersonation + their internal endpoints.

Zillow is harder than Redfin (PerimeterX + Cloudflare). curl_cffi alone with
`impersonate="chrome"` clears the basic TLS/JA3 checks; we still get blocked
at high volume. Strategy:

* Search uses Zillow's `async-create-search-page-state` POST endpoint, which
  the web UI itself calls. Returns JSON with `cat1.searchResults.listResults`.
* Property pages: GET the home detail HTML, extract the `__NEXT_DATA__` JSON
  blob, walk into `props.pageProps.componentProps.gdpClientCache`.

This will break occasionally when Zillow changes their schema. Throttle to
keep volume well below detection thresholds.
"""
from __future__ import annotations

import json
import re
import sys
import time
from typing import Any
from urllib.parse import quote, urlparse

from curl_cffi import requests

BASE = "https://www.zillow.com"
DEFAULT_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.zillow.com/",
    "Origin": "https://www.zillow.com",
}
NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
    re.DOTALL,
)


def _bbox_for_query(query: str) -> dict | None:
    """Resolve a free-text region into a Zillow map bounding box.

    Uses the homepage autocomplete endpoint which returns lat/lng plus a
    region id. We expand into a small bbox the search endpoint accepts.
    """
    url = f"{BASE}/zg-graph"
    body = {
        "operationName": "RegionsSearchQuery",
        "variables": {"input": {"phrase": query, "queryOptions": {"resultType": ["REGION"]}}},
        "query": (
            "query RegionsSearchQuery($input: RegionSearchInput!) {"
            " regionsSearch(input: $input) { regions { regionId display regionType } } }"
        ),
    }
    r = requests.post(url, json=body, headers=DEFAULT_HEADERS, impersonate="chrome", timeout=20)
    if r.status_code != 200:
        return None
    try:
        data = r.json()
    except Exception:
        return None
    regs = (((data.get("data") or {}).get("regionsSearch") or {}).get("regions")) or []
    return regs[0] if regs else None


def search(
    query: str,
    *,
    max_price: int | None = None,
    min_price: int | None = None,
    min_beds: int | None = None,
    min_baths: float | None = None,
    page: int = 1,
) -> dict:
    """Search Zillow listings via their async page-state endpoint.

    The endpoint accepts a `searchQueryState` blob identical to the URL
    fragment Zillow's frontend pushes into the address bar.
    """
    region = _bbox_for_query(query)
    region_selection: list[dict[str, int]] = []
    if region and region.get("regionId"):
        region_selection = [{"regionId": int(region["regionId"]), "regionType": _zillow_region_type(region.get("regionType"))}]

    filter_state: dict[str, Any] = {
        "sortSelection": {"value": "globalrelevanceex"},
        "isAllHomes": {"value": True},
    }
    if max_price is not None:
        filter_state["price"] = {"max": max_price}
        filter_state["monthlyPayment"] = {"max": int(max_price / 200)}  # rough mapping Zillow uses
    if min_price is not None:
        filter_state.setdefault("price", {})["min"] = min_price
    if min_beds is not None:
        filter_state["beds"] = {"min": min_beds}
    if min_baths is not None:
        filter_state["baths"] = {"min": min_baths}

    sqs = {
        "pagination": {"currentPage": page},
        "usersSearchTerm": query,
        "filterState": filter_state,
        "isListVisible": True,
    }
    if region_selection:
        sqs["regionSelection"] = region_selection

    body = {
        "searchQueryState": sqs,
        "wants": {"cat1": ["listResults"], "cat2": ["total"]},
        "requestId": 2,
        "isDebugRequest": False,
    }
    url = f"{BASE}/async-create-search-page-state"
    r = requests.put(url, json=body, headers=DEFAULT_HEADERS, impersonate="chrome", timeout=25)
    if r.status_code != 200:
        raise RuntimeError(f"zillow search -> HTTP {r.status_code}: {r.text[:200]}")
    data = r.json()
    list_results = ((data.get("cat1") or {}).get("searchResults") or {}).get("listResults") or []
    homes = [_summarize(h) for h in list_results]
    return {
        "source": "zillow",
        "query": query,
        "region_id": (region or {}).get("regionId"),
        "region_type": (region or {}).get("regionType"),
        "count": len(homes),
        "homes": homes,
    }


def _zillow_region_type(name: str | None) -> int:
    return {
        "STATE": 2,
        "COUNTY": 4,
        "CITY": 6,
        "NEIGHBORHOOD": 7,
        "ZIPCODE": 7,
        "ZIP": 7,
    }.get((name or "").upper(), 6)


def _summarize(h: dict) -> dict:
    return {
        "zpid": h.get("zpid"),
        "address": h.get("address") or h.get("addressStreet"),
        "city": h.get("addressCity"),
        "state": h.get("addressState"),
        "zip": h.get("addressZipcode"),
        "price": h.get("unformattedPrice") or h.get("price"),
        "beds": h.get("beds"),
        "baths": h.get("baths"),
        "sqft": h.get("area"),
        "url": h.get("detailUrl") if (h.get("detailUrl") or "").startswith("http") else (BASE + h["detailUrl"]) if h.get("detailUrl") else None,
        "status": h.get("statusType"),
        "listing_status": h.get("listingType"),
        "zestimate": (h.get("hdpData") or {}).get("homeInfo", {}).get("zestimate") if isinstance(h.get("hdpData"), dict) else None,
        "rent_zestimate": (h.get("hdpData") or {}).get("homeInfo", {}).get("rentZestimate") if isinstance(h.get("hdpData"), dict) else None,
    }


def property_details(url: str) -> dict:
    """Fetch a Zillow homedetails page and return parsed property JSON."""
    if not url.startswith("http"):
        url = BASE + url
    r = requests.get(url, headers=DEFAULT_HEADERS, impersonate="chrome", timeout=25)
    if r.status_code != 200:
        raise RuntimeError(f"zillow property -> HTTP {r.status_code}: {r.text[:200]}")
    m = NEXT_DATA_RE.search(r.text)
    if not m:
        raise RuntimeError("zillow property: __NEXT_DATA__ not found, page layout may have changed")
    raw = json.loads(m.group(1))
    cache = (((raw.get("props") or {}).get("pageProps") or {}).get("componentProps") or {}).get("gdpClientCache")
    if not cache:
        return {"source": "zillow", "url": url, "raw_next_data": raw}
    cache_obj = json.loads(cache) if isinstance(cache, str) else cache
    home = next(iter(cache_obj.values()), {}) if isinstance(cache_obj, dict) else {}
    prop = (home or {}).get("property") or home
    return {
        "source": "zillow",
        "url": url,
        "zpid": prop.get("zpid"),
        "address": prop.get("address"),
        "price": prop.get("price"),
        "zestimate": prop.get("zestimate"),
        "rent_zestimate": prop.get("rentZestimate"),
        "beds": prop.get("bedrooms"),
        "baths": prop.get("bathrooms"),
        "sqft": prop.get("livingArea"),
        "year_built": prop.get("yearBuilt"),
        "lot_size": prop.get("lotSize"),
        "home_type": prop.get("homeType"),
        "description": prop.get("description"),
        "raw": prop,
    }


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(prog="zillow", description="Zillow internal-endpoint CLI.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("search")
    sp.add_argument("query")
    sp.add_argument("--max-price", type=int)
    sp.add_argument("--min-price", type=int)
    sp.add_argument("--min-beds", type=int)
    sp.add_argument("--min-baths", type=float)
    sp.add_argument("--page", type=int, default=1)

    sp = sub.add_parser("property")
    sp.add_argument("url")

    args = ap.parse_args()
    if args.cmd == "search":
        print(json.dumps(search(
            args.query,
            max_price=args.max_price,
            min_price=args.min_price,
            min_beds=args.min_beds,
            min_baths=args.min_baths,
            page=args.page,
        ), indent=2))
    elif args.cmd == "property":
        print(json.dumps(property_details(args.url), indent=2))

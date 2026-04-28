"""Zillow scraper using public HTML pages.

Zillow runs PerimeterX + Cloudflare. Direct calls to their internal
`async-create-search-page-state` and home-details JSON endpoints get
captcha-walled even with browser TLS impersonation. The public HTML pages
are friendlier:

  * Search pages (e.g. /austin-tx/, /homes/Austin-TX_rb/) embed the full
    listing array under `__NEXT_DATA__.props.pageProps.searchPageState`.
  * Property pages embed structured data under
    `__NEXT_DATA__.props.pageProps.componentProps.gdpClientCache` (a
    JSON-encoded blob keyed by GraphQL query+variables).

Empirically, curl_cffi's `chrome124` impersonation profile clears
PerimeterX where `chrome131`/`chrome120` get 403'd. Throttle requests and
warm the session with a homepage GET so PX issues a `_pxvid` cookie.

Region resolution: we don't bother with autocomplete (PX-walled). Instead
we accept either:
  * a direct Zillow URL ("https://www.zillow.com/austin-tx/"), or
  * a free-text query that we slugify into the canonical city URL pattern
    "/<city-slug>-<state-abbrev>/" (e.g. "Austin, TX" -> "/austin-tx/").
"""
from __future__ import annotations

import json
import re
import sys
import time
from typing import Any
from urllib.parse import quote, urlparse

from curl_cffi import requests as curl_requests

BASE = "https://www.zillow.com"
DEFAULT_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.zillow.com/",
}
NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
    re.DOTALL,
)
STATE_ABBREVS = {
    "alabama": "al", "alaska": "ak", "arizona": "az", "arkansas": "ar",
    "california": "ca", "colorado": "co", "connecticut": "ct", "delaware": "de",
    "florida": "fl", "georgia": "ga", "hawaii": "hi", "idaho": "id",
    "illinois": "il", "indiana": "in", "iowa": "ia", "kansas": "ks",
    "kentucky": "ky", "louisiana": "la", "maine": "me", "maryland": "md",
    "massachusetts": "ma", "michigan": "mi", "minnesota": "mn", "mississippi": "ms",
    "missouri": "mo", "montana": "mt", "nebraska": "ne", "nevada": "nv",
    "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
    "north carolina": "nc", "north dakota": "nd", "ohio": "oh", "oklahoma": "ok",
    "oregon": "or", "pennsylvania": "pa", "rhode island": "ri", "south carolina": "sc",
    "south dakota": "sd", "tennessee": "tn", "texas": "tx", "utah": "ut",
    "vermont": "vt", "virginia": "va", "washington": "wa", "west virginia": "wv",
    "wisconsin": "wi", "wyoming": "wy", "district of columbia": "dc",
}

_session: curl_requests.Session | None = None


def _get_session() -> curl_requests.Session:
    global _session
    if _session is None:
        s = curl_requests.Session(impersonate="chrome124")
        s.get(BASE + "/", headers=DEFAULT_HEADERS, timeout=20)
        _session = s
    return _session


def _fetch_html(url: str) -> str:
    s = _get_session()
    r = s.get(url, headers=DEFAULT_HEADERS, timeout=25)
    if r.status_code == 403 or "px-captcha" in r.text[:1000]:
        raise RuntimeError(f"zillow GET {url} -> PX captcha (HTTP {r.status_code}). Throttle, change impersonation, or fall back to a browser.")
    if r.status_code != 200:
        raise RuntimeError(f"zillow GET {url} -> HTTP {r.status_code}: {r.text[:200]}")
    return r.text


def _next_data(html: str) -> dict:
    m = NEXT_DATA_RE.search(html)
    if not m:
        raise RuntimeError("zillow: __NEXT_DATA__ not found; layout may have changed")
    return json.loads(m.group(1))


# ---------------------------------------------------------------------------
# Region resolution
# ---------------------------------------------------------------------------

def _slugify_city_state(query: str) -> str | None:
    """Best-effort: 'Austin, TX' -> 'austin-tx', '78704' -> '78704'."""
    q = query.strip().lower()
    # Bare zip
    if q.isdigit() and len(q) == 5:
        return q
    # Already a slug ('austin-tx')
    if re.fullmatch(r"[a-z0-9-]+", q) and "-" in q:
        return q
    # 'city, state' or 'city state'
    m = re.match(r"([a-z .'-]+?)[, ]+([a-z .]+)$", q)
    if not m:
        return None
    city = re.sub(r"[^a-z0-9]+", "-", m.group(1)).strip("-")
    state = m.group(2).strip()
    state_abbr = STATE_ABBREVS.get(state, state if len(state) == 2 else None)
    if not state_abbr:
        return None
    return f"{city}-{state_abbr}"


def _city_url(query: str) -> str:
    """Return the canonical Zillow search URL for `query`.

    Uses the `/homes/<slug>_rb/` path. The `/austin-tx/` "city guide" path
    also works but ignores `searchQueryState` filters in some A/B variants;
    the `_rb` (results-board) path is the one Zillow's frontend uses for
    filtered queries.
    """
    if query.startswith("http"):
        return query
    if query.startswith("/"):
        return BASE + query
    slug = _slugify_city_state(query)
    if not slug:
        raise RuntimeError(
            f"zillow: cannot slugify {query!r}; pass a Zillow URL or 'City, ST' format"
        )
    return f"{BASE}/homes/{slug}_rb/"


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def search(
    query: str,
    *,
    max_price: int | None = None,
    min_price: int | None = None,
    min_beds: int | None = None,
    min_baths: float | None = None,
    page: int = 1,
) -> dict:
    """Search Zillow by free-text region.

    Filtering goes through `searchQueryState` querystring, which Zillow's
    frontend builds. Critical detail: if `searchQueryState` lacks
    `mapBounds` + `regionSelection`, Zillow ignores the URL slug and falls
    back to a default region (often Austin in the US). So we do two GETs:

      1. Fetch the unfiltered city URL to discover the region's mapBounds
         and regionSelection from the rendered queryState.
      2. Re-fetch with the full state (bounds + region + filters).
    """
    url = _city_url(query)
    base_html = _fetch_html(url)
    base_data = _next_data(base_html)
    base_sps = (((base_data.get("props") or {}).get("pageProps") or {})
                .get("searchPageState") or {})
    base_qs = base_sps.get("queryState") or {}
    map_bounds = base_qs.get("mapBounds")
    region_selection = base_qs.get("regionSelection")
    if not map_bounds or not region_selection:
        # Region didn't resolve; return the unfiltered listings as-is so the
        # caller still gets something useful.
        listings = (base_sps.get("cat1") or {}).get("searchResults", {}).get("listResults") or []
        return _wrap_search(query, url, listings, base_sps)

    sqs = {
        "pagination": {"currentPage": page} if page > 1 else {},
        "mapBounds": map_bounds,
        "regionSelection": region_selection,
        "filterState": _filter_state(max_price, min_price, min_beds, min_baths),
        "isListVisible": True,
        "mapZoom": base_qs.get("mapZoom") or 11,
    }
    sep = "&" if "?" in url else "?"
    full_url = url + sep + "searchQueryState=" + quote(json.dumps(sqs, separators=(",", ":")))
    html = _fetch_html(full_url)
    data = _next_data(html)
    sps = ((data.get("props") or {}).get("pageProps") or {}).get("searchPageState") or {}
    listings = (sps.get("cat1") or {}).get("searchResults", {}).get("listResults") or []
    return _wrap_search(query, full_url, listings, sps)


def _wrap_search(query: str, url: str, listings: list, sps: dict) -> dict:
    homes = [_summarize_home(h) for h in listings]
    total = ((sps.get("cat1") or {}).get("totalResultCount")) or len(homes)
    return {
        "source": "zillow",
        "query": query,
        "url": url,
        "total_in_region": total,
        "count": len(homes),
        "homes": homes,
    }


def _filter_state(max_price, min_price, min_beds, min_baths) -> dict[str, Any]:
    fs: dict[str, Any] = {"sortSelection": {"value": "globalrelevanceex"},
                          "isAllHomes": {"value": True}}
    if max_price is not None or min_price is not None:
        price = {}
        if max_price is not None: price["max"] = max_price
        if min_price is not None: price["min"] = min_price
        fs["price"] = price
    if min_beds is not None:
        fs["beds"] = {"min": min_beds}
    if min_baths is not None:
        fs["baths"] = {"min": min_baths}
    return fs


def _summarize_home(h: dict) -> dict:
    hdp = h.get("hdpData") or {}
    home_info = (hdp.get("homeInfo") or {}) if isinstance(hdp, dict) else {}
    detail = h.get("detailUrl") or h.get("hdpUrl") or ""
    if detail and not detail.startswith("http"):
        detail = BASE + detail
    return {
        "zpid": h.get("zpid") or home_info.get("zpid"),
        "address": h.get("addressStreet") or h.get("address") or home_info.get("streetAddress"),
        "city": h.get("addressCity") or home_info.get("city"),
        "state": h.get("addressState") or home_info.get("state"),
        "zip": h.get("addressZipcode") or home_info.get("zipcode"),
        "price": h.get("unformattedPrice") or h.get("price") or home_info.get("price"),
        "beds": h.get("beds") or home_info.get("bedrooms"),
        "baths": h.get("baths") or home_info.get("bathrooms"),
        "sqft": h.get("area") or home_info.get("livingArea"),
        "lot_size": home_info.get("lotAreaValue"),
        "year_built": home_info.get("yearBuilt"),
        "url": detail,
        "status": h.get("statusType") or home_info.get("homeStatus"),
        "zestimate": home_info.get("zestimate"),
        "rent_zestimate": home_info.get("rentZestimate"),
        "tax_assessed_value": home_info.get("taxAssessedValue"),
        "home_type": home_info.get("homeType"),
        "lat": home_info.get("latitude") or h.get("latLong", {}).get("latitude"),
        "lng": home_info.get("longitude") or h.get("latLong", {}).get("longitude"),
    }


# ---------------------------------------------------------------------------
# Property
# ---------------------------------------------------------------------------

def property_details(url: str, *, include_raw: bool = False) -> dict:
    if not url.startswith("http"):
        url = BASE + (url if url.startswith("/") else "/" + url)
    html = _fetch_html(url)
    data = _next_data(html)
    pp = ((data.get("props") or {}).get("pageProps") or {})
    cp = pp.get("componentProps") or {}
    cache_raw = cp.get("gdpClientCache")
    if not cache_raw:
        # Sometimes Zillow stores it under componentProps.initialReduxState
        return {"source": "zillow", "url": url,
                "next_data_keys": list(pp.keys()),
                "raw": pp if include_raw else None}
    cache = json.loads(cache_raw) if isinstance(cache_raw, str) else cache_raw
    # gdpClientCache is keyed by GraphQL operation name + variables. The main
    # property payload sits under ForSaleShopperPlatformFullRenderQuery on
    # for-sale listings and OffMarketShopperPlatformRenderQuery on off-market
    # ones. Other keys (Comps*, School*, MortgageRates*) hold related data
    # we don't want to mistake for the property record.
    prop = {}
    if isinstance(cache, dict):
        primary_prefixes = (
            "ForSaleShopperPlatformFullRenderQuery",
            "OffMarketShopperPlatformRenderQuery",
            "VariantQuery",
            "ForSaleDoubleScrollFullRenderQuery",
        )
        for k, v in cache.items():
            if any(k.startswith(p) for p in primary_prefixes) and isinstance(v, dict) and v.get("property"):
                prop = v["property"]
                break
        if not prop:
            for v in cache.values():
                if isinstance(v, dict) and v.get("property"):
                    prop = v["property"]
                    break
    addr = prop.get("address") or {}

    out = {
        "source": "zillow",
        "url": url,
        "zpid": prop.get("zpid"),
        "address": prop.get("streetAddress") or addr.get("streetAddress"),
        "city": prop.get("city") or addr.get("city"),
        "state": prop.get("state") or addr.get("state"),
        "zip": prop.get("zipcode") or addr.get("zipcode"),
        "price": prop.get("price"),
        "zestimate": prop.get("zestimate"),
        "rent_zestimate": prop.get("rentZestimate"),
        "tax_assessed_value": prop.get("taxAssessedValue"),
        "tax_history": prop.get("taxHistory") or [],
        "price_history": prop.get("priceHistory") or [],
        "beds": prop.get("bedrooms"),
        "baths": prop.get("bathrooms"),
        "sqft": prop.get("livingArea"),
        "year_built": prop.get("yearBuilt"),
        "lot_size": prop.get("lotSize"),
        "lot_area_value": prop.get("lotAreaValue"),
        "home_type": prop.get("homeType"),
        "home_status": prop.get("homeStatus"),
        "description": prop.get("description"),
        "schools": prop.get("schools") or [],
        "annual_homeowners_insurance": prop.get("annualHomeownersInsurance"),
        "monthly_hoa_fee": prop.get("monthlyHoaFee"),
        "lat": prop.get("latitude") or addr.get("latitude"),
        "lng": prop.get("longitude") or addr.get("longitude"),
    }
    if include_raw:
        out["raw"] = prop
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _print(o):
    json.dump(o, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="zillow")
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

    args = ap.parse_args(argv)
    if args.cmd == "search":
        _print(search(
            args.query, max_price=args.max_price, min_price=args.min_price,
            min_beds=args.min_beds, min_baths=args.min_baths, page=args.page,
        ))
    elif args.cmd == "property":
        _print(property_details(args.url))


if __name__ == "__main__":
    main()

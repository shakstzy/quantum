"""Redfin scraper using internal stingray API endpoints.

These endpoints power Redfin's own web app. They are undocumented but stable
enough for personal use at low volume. JSON responses are prefixed with the
XSSI guard `{}&&` which is stripped before parsing.
"""
from __future__ import annotations

import json
import sys
import time
from typing import Any
from urllib.parse import quote, urlencode, urlparse

from curl_cffi import requests

XSSI_PREFIX = "{}&&"
BASE = "https://www.redfin.com"
DEFAULT_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.redfin.com/",
}


def _get(path: str, params: dict[str, Any] | None = None, impersonate: str = "chrome") -> Any:
    url = f"{BASE}{path}"
    r = requests.get(url, params=params, headers=DEFAULT_HEADERS, impersonate=impersonate, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"redfin {path} -> HTTP {r.status_code}: {r.text[:200]}")
    body = r.text
    if body.startswith(XSSI_PREFIX):
        body = body[len(XSSI_PREFIX):]
    try:
        return json.loads(body)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"redfin {path} -> non-JSON body: {body[:200]}") from e


def autocomplete(query: str) -> list[dict]:
    """Return location matches for a free-text query (city, zip, address)."""
    data = _get("/stingray/do/location-autocomplete", {"location": query, "v": "2"})
    sections = (data.get("payload") or {}).get("sections") or []
    out = []
    for s in sections:
        for row in s.get("rows") or []:
            out.append({
                "name": row.get("name"),
                "subName": row.get("subName"),
                "type": row.get("type"),
                "id": row.get("id"),
                "url": row.get("url"),
            })
    return out


def _resolve_region(query: str) -> tuple[str, str]:
    """Resolve a free-text query into (region_id, region_type) for /api/gis.

    Region type ids Redfin uses: 1=zip, 2=city, 4=county, 5=state, 6=neighborhood.
    The autocomplete response embeds these in the row's URL path, e.g.
    `/city/30818/TX/Austin`. We parse the URL.
    """
    matches = autocomplete(query)
    if not matches:
        raise RuntimeError(f"redfin: no autocomplete match for {query!r}")
    # Prefer city, then zip, then anything with an id+url.
    type_priority = {"2": 0, "1": 1, "6": 2, "4": 3, "5": 4}
    matches.sort(key=lambda m: type_priority.get(str(m.get("type")), 99))
    for m in matches:
        rid = m.get("id")
        url = m.get("url") or ""
        if not rid or not url:
            continue
        # url like /city/30818/TX/Austin, /zipcode/78704, /neighborhood/...
        parts = [p for p in url.split("/") if p]
        if not parts:
            continue
        kind = parts[0]
        type_map = {"zipcode": "2", "city": "6", "county": "5", "neighborhood": "1", "state": "4"}
        # Note: Redfin's `region_type` for the GIS endpoint maps differently than autocomplete `type`.
        # Empirically: 1=neighborhood, 2=zip, 5=county, 6=city. We invert to match GIS.
        gis_map = {"zipcode": "2", "city": "6", "county": "5", "neighborhood": "1", "state": "4"}
        rtype = gis_map.get(kind)
        if rtype:
            return str(rid), rtype
    raise RuntimeError(f"redfin: could not resolve region for {query!r}")


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
) -> dict:
    """Search listings by city / zip / neighborhood. Returns JSON with `homes` list."""
    region_id, region_type = _resolve_region(query)
    # Mirror the params Redfin's web UI sends. `al=1` means "active listings",
    # `market=austin` is autodetected server-side, `num_homes` capped ~450.
    params = {
        "al": 1,
        "market": "socal",  # ignored when region_id+region_type are given
        "num_homes": min(num_homes, 450),
        "ord": "redfin-recommended-asc",
        "page_number": 1,
        "region_id": region_id,
        "region_type": region_type,
        "sf": "1,2,3,5,6,7",  # status filter: active, contingent, etc.
        "status": 9,           # for sale
        "uipt": "1,2,3,4,5,6,7,8",  # property types
        "v": 8,
    }
    if max_price is not None:
        params["max_price"] = max_price
    if min_price is not None:
        params["min_price"] = min_price
    if min_beds is not None:
        params["num_beds"] = min_beds
    if min_baths is not None:
        params["num_baths"] = min_baths
    if min_sqft is not None:
        params["min_sqft"] = min_sqft
    if home_types:
        # uipt: 1=house, 2=condo, 3=townhouse, 4=multi, 5=land, 6=other, 7=mobile, 8=coop
        params["uipt"] = ",".join(home_types)

    data = _get("/stingray/api/gis", params)
    homes = ((data.get("payload") or {}).get("homes")) or []
    out_homes = []
    for h in homes:
        out_homes.append(_summarize_home(h))
    return {
        "source": "redfin",
        "query": query,
        "region_id": region_id,
        "region_type": region_type,
        "count": len(out_homes),
        "homes": out_homes,
    }


def _summarize_home(h: dict) -> dict:
    addr = h.get("streetLine") or {}
    price = h.get("price") or {}
    return {
        "mls_id": h.get("mlsId"),
        "property_id": h.get("propertyId"),
        "listing_id": h.get("listingId"),
        "address": addr.get("value"),
        "city": h.get("city"),
        "state": (h.get("state") or {}).get("value") if isinstance(h.get("state"), dict) else h.get("state"),
        "zip": h.get("zip"),
        "price": price.get("value"),
        "beds": h.get("beds"),
        "baths": h.get("baths"),
        "sqft": (h.get("sqFt") or {}).get("value") if isinstance(h.get("sqFt"), dict) else h.get("sqFt"),
        "lot_size": (h.get("lotSize") or {}).get("value") if isinstance(h.get("lotSize"), dict) else h.get("lotSize"),
        "year_built": (h.get("yearBuilt") or {}).get("value") if isinstance(h.get("yearBuilt"), dict) else h.get("yearBuilt"),
        "url": f"{BASE}{h.get('url')}" if h.get("url") else None,
        "status": h.get("mlsStatus"),
        "listing_type": h.get("listingType"),
        "days_on_market": (h.get("timeOnRedfin") or {}).get("days") if isinstance(h.get("timeOnRedfin"), dict) else None,
    }


def property_details(url_or_path: str) -> dict:
    """Fetch full details for a single Redfin listing.

    Accepts a full URL (https://www.redfin.com/TX/Austin/123-Main-St-78704/home/12345)
    or just the path portion.
    """
    parsed = urlparse(url_or_path)
    path = parsed.path or url_or_path
    if not path.startswith("/"):
        path = "/" + path

    initial = _get("/stingray/api/home/details/initialInfo", {"path": path})
    payload = (initial.get("payload") or {})
    property_id = payload.get("propertyId")
    listing_id = payload.get("listingId")
    if not property_id:
        raise RuntimeError(f"redfin: could not resolve propertyId for {path!r}")

    above = _get("/stingray/api/home/details/aboveTheFold", {"propertyId": property_id, "accessLevel": 1})
    below = _get("/stingray/api/home/details/belowTheFold", {"propertyId": property_id, "accessLevel": 1})
    main_house_info = (above.get("payload") or {}).get("mainHouseInfo") or {}
    public_records = (below.get("payload") or {}).get("publicRecordsInfo") or {}
    return {
        "source": "redfin",
        "property_id": property_id,
        "listing_id": listing_id,
        "url": f"{BASE}{path}",
        "main_house_info": main_house_info,
        "public_records_info": public_records,
        "above_the_fold": above.get("payload"),
        "below_the_fold": below.get("payload"),
    }


def price_history(url_or_path: str) -> list[dict]:
    """Just the price + listing history for a property."""
    details = property_details(url_or_path)
    btf = details.get("below_the_fold") or {}
    return (btf.get("propertyHistoryInfo") or {}).get("events") or []


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(prog="redfin", description="Redfin internal-API CLI.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("autocomplete")
    sp.add_argument("query")

    sp = sub.add_parser("search")
    sp.add_argument("query")
    sp.add_argument("--max-price", type=int)
    sp.add_argument("--min-price", type=int)
    sp.add_argument("--min-beds", type=int)
    sp.add_argument("--min-baths", type=float)
    sp.add_argument("--min-sqft", type=int)
    sp.add_argument("--num-homes", type=int, default=50)

    sp = sub.add_parser("property")
    sp.add_argument("url")

    sp = sub.add_parser("history")
    sp.add_argument("url")

    args = ap.parse_args()

    if args.cmd == "autocomplete":
        print(json.dumps(autocomplete(args.query), indent=2))
    elif args.cmd == "search":
        print(json.dumps(search(
            args.query,
            max_price=args.max_price,
            min_price=args.min_price,
            min_beds=args.min_beds,
            min_baths=args.min_baths,
            min_sqft=args.min_sqft,
            num_homes=args.num_homes,
        ), indent=2))
    elif args.cmd == "property":
        print(json.dumps(property_details(args.url), indent=2))
    elif args.cmd == "history":
        print(json.dumps(price_history(args.url), indent=2))

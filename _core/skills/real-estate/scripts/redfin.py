"""Redfin scraper using public HTML pages.

Strategy:
  1. GET the HTML page humans visit (city / zipcode / property URL).
  2. Pull the InitialContext JSON.
  3. Reach into ReactServerAgent.cache.dataCache[<key>].res.text, strip the
     `{}&&` XSSI guard, parse the inner JSON.
  4. Fall through to the gis-csv/gis JSON endpoints when the cache entry
     isn't there.

All pure parsing lives in `redfin_parse.py`. This module owns HTTP +
region resolution + CLI.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from urllib.parse import quote, urlparse

from curl_cffi import requests as curl_requests

import redfin_parse as P
from redfin_parse import (
    BASE,
    GIS_REGION_TYPE,
    initial_context,
    parse_csv,
    parse_property,
    parse_region_from_url,
    parse_search_homes,
)

DEFAULT_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.redfin.com/",
}

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


# ---------------------------------------------------------------------------
# Region resolution
# ---------------------------------------------------------------------------

def _brave_search_first_redfin_url(query: str) -> str | None:
    """Find a Redfin URL for `query` via the brave-search skill."""
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
        if P.CITY_URL_RE.search(url) or P.ZIP_URL_RE.search(url):
            return url
    if results:
        return results[0].get("url")
    return None


def resolve_region(query: str) -> dict:
    """Return {region_id, region_type, url, ...} for a free-text query."""
    looks_like_url = query.startswith("http") or query.startswith("/")
    candidate = query if looks_like_url else None
    if candidate is None:
        candidate = _brave_search_first_redfin_url(query)
    if not candidate:
        raise RuntimeError(
            f"redfin: could not resolve {query!r}; pass a Redfin URL or check brave-search auth"
        )
    return parse_region_from_url(candidate)


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def _money(n: int) -> str:
    if n >= 1_000_000 and n % 1_000_000 == 0:
        return f"{n // 1_000_000}m"
    if n >= 1_000 and n % 1_000 == 0:
        return f"{n // 1_000}k"
    return str(n)


# Public-URL filter slugs Redfin's /city/.../filter/ path expects.
_HT_NAME_TO_UIPT = {
    "house": "1", "condo": "2", "townhouse": "3",
    "multi-family": "4", "multi": "4", "land": "5",
    "other": "6", "mobile": "7", "coop": "8",
}

# Redfin's `ord` values for /stingray/api/gis sorting.
_SORT_TO_ORD = {
    "redfin-recommended": "redfin-recommended-asc",
    "newest": "days-on-redfin-asc",
    "oldest": "days-on-redfin-desc",
    "price-asc": "price-asc",
    "price-desc": "price-desc",
    "sqft-desc": "square-feet-desc",
    "sqft-asc": "square-feet-asc",
    "lot-desc": "lot-size-desc",
    "year-built-desc": "year-built-desc",
}

# Redfin's `status` values (for "for sale" filtering).
_STATUS_TO_FLAG = {
    "active": 9,         # default
    "active-coming-soon": 139,
    "pending": 130,
    "contingent": 8,
    "sold": 162,
    "off-market": 0,
}


def _build_filter_segment(*, max_price=None, min_price=None, min_beds=None,
                          min_baths=None, min_sqft=None, max_sqft=None,
                          max_hoa=None, year_built_min=None, year_built_max=None,
                          lot_size_min=None, lot_size_max=None,
                          home_types=None, status=None, sort=None,
                          has_pool=None, has_garage=None, new_construction=None) -> str:
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
    if max_sqft is not None:
        parts.append(f"max-sqft={max_sqft}")
    if max_hoa is not None:
        parts.append(f"max-hoa={max_hoa}")
    if year_built_min is not None:
        parts.append(f"min-year-built={year_built_min}")
    if year_built_max is not None:
        parts.append(f"max-year-built={year_built_max}")
    if lot_size_min is not None:
        parts.append(f"min-lot-size={lot_size_min}")
    if lot_size_max is not None:
        parts.append(f"max-lot-size={lot_size_max}")
    if has_pool:
        parts.append("has-pool")
    if has_garage:
        parts.append("has-garage")
    if new_construction:
        parts.append("include=new-construction")
    if sort and sort in _SORT_TO_ORD:
        parts.append(f"sort={sort}")
    if status and status != "active":
        parts.append(f"include={status}")
    return "/filter/" + ",".join(parts) if parts else ""


def search(
    query: str | None = None,
    *,
    max_price: int | None = None,
    min_price: int | None = None,
    min_beds: int | None = None,
    min_baths: float | None = None,
    min_sqft: int | None = None,
    max_sqft: int | None = None,
    max_hoa: int | None = None,
    year_built_min: int | None = None,
    year_built_max: int | None = None,
    lot_size_min: int | None = None,
    lot_size_max: int | None = None,
    has_pool: bool = False,
    has_garage: bool = False,
    new_construction: bool = False,
    home_types: list[str] | None = None,
    num_homes: int = 50,
    page: int = 1,
    sort: str | None = None,
    status: str | None = None,
    region_id: int | None = None,
    region_type: int | None = None,
    polygon: list[tuple[float, float]] | None = None,
    bbox: tuple[float, float, float, float] | None = None,  # (n, e, s, w)
) -> dict:
    """Search Redfin listings.

    Region-resolution order:
      1. polygon=[(lat,lng), ...] -> /stingray/api/gis with poly=<lng lat,...>
      2. bbox=(n,e,s,w)            -> /stingray/api/gis with poly equivalent
      3. region_id+region_type     -> /stingray/api/gis-csv direct
      4. query (URL or free-text)  -> resolve_region + HTML path
    """
    filters = dict(
        max_price=max_price, min_price=min_price, min_beds=min_beds,
        min_baths=min_baths, min_sqft=min_sqft, max_sqft=max_sqft,
        max_hoa=max_hoa, year_built_min=year_built_min,
        year_built_max=year_built_max, lot_size_min=lot_size_min,
        lot_size_max=lot_size_max, has_pool=has_pool,
        has_garage=has_garage, new_construction=new_construction,
        home_types=home_types, status=status, sort=sort,
    )

    if polygon is not None or bbox is not None:
        return _search_via_gis_geo(
            polygon=polygon, bbox=bbox, num_homes=num_homes, page=page,
            **filters,
        )

    if region_id is not None and region_type is not None:
        region = {
            "region_id": int(region_id),
            "region_type": int(region_type),
            "kind": {6: "city", 2: "zip", 1: "neighborhood",
                     5: "county", 4: "state"}.get(int(region_type), "region"),
            "url": None,
        }
        return _search_via_gis(region, num_homes=num_homes, page=page, **filters)

    if not query:
        raise RuntimeError("redfin search: pass a query, region_id+region_type, polygon, or bbox")

    region = resolve_region(query)
    filter_seg = _build_filter_segment(**filters)
    url = region["url"] + filter_seg + (f"/page-{page}" if page > 1 else "")
    html = _fetch_html(url)
    ctx = initial_context(html)
    homes = parse_search_homes(ctx)
    if not homes:
        return _search_via_gis(region, num_homes=num_homes, page=page, **filters)
    return {
        "source": "redfin",
        "query": query,
        "region": region,
        "url": url,
        "count": len(homes),
        "homes": homes[:num_homes],
    }


def search_multi(queries: list[str], *, dedupe: bool = True, **kw) -> dict:
    """Run search() across N regions sequentially, dedupe, return merged.

    Caller is responsible for not blowing past the per-task request cap;
    each sub-search costs ~1 HTML GET (or 1 gis-csv fallback). Sleep
    between calls is the caller's responsibility (we sleep 1.5s here).
    """
    import time
    merged: list[dict] = []
    seen: set = set()
    sub_results = []
    for i, q in enumerate(queries):
        if i:
            time.sleep(1.5)
        try:
            res = search(q, **kw)
        except Exception as e:
            sub_results.append({"query": q, "error": str(e)})
            continue
        sub_results.append({"query": q, "count": res.get("count", 0)})
        for h in res.get("homes") or []:
            key = h.get("property_id") or (h.get("address"), h.get("zip"))
            if dedupe and key in seen:
                continue
            seen.add(key)
            merged.append(h)
    return {
        "source": "redfin",
        "queries": queries,
        "sub_results": sub_results,
        "count": len(merged),
        "homes": merged,
    }


def _gis_params(filters: dict, num_homes: int, page: int) -> dict:
    raw_types = filters.get("home_types") or []
    uipts = [_HT_NAME_TO_UIPT.get(t, t) for t in raw_types]
    if not uipts:
        uipts = ["1", "2", "3", "4", "5", "6", "7", "8"]
    sort_value = _SORT_TO_ORD.get(filters.get("sort") or "", "redfin-recommended-asc")
    status_flag = _STATUS_TO_FLAG.get(filters.get("status") or "", 9)
    p = {
        "al": 1, "num_homes": min(num_homes, 450),
        "ord": sort_value, "page_number": max(1, int(page)),
        "sf": "1,2,3,5,6,7", "status": status_flag,
        "uipt": ",".join(uipts), "v": 8,
    }
    if filters.get("max_price") is not None: p["max_price"] = filters["max_price"]
    if filters.get("min_price") is not None: p["min_price"] = filters["min_price"]
    if filters.get("min_beds") is not None: p["num_beds"] = filters["min_beds"]
    if filters.get("min_baths") is not None: p["num_baths"] = filters["min_baths"]
    if filters.get("min_sqft") is not None: p["min_sqft"] = filters["min_sqft"]
    if filters.get("max_sqft") is not None: p["max_sqft"] = filters["max_sqft"]
    if filters.get("max_hoa") is not None: p["hoa"] = filters["max_hoa"]
    if filters.get("year_built_min") is not None: p["min_year_built"] = filters["year_built_min"]
    if filters.get("year_built_max") is not None: p["max_year_built"] = filters["year_built_max"]
    if filters.get("lot_size_min") is not None: p["min_lot_size"] = filters["lot_size_min"]
    if filters.get("lot_size_max") is not None: p["max_lot_size"] = filters["lot_size_max"]
    if filters.get("has_pool"): p["pool"] = 1
    if filters.get("has_garage"): p["garage"] = 1
    if filters.get("new_construction"): p["include_new_construction"] = 1
    return p


def _search_via_gis(region: dict, *, num_homes=50, page=1, **filters) -> dict:
    """Fallback path: /stingray/api/gis-csv. Uses region_id + region_type."""
    s = _get_session()
    params = _gis_params(filters, num_homes=num_homes, page=page)
    params["region_id"] = region["region_id"]
    params["region_type"] = region["region_type"]
    r = s.get(BASE + "/stingray/api/gis-csv", params=params,
              headers={**DEFAULT_HEADERS, "Accept": "text/csv"}, timeout=25)
    if r.status_code != 200:
        raise RuntimeError(f"redfin gis-csv -> HTTP {r.status_code}: {r.text[:200]}")
    rows = parse_csv(r.text)
    return {
        "source": "redfin",
        "query": region.get("name") or region.get("url"),
        "region": region,
        "url": r.url,
        "count": len(rows),
        "homes": rows,
    }


def _format_poly(polygon: list[tuple[float, float]]) -> str:
    """Redfin's `poly` param wants `lng lat,lng lat,...` (longitude first).

    Source: https://scrapfly.io/blog/posts/how-to-scrape-redfin shows
    `poly=<longitude>%20<latitude>,...` on the GIS endpoints.
    """
    return ",".join(f"{lng} {lat}" for lat, lng in polygon)


def _bbox_to_poly(bbox: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    """Convert (n, e, s, w) -> closed polygon ring as [(lat, lng), ...]."""
    n, e, s, w = bbox
    return [(n, w), (n, e), (s, e), (s, w), (n, w)]


def _search_via_gis_geo(*, polygon=None, bbox=None, num_homes=50, page=1, **filters) -> dict:
    """Polygon / bbox search via /stingray/api/gis (JSON, not CSV).

    Both Redfin and the Redfin-frontend send `poly=<lng lat,...>` here.
    """
    if bbox is not None and polygon is None:
        polygon = _bbox_to_poly(bbox)
    if not polygon or len(polygon) < 3:
        raise RuntimeError("redfin gis-geo: need at least 3 polygon vertices")
    # Redfin closes the ring server-side, but no harm in closing it ourselves.
    if polygon[0] != polygon[-1]:
        polygon = list(polygon) + [polygon[0]]
    s = _get_session()
    params = _gis_params(filters, num_homes=num_homes, page=page)
    params["poly"] = _format_poly(polygon)
    params["user_poly"] = params["poly"]
    r = s.get(BASE + "/stingray/api/gis", params=params,
              headers={**DEFAULT_HEADERS, "Accept": "application/json"}, timeout=25)
    if r.status_code != 200:
        raise RuntimeError(f"redfin gis -> HTTP {r.status_code}: {r.text[:200]}")
    text = r.text
    if text.startswith(P.XSSI_PREFIX):
        text = text[len(P.XSSI_PREFIX):]
    try:
        body = json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError(f"redfin gis: non-JSON response: {text[:200]}")
    homes = ((body.get("payload") or {}).get("homes")) or []
    summarized = [P.summarize_home(h) for h in homes]
    return {
        "source": "redfin",
        "polygon": polygon,
        "url": r.url,
        "count": len(summarized),
        "homes": summarized[:num_homes],
    }


# ---------------------------------------------------------------------------
# Property
# ---------------------------------------------------------------------------

def property_details(url_or_path: str, *, include_raw: bool = False) -> dict:
    if not url_or_path.startswith("http"):
        url_or_path = BASE + (url_or_path if url_or_path.startswith("/") else "/" + url_or_path)
    html = _fetch_html(url_or_path)
    ctx = initial_context(html)
    out = parse_property(ctx, include_raw=include_raw)
    out["url"] = url_or_path
    return out


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


def _parse_polygon(s: str) -> list[tuple[float, float]]:
    """Parse '30.27,-97.74;30.30,-97.74;...' into [(lat,lng), ...]."""
    pts = []
    for chunk in re.split(r"[;\n]+", s.strip()):
        chunk = chunk.strip()
        if not chunk:
            continue
        a, b = chunk.split(",")
        pts.append((float(a), float(b)))
    return pts


def _parse_bbox(s: str) -> tuple[float, float, float, float]:
    parts = [float(x) for x in s.split(",")]
    if len(parts) != 4:
        raise SystemExit("--bbox needs 4 floats: n,e,s,w")
    return tuple(parts)  # type: ignore


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="redfin")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("resolve", help="resolve a query to a region")
    sp.add_argument("query")

    sp = sub.add_parser("search", help="search listings in a region / polygon / bbox")
    sp.add_argument("query", nargs="?")
    sp.add_argument("--max-price", type=int)
    sp.add_argument("--min-price", type=int)
    sp.add_argument("--min-beds", type=int)
    sp.add_argument("--min-baths", type=float)
    sp.add_argument("--min-sqft", type=int)
    sp.add_argument("--max-sqft", type=int)
    sp.add_argument("--max-hoa", type=int)
    sp.add_argument("--year-built-min", type=int)
    sp.add_argument("--year-built-max", type=int)
    sp.add_argument("--lot-size-min", type=int)
    sp.add_argument("--lot-size-max", type=int)
    sp.add_argument("--has-pool", action="store_true")
    sp.add_argument("--has-garage", action="store_true")
    sp.add_argument("--new-construction", action="store_true")
    sp.add_argument("--home-types", help="comma-separated: house,condo,townhouse,multi-family,land,mobile,coop")
    sp.add_argument("--status", choices=list(_STATUS_TO_FLAG.keys()))
    sp.add_argument("--sort", choices=list(_SORT_TO_ORD.keys()))
    sp.add_argument("--num-homes", type=int, default=50)
    sp.add_argument("--page", type=int, default=1)
    sp.add_argument("--region-id", type=int, help="manual override; pair with --region-type")
    sp.add_argument("--region-type", type=int, help="6=city, 2=zip, 1=neighborhood, 5=county, 4=state")
    sp.add_argument("--polygon", help="lat,lng;lat,lng;... (>= 3 vertices)")
    sp.add_argument("--bbox", help="north,east,south,west (4 floats)")
    sp.add_argument("--regions", help="multi-region OR: 'Austin, TX;Round Rock, TX'")

    sp = sub.add_parser("property", help="full details for a single listing")
    sp.add_argument("url")
    sp.add_argument("--include-raw", action="store_true")

    sp = sub.add_parser("history", help="price/listing history for a property")
    sp.add_argument("url")

    sp = sub.add_parser("comps", help="comparable / similar listings for a property")
    sp.add_argument("url")

    args = ap.parse_args(argv)

    if args.cmd == "resolve":
        _print(resolve_region(args.query))
    elif args.cmd == "search":
        ht = None
        if args.home_types:
            ht = [t.strip() for t in args.home_types.split(",") if t.strip()]
        polygon = _parse_polygon(args.polygon) if args.polygon else None
        bbox = _parse_bbox(args.bbox) if args.bbox else None
        common = dict(
            max_price=args.max_price, min_price=args.min_price,
            min_beds=args.min_beds, min_baths=args.min_baths,
            min_sqft=args.min_sqft, max_sqft=args.max_sqft,
            max_hoa=args.max_hoa,
            year_built_min=args.year_built_min, year_built_max=args.year_built_max,
            lot_size_min=args.lot_size_min, lot_size_max=args.lot_size_max,
            has_pool=args.has_pool, has_garage=args.has_garage,
            new_construction=args.new_construction,
            home_types=ht, status=args.status, sort=args.sort,
            num_homes=args.num_homes, page=args.page,
        )
        if args.regions:
            qs = [q.strip() for q in args.regions.split(";") if q.strip()]
            _print(search_multi(qs, **common))
        else:
            _print(search(
                args.query,
                **common,
                region_id=args.region_id, region_type=args.region_type,
                polygon=polygon, bbox=bbox,
            ))
    elif args.cmd == "property":
        _print(property_details(args.url, include_raw=args.include_raw))
    elif args.cmd == "history":
        _print(price_history(args.url))
    elif args.cmd == "comps":
        _print(comps(args.url))


if __name__ == "__main__":
    main()

"""Zillow scraper using public HTML pages.

Zillow runs PerimeterX + Cloudflare. We hit /<region>/ or /homes/<slug>_rb/
HTML pages, pull __NEXT_DATA__, and parse client-side. Pure parsing lives in
zillow_parse.py.

Region resolution accepts:
  * a direct Zillow URL (preserves customRegionId if present)
  * a free-text query slugified into the canonical city URL
  * (lat,lng) polygon -> bbox + client-side point-in-polygon filter
  * (n,e,s,w) bbox    -> mapBounds in searchQueryState
"""
from __future__ import annotations

import json
import re
import sys
from typing import Any
from urllib.parse import quote, urlparse, parse_qs

from curl_cffi import requests as curl_requests

import zillow_parse as P
from zillow_parse import (
    BASE,
    next_data,
    parse_property,
    parse_search_homes,
    search_page_state,
    search_query_state,
    search_total_count,
)

DEFAULT_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.zillow.com/",
}
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

_PROFILE_ROTATION = ["chrome124", "safari17_0", "chrome131", "chrome120", "chrome116", "firefox133"]
_session: curl_requests.Session | None = None
_session_profile: str | None = None
# Threads can race when batch.py runs N concurrent fetches and one trips PX
# rotation. The lock serializes session reads/writes so a swap is atomic.
import threading as _threading
_session_lock = _threading.RLock()


def _new_session(profile: str) -> curl_requests.Session:
    s = curl_requests.Session(impersonate=profile)
    s.get(BASE + "/", headers=DEFAULT_HEADERS, timeout=20)
    return s


def _get_session() -> curl_requests.Session:
    global _session, _session_profile
    with _session_lock:
        if _session is None:
            _session_profile = _PROFILE_ROTATION[0]
            _session = _new_session(_session_profile)
        return _session


def _is_px_block(r) -> bool:
    return r.status_code == 403 and "px-captcha" in r.text[:1000]


def _fetch_html(url: str) -> str:
    global _session, _session_profile
    s = _get_session()
    r = s.get(url, headers=DEFAULT_HEADERS, timeout=25)
    if _is_px_block(r):
        # PX rotation needs the session lock to swap _session / _session_profile
        # atomically without racing other threads.
        with _session_lock:
            try:
                start = _PROFILE_ROTATION.index(_session_profile or "") + 1
            except ValueError:
                start = 0
            for prof in _PROFILE_ROTATION[start:]:
                try:
                    s = _new_session(prof)
                except Exception:
                    continue
                r = s.get(url, headers=DEFAULT_HEADERS, timeout=25)
                if r.status_code == 200 and not _is_px_block(r):
                    _session, _session_profile = s, prof
                    return r.text
        raise RuntimeError(
            f"zillow GET {url} -> PX captcha across all impersonation profiles "
            f"({_PROFILE_ROTATION}). Wait ~30 min for PX to release the IP, "
            "or run from a different network."
        )
    if r.status_code != 200:
        raise RuntimeError(f"zillow GET {url} -> HTTP {r.status_code}: {r.text[:200]}")
    return r.text


# ---------------------------------------------------------------------------
# Region resolution
# ---------------------------------------------------------------------------

def _slugify_city_state(query: str) -> str | None:
    q = query.strip().lower()
    if q.isdigit() and len(q) == 5:
        return q
    if re.fullmatch(r"[a-z0-9-]+", q) and "-" in q:
        return q
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


def _custom_region_id_from_url(url: str) -> str | None:
    """If `url` is a Zillow URL with a searchQueryState querystring that
    includes customRegionId, extract it. Used to preserve user-drawn
    regions that we can't synthesize ourselves.
    """
    qs = parse_qs(urlparse(url).query)
    sqs_str = (qs.get("searchQueryState") or [None])[0]
    if not sqs_str:
        return None
    try:
        sqs = json.loads(sqs_str)
    except json.JSONDecodeError:
        return None
    return sqs.get("customRegionId")


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

# Map our public flag names to Zillow filterState keys.
_STATUS_TO_FILTER: dict[str, dict[str, Any]] = {
    "active": {"isForSaleByAgent": {"value": True}, "isForSaleByOwner": {"value": True},
               "isNewConstruction": {"value": True}, "isComingSoon": {"value": True}},
    "pending": {"isPendingListingsSelected": {"value": True},
                "isAuction": {"value": True}, "isPreMarketForeclosure": {"value": True}},
    "sold": {"isRecentlySold": {"value": True}},
    "coming-soon": {"isComingSoon": {"value": True}},
    "off-market": {"isAllHomes": {"value": True}, "isForSaleByAgent": {"value": False},
                   "isForSaleByOwner": {"value": False}, "isNewConstruction": {"value": False},
                   "isComingSoon": {"value": False}},
    # Rentals: Zillow's rental search uses SHORT filterState keys (fr, fsba, etc)
    # AND a different URL path (/homes/for_rent/). The short keys are required;
    # using the long names (isForRent, isForSaleByAgent) silently returns 0 results.
    "for-rent": {
        "fr": {"value": True}, "fsba": {"value": False}, "fsbo": {"value": False},
        "nc": {"value": False}, "cmsn": {"value": False},
        "auc": {"value": False}, "fore": {"value": False},
    },
}


def _is_rental_status(status: str | None) -> bool:
    return status == "for-rent"


# Map our public sort flag to short keys Zillow's rental search expects.
_RENTAL_SORT_VALUES = {
    "newest": "days",
    "price-asc": "pricea",
    "price-desc": "priced",
}

_SORT_VALUES = {
    "newest": "days",
    "price-asc": "price",
    "price-desc": "priced",
    "sqft-desc": "size",
    "sqft-asc": "sizea",
    "lot-desc": "lot",
}


def _filter_state(*, max_price=None, min_price=None, min_beds=None, min_baths=None,
                  min_sqft=None, max_sqft=None, max_hoa=None,
                  year_built_min=None, year_built_max=None,
                  lot_size_min=None, lot_size_max=None,
                  has_pool=None, has_garage=None, new_construction=None,
                  status=None, sort=None) -> dict[str, Any]:
    rental = _is_rental_status(status)
    if rental:
        # Rentals use SHORT filterState keys (fr/fsba/etc) and a different
        # sort taxonomy. Sale-only flags (isNewConstruction, isComingSoon)
        # would create internally-contradictory state if mixed in. Ignore
        # them when status=for-rent.
        sort_key = _RENTAL_SORT_VALUES.get(sort or "", "days")
        fs: dict[str, Any] = {"sort": {"value": sort_key}}
        fs.update(_STATUS_TO_FILTER[status])
    else:
        fs = {"sortSelection": {"value": _SORT_VALUES.get(sort or "", "globalrelevanceex")},
              "isAllHomes": {"value": True}}
        if status and status in _STATUS_TO_FILTER:
            fs.update(_STATUS_TO_FILTER[status])
    if max_price is not None or min_price is not None:
        # Rentals use 'mp' (monthly price) instead of 'price'.
        price_key = "mp" if rental else "price"
        price = {}
        if max_price is not None: price["max"] = max_price
        if min_price is not None: price["min"] = min_price
        fs[price_key] = price
    if min_beds is not None:
        fs["beds"] = {"min": min_beds}
    if min_baths is not None:
        fs["baths"] = {"min": min_baths}
    if min_sqft is not None or max_sqft is not None:
        sq = {}
        if min_sqft is not None: sq["min"] = min_sqft
        if max_sqft is not None: sq["max"] = max_sqft
        fs["sqft"] = sq
    if max_hoa is not None:
        fs["hoa"] = {"max": max_hoa}
    if year_built_min is not None or year_built_max is not None:
        yb = {}
        if year_built_min is not None: yb["min"] = year_built_min
        if year_built_max is not None: yb["max"] = year_built_max
        fs["built"] = yb
    if lot_size_min is not None or lot_size_max is not None:
        ls = {}
        if lot_size_min is not None: ls["min"] = lot_size_min
        if lot_size_max is not None: ls["max"] = lot_size_max
        fs["lotSize"] = ls
    if has_pool: fs["hasPool"] = {"value": True}
    if has_garage: fs["parkingSpots"] = {"min": 1}
    if new_construction: fs["isNewConstruction"] = {"value": True}
    return fs


def _point_in_polygon(lat: float, lng: float, polygon: list[tuple[float, float]]) -> bool:
    """Ray-casting point-in-polygon. polygon is [(lat, lng), ...]."""
    n = len(polygon)
    inside = False
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        lat_i, lng_i = polygon[i]
        lat_j, lng_j = polygon[j]
        if ((lng_i > lng) != (lng_j > lng)) and \
                (lat < (lat_j - lat_i) * (lng - lng_i) / (lng_j - lng_i + 1e-12) + lat_i):
            inside = not inside
        j = i
    return inside


def _polygon_to_bbox(polygon: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    lats = [p[0] for p in polygon]
    lngs = [p[1] for p in polygon]
    return (max(lats), max(lngs), min(lats), min(lngs))  # n, e, s, w


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
    status: str | None = None,
    sort: str | None = None,
    page: int = 1,
    polygon: list[tuple[float, float]] | None = None,
    bbox: tuple[float, float, float, float] | None = None,
) -> dict:
    """Zillow search with filters, regions, and polygons."""
    fs = _filter_state(
        max_price=max_price, min_price=min_price, min_beds=min_beds,
        min_baths=min_baths, min_sqft=min_sqft, max_sqft=max_sqft,
        max_hoa=max_hoa, year_built_min=year_built_min,
        year_built_max=year_built_max, lot_size_min=lot_size_min,
        lot_size_max=lot_size_max, has_pool=has_pool,
        has_garage=has_garage, new_construction=new_construction,
        status=status, sort=sort,
    )

    if polygon is not None or bbox is not None:
        return _search_via_geo(polygon=polygon, bbox=bbox, page=page,
                               filter_state=fs, rental=_is_rental_status(status))

    if not query:
        raise RuntimeError("zillow search: pass a query, polygon, or bbox")

    # If the query is a Zillow URL with customRegionId, replay via that.
    if query.startswith("http") and (cid := _custom_region_id_from_url(query)):
        return _search_via_custom_region(cid, query, fs, page)

    url = _city_url(query)
    base_html = _fetch_html(url)
    base_data = next_data(base_html)
    base_sps = search_page_state(base_data)
    base_qs = search_query_state(base_sps)
    map_bounds = base_qs.get("mapBounds")
    region_selection = base_qs.get("regionSelection")
    if not map_bounds or not region_selection:
        listings = parse_search_homes(base_sps)
        return _wrap_search(query, url, listings, base_sps)

    sqs = {
        "pagination": {"currentPage": page} if page > 1 else {},
        "mapBounds": map_bounds,
        "regionSelection": region_selection,
        "filterState": fs,
        "isListVisible": True,
        "mapZoom": base_qs.get("mapZoom") or 11,
    }
    sep = "&" if "?" in url else "?"
    full_url = url + sep + "searchQueryState=" + quote(json.dumps(sqs, separators=(",", ":")))
    html = _fetch_html(full_url)
    data = next_data(html)
    sps = search_page_state(data)
    listings = parse_search_homes(sps)
    return _wrap_search(query, full_url, listings, sps)


def _search_via_custom_region(custom_region_id: str, src_url: str,
                              filter_state: dict, page: int) -> dict:
    sqs = {
        "pagination": {"currentPage": page} if page > 1 else {},
        "customRegionId": custom_region_id,
        "filterState": filter_state,
        "isListVisible": True,
    }
    full_url = (BASE + "/homes/?searchQueryState="
                + quote(json.dumps(sqs, separators=(",", ":"))))
    html = _fetch_html(full_url)
    data = next_data(html)
    sps = search_page_state(data)
    listings = parse_search_homes(sps)
    return _wrap_search(src_url, full_url, listings, sps,
                        extra={"custom_region_id": custom_region_id})


def _search_via_geo(*, polygon=None, bbox=None, page=1, filter_state: dict,
                    rental: bool = False) -> dict:
    """Polygon / bbox search via mapBounds + optional client-side filter."""
    if polygon is not None and bbox is None:
        bbox = _polygon_to_bbox(polygon)
    if not bbox or len(bbox) != 4:
        raise RuntimeError("zillow geo: need polygon (>=3 verts) or bbox (n,e,s,w)")
    n, e, s, w = bbox
    map_bounds = {"north": n, "east": e, "south": s, "west": w}
    sqs = {
        "pagination": {"currentPage": page} if page > 1 else {},
        "mapBounds": map_bounds,
        "filterState": filter_state,
        "isListVisible": True,
        "isMapVisible": True,
    }
    base_path = "/homes/for_rent/" if rental else "/homes/"
    full_url = (BASE + base_path + "?searchQueryState="
                + quote(json.dumps(sqs, separators=(",", ":"))))
    html = _fetch_html(full_url)
    data = next_data(html)
    sps = search_page_state(data)
    listings_raw = ((sps.get("cat1") or {}).get("searchResults") or {}).get("listResults") or []
    if polygon:
        # Client-side filter to the actual polygon; bbox is just a Zillow filter prelude.
        filtered = []
        for h in listings_raw:
            home_info = ((h.get("hdpData") or {}).get("homeInfo") or {})
            lat = home_info.get("latitude") or (h.get("latLong") or {}).get("latitude")
            lng = home_info.get("longitude") or (h.get("latLong") or {}).get("longitude")
            if lat is None or lng is None:
                continue
            if _point_in_polygon(float(lat), float(lng), polygon):
                filtered.append(h)
        listings_raw = filtered
    listings = [P.summarize_home(h) for h in listings_raw]
    return _wrap_search(None, full_url, listings, sps,
                        extra={"polygon": polygon, "bbox": bbox})


def _wrap_search(query, url: str, listings: list, sps: dict, extra: dict | None = None) -> dict:
    out = {
        "source": "zillow",
        "query": query,
        "url": url,
        "total_in_region": search_total_count(sps) or len(listings),
        "count": len(listings),
        "homes": listings,
    }
    if extra:
        out.update(extra)
    return out


def search_multi(queries: list[str], *, dedupe: bool = True, **kw) -> dict:
    """Run search() across N queries with throttling + dedupe by zpid."""
    import time
    merged: list[dict] = []
    seen: set = set()
    sub_results = []
    for i, q in enumerate(queries):
        if i:
            time.sleep(2.0)
        try:
            res = search(q, **kw)
        except Exception as e:
            sub_results.append({"query": q, "error": str(e)})
            continue
        sub_results.append({"query": q, "count": res.get("count", 0)})
        for h in res.get("homes") or []:
            key = h.get("zpid") or (h.get("address"), h.get("zip"))
            if dedupe and key in seen:
                continue
            seen.add(key)
            merged.append(h)
    return {
        "source": "zillow",
        "queries": queries,
        "sub_results": sub_results,
        "count": len(merged),
        "homes": merged,
    }


# ---------------------------------------------------------------------------
# Property
# ---------------------------------------------------------------------------

def property_details(url: str, *, include_raw: bool = False) -> dict:
    if not url.startswith("http"):
        url = BASE + (url if url.startswith("/") else "/" + url)
    html = _fetch_html(url)
    data = next_data(html)
    out = parse_property(data, include_raw=include_raw)
    out["url"] = url
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _print(o):
    json.dump(o, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


def _parse_polygon(s: str) -> list[tuple[float, float]]:
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
    ap = argparse.ArgumentParser(prog="zillow")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("search")
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
    sp.add_argument("--status", choices=list(_STATUS_TO_FILTER.keys()))
    sp.add_argument("--sort", choices=list(_SORT_VALUES.keys()))
    sp.add_argument("--page", type=int, default=1)
    sp.add_argument("--polygon", help="lat,lng;lat,lng;... (>=3 vertices)")
    sp.add_argument("--bbox", help="north,east,south,west")
    sp.add_argument("--regions", help="multi-region OR: 'Austin, TX;Round Rock, TX'")

    sp = sub.add_parser("property")
    sp.add_argument("url")
    sp.add_argument("--include-raw", action="store_true")

    args = ap.parse_args(argv)
    if args.cmd == "search":
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
            status=args.status, sort=args.sort, page=args.page,
        )
        if args.regions:
            qs = [q.strip() for q in args.regions.split(";") if q.strip()]
            _print(search_multi(qs, **common))
        else:
            _print(search(args.query, **common, polygon=polygon, bbox=bbox))
    elif args.cmd == "property":
        _print(property_details(args.url, include_raw=args.include_raw))


if __name__ == "__main__":
    main()

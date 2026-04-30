"""Rent estimate via Zillow rental comps.

Algorithm:
  1. Resolve target home -> lat/lng/sqft/beds (uses lookup.py).
  2. Build a small bbox around target (default 1.0 mile).
  3. zillow.search() with status=for-rent + bbox + bed match.
  4. Filter comps by haversine distance to target.
  5. Compute median + trimmed-mean $/sqft from comps.
  6. Multiply target sqft -> low / mid / high estimate.

Returns the computed estimate AND the raw comps so the caller can sanity
check or rerun with tighter filters.

Cost: 1 lookup (1 redfin + 1 zillow page) + 1 zillow rental search = 3 hits
typical. Honest "no comps" output when fewer than 3 valid rentals match.
"""
from __future__ import annotations

import math
import statistics
from typing import Any

import zillow  # type: ignore
import lookup  # type: ignore
from dedupe import haversine_m  # type: ignore


_METERS_PER_MILE = 1609.344


def _bbox_around(lat: float, lng: float, miles: float) -> tuple[float, float, float, float]:
    """(n, e, s, w) bbox of `miles` radius around (lat, lng).

    Uses a flat-earth approximation: lat degrees are ~69 mi each, lng
    degrees vary by cos(lat). Good enough for < 5 mi searches at typical
    US latitudes. Negative miles are clamped to 0 to avoid inverted bboxes
    (which silently return zero results from Zillow).
    """
    miles = max(0.0, miles)
    dlat = miles / 69.0
    dlng = miles / (69.0 * max(math.cos(math.radians(lat)), 0.05))
    return (lat + dlat, lng + dlng, lat - dlat, lng - dlng)


def _filter_comps(comps: list[dict], *, target_lat: float, target_lng: float,
                  target_beds: int | None, max_miles: float,
                  beds_tolerance: int = 0) -> list[dict]:
    out = []
    for c in comps:
        clat, clng = c.get("lat"), c.get("lng")
        if clat is None or clng is None:
            continue
        dist_m = haversine_m(target_lat, target_lng, float(clat), float(clng))
        dist_mi = dist_m / _METERS_PER_MILE
        if dist_mi > max_miles:
            continue
        if target_beds is not None and c.get("beds") is not None:
            if abs(int(c["beds"]) - int(target_beds)) > beds_tolerance:
                continue
        if not c.get("price") or not c.get("sqft"):
            continue
        c = dict(c)
        c["distance_miles"] = round(dist_mi, 3)
        c["price_per_sqft"] = round(float(c["price"]) / float(c["sqft"]), 4)
        out.append(c)
    out.sort(key=lambda x: x["distance_miles"])
    return out


def _trim_mean(values: list[float], pct: float = 0.1) -> float | None:
    if not values:
        return None
    n = len(values)
    drop = max(1, int(n * pct)) if n >= 5 else 0
    sorted_vals = sorted(values)
    trimmed = sorted_vals[drop: n - drop] if drop else sorted_vals
    if not trimmed:
        trimmed = sorted_vals
    return sum(trimmed) / len(trimmed)


def estimate_rent(
    address: str,
    *,
    radius_miles: float = 1.0,
    beds_tolerance: int = 0,
    redfin_url: str | None = None,
    zillow_url: str | None = None,
    target_override: dict | None = None,
) -> dict:
    """Estimate rent for `address` from nearby Zillow rentals.

    `target_override` lets the caller skip the property fetch and supply
    {lat, lng, sqft, beds, address} directly (handy for testing, or when
    you already have the data).
    """
    if target_override:
        target = target_override
    else:
        looked = lookup.lookup(address, redfin_url=redfin_url, zillow_url=zillow_url)
        merged = looked.get("merged") or {}
        target = {
            "address": merged.get("address") or address,
            "lat": merged.get("lat"),
            "lng": merged.get("lng"),
            "sqft": merged.get("sqft"),
            "beds": merged.get("beds"),
            "zip": merged.get("zip"),
            "_lookup": looked,
        }

    if target.get("lat") is None or target.get("lng") is None:
        return {
            "address": target.get("address") or address,
            "error": ("could not resolve target lat/lng. Pass --redfin-url or "
                      "--zillow-url so the lookup can resolve, or check the address."),
        }

    bbox = _bbox_around(float(target["lat"]), float(target["lng"]), radius_miles)
    target_beds = int(target["beds"]) if target.get("beds") else None

    rentals = zillow.search(
        query=None, bbox=bbox, status="for-rent",
        min_beds=(target_beds - beds_tolerance) if target_beds else None,
        max_price=None,
    )
    raw_comps = rentals.get("homes") or []
    comps = _filter_comps(
        raw_comps,
        target_lat=float(target["lat"]), target_lng=float(target["lng"]),
        target_beds=target_beds, max_miles=radius_miles,
        beds_tolerance=beds_tolerance,
    )
    if len(comps) < 3:
        return {
            "address": target.get("address"),
            "comp_count": len(comps),
            "comps": comps,
            "error": f"only {len(comps)} comps in {radius_miles} mi; widen --radius-miles or relax --beds-tolerance",
            "target": {"lat": target["lat"], "lng": target["lng"],
                       "sqft": target.get("sqft"), "beds": target.get("beds")},
        }

    pps_values = [c["price_per_sqft"] for c in comps]
    median_pps = statistics.median(pps_values)
    trim_pps = _trim_mean(pps_values)
    target_sqft = target.get("sqft")
    if target_sqft and target_sqft > 0:
        target_sqft = float(target_sqft)
        low = round(min(pps_values) * target_sqft)
        mid = round(median_pps * target_sqft)
        high = round(max(pps_values) * target_sqft)
        trim_estimate = round(trim_pps * target_sqft) if trim_pps else None
    else:
        low = mid = high = trim_estimate = None

    return {
        "source": "zillow",
        "address": target.get("address"),
        "target": {
            "lat": target["lat"], "lng": target["lng"],
            "sqft": target.get("sqft"), "beds": target.get("beds"),
            "zip": target.get("zip"),
        },
        "radius_miles": radius_miles,
        "beds_tolerance": beds_tolerance,
        "comp_count": len(comps),
        "median_price_per_sqft": round(median_pps, 4),
        "trimmed_mean_price_per_sqft": round(trim_pps, 4) if trim_pps else None,
        "estimated_rent_low": low,
        "estimated_rent_mid": mid,
        "estimated_rent_high": high,
        "estimated_rent_trimmed": trim_estimate,
        "comps": [
            {
                "address": c.get("address"),
                "city": c.get("city"),
                "zip": c.get("zip"),
                "price": c.get("price"),
                "sqft": c.get("sqft"),
                "beds": c.get("beds"),
                "baths": c.get("baths"),
                "url": c.get("url"),
                "distance_miles": c.get("distance_miles"),
                "price_per_sqft": c.get("price_per_sqft"),
            }
            for c in comps
        ],
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    import argparse
    import json
    import sys
    ap = argparse.ArgumentParser(prog="rent-estimate")
    ap.add_argument("address")
    ap.add_argument("--radius-miles", type=float, default=1.0)
    ap.add_argument("--beds-tolerance", type=int, default=0,
                    help="how many beds difference to allow in comps (default 0 = exact)")
    ap.add_argument("--redfin-url", help="skip Brave; use this Redfin URL for the target home")
    ap.add_argument("--zillow-url", help="skip Brave; use this Zillow URL for the target home")
    ap.add_argument("--target-lat", type=float, help="skip lookup; supply target lat directly")
    ap.add_argument("--target-lng", type=float, help="skip lookup; supply target lng directly")
    ap.add_argument("--target-sqft", type=int)
    ap.add_argument("--target-beds", type=int)
    args = ap.parse_args(argv)

    target_override = None
    if args.target_lat is not None and args.target_lng is not None:
        target_override = {
            "address": args.address,
            "lat": args.target_lat, "lng": args.target_lng,
            "sqft": args.target_sqft, "beds": args.target_beds,
        }

    result = estimate_rent(
        args.address,
        radius_miles=args.radius_miles,
        beds_tolerance=args.beds_tolerance,
        redfin_url=args.redfin_url, zillow_url=args.zillow_url,
        target_override=target_override,
    )
    json.dump(result, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()

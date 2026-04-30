"""Cross-source dedupe for Redfin + Zillow homes.

Strategy (per Codex review): primary key when present (zpid for Zillow,
property_id for Redfin), then lat/lng proximity within 25 m AND beds/sqft
sanity (beds equal, sqft within 5%).

Why not address-only: condos and unit numbers collide ("Unit #" vs "#"),
spelling variants ("Saint" vs "St"), and abbreviations. Geocode + size is
the more durable join key.
"""
from __future__ import annotations

import math
from collections.abc import Iterable


_EARTH_R_M = 6371000.0


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * _EARTH_R_M * math.asin(math.sqrt(a))


def _primary_key(home: dict) -> tuple | None:
    src = home.get("source")
    if home.get("zpid"):
        return ("zpid", str(home["zpid"]))
    if home.get("property_id"):
        return ("rid", str(home["property_id"]))
    return None


def _approx_match(a: dict, b: dict, *, max_meters: float = 25.0) -> bool:
    la, lna = a.get("lat"), a.get("lng")
    lb, lnb = b.get("lat"), b.get("lng")
    if la is None or lna is None or lb is None or lnb is None:
        return False
    if haversine_m(la, lna, lb, lnb) > max_meters:
        return False
    # Beds must match (when both have beds populated).
    if a.get("beds") is not None and b.get("beds") is not None:
        if a["beds"] != b["beds"]:
            return False
    # Sqft within 5%.
    sa, sb = a.get("sqft"), b.get("sqft")
    if sa and sb:
        diff = abs(sa - sb) / max(sa, sb)
        if diff > 0.05:
            return False
    return True


def merge(*lists: Iterable[dict], max_meters: float = 25.0) -> list[dict]:
    """Merge N home lists, deduping cross-source.

    Returns a list of merged homes. When two sources match, the entry keeps
    its origin source as `_source` (from `source` field) and adds a
    `_other_sources` list of dicts with the duplicate-source fields, so
    callers can compare prices/zestimates side-by-side.
    """
    merged: list[dict] = []
    keys_seen: dict[tuple, int] = {}  # primary key -> index in merged
    for batch in lists:
        for home in batch:
            pk = _primary_key(home)
            if pk and pk in keys_seen:
                merged[keys_seen[pk]].setdefault("_other_sources", []).append(home)
                continue
            # Geo + sanity check against existing
            matched_idx = None
            for i, existing in enumerate(merged):
                if _approx_match(home, existing, max_meters=max_meters):
                    matched_idx = i
                    break
            if matched_idx is not None:
                merged[matched_idx].setdefault("_other_sources", []).append(home)
                continue
            home = dict(home)
            home.setdefault("_source", home.get("source"))
            merged.append(home)
            if pk:
                keys_seen[pk] = len(merged) - 1
    return merged

"""Cross-source dedupe for Redfin + Zillow homes.

Match precedence:
  1. Same-source primary key (zpid for Zillow, property_id for Redfin).
  2. Lat/lng proximity <=25m AND beds match AND sqft within 5%.
  3. Normalized address+zip AND beds match AND sqft within 5%
     (the missing-coords fallback - Zillow sometimes drops coords on
     unmapped/off-market listings).

Address normalization handles common collision sources: case, "Unit"/"Apt"/
"#" suffixes, "St"/"Saint", "Ave"/"Avenue", whitespace, punctuation.
"""
from __future__ import annotations

import math
import re
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


_STREET_TYPE_NORMS = {
    "saint": "st", "street": "st", "avenue": "ave", "boulevard": "blvd",
    "road": "rd", "drive": "dr", "lane": "ln", "court": "ct",
    "place": "pl", "circle": "cir", "trail": "trl", "highway": "hwy",
    "parkway": "pkwy", "terrace": "ter", "way": "way", "cove": "cv",
    "loop": "loop", "square": "sq",
}
_DIRECTION_NORMS = {
    "north": "n", "south": "s", "east": "e", "west": "w",
    "northeast": "ne", "northwest": "nw", "southeast": "se", "southwest": "sw",
}
_STRIP_UNIT_RE = re.compile(
    r"(?:\b(?:unit|apt|apartment|ste|suite)\.?\b|#)\s*\S+",
    re.IGNORECASE,
)


def normalize_address(addr: str | None) -> str:
    """Normalize a street address for cross-source matching.

    - lowercase
    - strip 'Unit X' / 'Apt 4B' / '#3' suffixes
    - canonicalize street types ('Saint'->'st', 'Avenue'->'ave')
    - canonicalize directions ('North'->'n')
    - collapse whitespace and strip punctuation
    """
    if not addr:
        return ""
    s = addr.lower()
    # Punctuation to spaces FIRST so "Apt. 4" -> "apt 4" and "#3" stays.
    s = re.sub(r"[.,]", " ", s)
    s = _STRIP_UNIT_RE.sub("", s)
    tokens = []
    for t in s.split():
        t = t.strip()
        if not t:
            continue
        if t in _STREET_TYPE_NORMS:
            t = _STREET_TYPE_NORMS[t]
        if t in _DIRECTION_NORMS:
            t = _DIRECTION_NORMS[t]
        tokens.append(t)
    return " ".join(tokens)


def _beds_compatible(a: dict, b: dict) -> bool:
    if a.get("beds") is not None and b.get("beds") is not None:
        return a["beds"] == b["beds"]
    return True  # one missing -> don't reject on beds alone


def _sqft_compatible(a: dict, b: dict, *, tolerance: float = 0.05) -> bool:
    sa, sb = a.get("sqft"), b.get("sqft")
    if sa and sb:
        return abs(sa - sb) / max(sa, sb) <= tolerance
    return True


def _approx_match(a: dict, b: dict, *, max_meters: float = 25.0) -> bool:
    """True if a and b look like the same house.

    Tries geo-match first (lat/lng both present + within max_meters).
    Falls back to normalized address + zip when one side lacks coords -
    important because Zillow drops coords on some unmapped listings.
    Both paths require beds + sqft sanity.
    """
    if not (_beds_compatible(a, b) and _sqft_compatible(a, b)):
        return False
    la, lna = a.get("lat"), a.get("lng")
    lb, lnb = b.get("lat"), b.get("lng")
    if la is not None and lna is not None and lb is not None and lnb is not None:
        if haversine_m(la, lna, lb, lnb) <= max_meters:
            return True
        # Both sides have coords but they're far apart -> definitely not same house.
        return False
    # Missing coords on at least one side; fall back to address-norm + zip.
    addr_a = normalize_address(a.get("address"))
    addr_b = normalize_address(b.get("address"))
    if not addr_a or not addr_b or addr_a != addr_b:
        return False
    za, zb = a.get("zip"), b.get("zip")
    if za and zb and za != zb:
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

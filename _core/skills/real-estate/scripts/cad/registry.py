"""County registry. Add new counties here.

Each entry is a module that exports NAME, STATE, FIPS, ZIPS, plus the
ExportInfo helpers (find_latest_export, find_local_extract).
"""
from __future__ import annotations

from .counties import travis as _travis

ADAPTERS = {
    _travis.NAME: _travis,
}


def for_zip(zip5: str | None):
    """Return the first adapter that claims the given zip, or None."""
    if not zip5:
        return None
    for ad in ADAPTERS.values():
        if zip5 in ad.ZIPS:
            return ad
    return None


def for_name(name: str):
    return ADAPTERS.get(name.lower())


def all_names() -> list[str]:
    return sorted(ADAPTERS.keys())

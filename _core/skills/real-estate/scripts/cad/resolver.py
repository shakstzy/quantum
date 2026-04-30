"""Address -> CAD adapter resolver.

For v1 we use zip-code routing only. Phase 2 can layer geocoding +
bounding-box detection for addresses that don't include a zip.
"""
from __future__ import annotations

import re

from . import registry


def resolve_from_address(address: str):
    """Return the CAD adapter responsible for this address, or None."""
    m = re.search(r"\b(\d{5})\b", address)
    if not m:
        return None
    return registry.for_zip(m.group(1))

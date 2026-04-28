"""Banned-niche regex filter.

Reads keyword list from `shared/policy/banned-niches.md` (the table cells with
`(regex, case-insensitive)`) and exposes `is_banned(text)`.

Single source of truth: the markdown file. We parse it on import to avoid drift.
"""
from __future__ import annotations

import re
from pathlib import Path

WS_ROOT = Path(__file__).resolve().parents[3]
POLICY = WS_ROOT / "shared" / "policy" / "banned-niches.md"


def _load_patterns() -> list[tuple[str, re.Pattern]]:
    if not POLICY.exists():
        return []
    out: list[tuple[str, re.Pattern]] = []
    for line in POLICY.read_text().splitlines():
        if not line.startswith("| ") or "regex" in line.lower() and "Trigger" in line:
            continue
        if "`" not in line:
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 4:
            continue
        category, _why, _ignored, pattern_cell = cells[0], cells[1], cells[2], cells[3]
        m = re.search(r"`([^`]+)`", pattern_cell)
        if not m:
            continue
        try:
            out.append((category, re.compile(m.group(1), re.IGNORECASE)))
        except re.error:
            continue
    return out


_PATTERNS = _load_patterns()


def is_banned(text: str) -> tuple[bool, list[str]]:
    if not text:
        return False, []
    hits: list[str] = []
    for cat, pat in _PATTERNS:
        if pat.search(text):
            hits.append(cat)
    return (len(hits) > 0), hits


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        b, hits = is_banned(" ".join(sys.argv[1:]))
        print(f"banned={b} categories={hits}")
    else:
        print(f"loaded {len(_PATTERNS)} patterns")

"""One-shot fixture capture for dev iteration.

Goal: dump the FULL InitialContext / __NEXT_DATA__ blob from a Redfin and
Zillow page so we can iterate parsing logic locally without hitting the
live target. Per the learning at raw/learnings/2026-04-28-cache-html-...,
this script is the ONLY live hit in the dev cycle. After it runs, all
parsing work happens against the JSON files it writes.

Usage:
    uv run python scripts/capture_fixtures.py redfin-property <url>
    uv run python scripts/capture_fixtures.py redfin-search "Austin, TX"
    uv run python scripts/capture_fixtures.py zillow-search-html <url>
    uv run python scripts/capture_fixtures.py zillow-property-html <url>

The zillow-* targets save the raw HTML; we parse __NEXT_DATA__ out of it
in fixture-driven analysis. We do NOT call the curl_cffi Zillow path here
because the IP is currently PX-flagged. Pass an HTML file from a browser
save-as instead, or use the html-input variant.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIX = HERE.parent / ".dev-fixtures"
FIX.mkdir(exist_ok=True)

sys.path.insert(0, str(HERE))


def dump(name: str, obj) -> Path:
    p = FIX / name
    with p.open("w") as f:
        if isinstance(obj, str):
            f.write(obj)
        else:
            json.dump(obj, f, indent=2, default=str)
    print(f"wrote {p} ({p.stat().st_size:,} bytes)", file=sys.stderr)
    return p


def capture_redfin_property(url: str) -> None:
    from redfin import _fetch_html  # type: ignore
    from redfin_parse import initial_context as _initial_context  # type: ignore
    html = _fetch_html(url)
    dump("redfin-property.html", html)
    ctx = _initial_context(html)
    dump("redfin-property-initial-context.json", ctx)
    cache = (ctx.get("ReactServerAgent.cache") or {}).get("dataCache") or {}
    keys = sorted(cache.keys())
    dump("redfin-property-cache-keys.json", keys)
    print(f"  cache has {len(keys)} keys", file=sys.stderr)
    for k in keys[:30]:
        print(f"    {k[:140]}", file=sys.stderr)


def capture_redfin_search(query: str) -> None:
    from redfin import _fetch_html, resolve_region  # type: ignore
    from redfin_parse import initial_context as _initial_context  # type: ignore
    region = resolve_region(query)
    url = region["url"]
    html = _fetch_html(url)
    dump("redfin-search.html", html)
    ctx = _initial_context(html)
    dump("redfin-search-initial-context.json", ctx)
    cache = (ctx.get("ReactServerAgent.cache") or {}).get("dataCache") or {}
    keys = sorted(cache.keys())
    dump("redfin-search-cache-keys.json", keys)
    print(f"  region={region['kind']} id={region['region_id']}", file=sys.stderr)
    print(f"  cache has {len(keys)} keys", file=sys.stderr)
    for k in keys[:30]:
        print(f"    {k[:140]}", file=sys.stderr)


def parse_zillow_html(html: str, label: str) -> None:
    """Parse __NEXT_DATA__ from a Zillow HTML blob (provided externally)."""
    dump(f"zillow-{label}.html", html)
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
                  html, re.DOTALL)
    if not m:
        print(f"  __NEXT_DATA__ not found in {label}", file=sys.stderr)
        return
    data = json.loads(m.group(1))
    dump(f"zillow-{label}-next-data.json", data)
    pp = ((data.get("props") or {}).get("pageProps") or {})
    print(f"  pageProps keys: {sorted(pp.keys())}", file=sys.stderr)
    if "componentProps" in pp:
        cp = pp["componentProps"]
        print(f"  componentProps keys: {sorted(cp.keys()) if isinstance(cp, dict) else type(cp).__name__}", file=sys.stderr)
        if isinstance(cp, dict) and "gdpClientCache" in cp:
            cache_raw = cp["gdpClientCache"]
            cache = json.loads(cache_raw) if isinstance(cache_raw, str) else cache_raw
            if isinstance(cache, dict):
                keys = sorted(cache.keys())
                print(f"  gdpClientCache has {len(keys)} keys", file=sys.stderr)
                for k in keys[:30]:
                    print(f"    {k[:140]}", file=sys.stderr)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 1
    cmd = sys.argv[1]
    if cmd == "redfin-property":
        capture_redfin_property(sys.argv[2])
    elif cmd == "redfin-search":
        capture_redfin_search(sys.argv[2])
    elif cmd in ("zillow-search-html", "zillow-property-html"):
        # Read HTML from stdin; we never hit Zillow live here.
        html = sys.stdin.read()
        parse_zillow_html(html, cmd.replace("zillow-", "").replace("-html", ""))
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

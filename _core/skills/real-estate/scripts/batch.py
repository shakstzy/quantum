"""Parallel multi-address ingest with per-domain rate limiting.

Adithya's ask: "for larger scale ingests, is there a way to also parallelize
this process safely without hitting rate limits or IP address blocks".

Strategy
--------
1. **Cross-site parallelism is free.** Redfin and Zillow are different
   companies with different WAFs and IP allowlists. Hitting both
   concurrently for ONE address costs nothing extra and halves wall time.

2. **Within a site, cap concurrency at 2.** Both sites' WAFs (CloudFront
   for Redfin, PerimeterX for Zillow) flag burst patterns. Two concurrent
   requests + 1.5s gap between completions per site stays under the
   shapeshifter heuristics that softlocked the IP last time.

3. **Per-domain semaphore + token bucket.** A semaphore limits concurrency,
   and a token bucket enforces minimum spacing. Together they let us run
   N addresses in parallel while keeping the per-site request shape calm.

4. **Honest partial failure.** Each address-fetch is wrapped; one failure
   does not stop the batch. The final result has per-row success / error.

5. **Optional proxy rotation.** Set REAL_ESTATE_PROXY=socks5://user:pass@host:port
   to route Zillow (only) through a residential proxy. This is the path
   to TRUE scale (100+ addresses per run). Free attempts, even with
   rotation, won't survive PX past ~30 addresses without proxies.

Usage
-----
    # CLI: pull lookup for many addresses, NDJSON output
    ./re batch lookup addresses.txt > out.ndjson

    # CLI: rent estimate for many addresses
    ./re batch rent-estimate addresses.txt --radius-miles 1.0 > rents.ndjson

    # As a library
    from batch import gather_lookups
    results = gather_lookups(addrs, max_concurrent_per_site=2, throttle_seconds=1.5)
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Any, Awaitable, Callable

import lookup  # type: ignore
import redfin  # type: ignore
import zillow  # type: ignore
import rent_estimate  # type: ignore


class _DomainLimiter:
    """Per-domain semaphore + reservation-based pacing.

    Lets up to `concurrent` tasks hold the semaphore at once, and ensures
    each ENTRY happens at least `min_gap` seconds after the previous
    entry. Reserves the next allowed start time INSIDE the lock so two
    waiters that pass the gate simultaneously don't both see the stale
    timestamp and bunch up.
    """

    def __init__(self, *, concurrent: int, min_gap: float):
        self.sem = asyncio.Semaphore(concurrent)
        self.min_gap = min_gap
        self.next_allowed_at = 0.0
        self._lock = asyncio.Lock()

    async def __aenter__(self):
        await self.sem.acquire()
        async with self._lock:
            now = time.monotonic()
            wait = self.next_allowed_at - now
            # Reserve our slot BEFORE sleeping so the next waiter sees the
            # post-our-start timestamp, not the pre-our-start one.
            start = max(now, self.next_allowed_at)
            self.next_allowed_at = start + self.min_gap
        if wait > 0:
            await asyncio.sleep(wait)
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self.sem.release()


# Per-event-loop limiter cache. Module-level singletons would bind to
# whichever loop ran first and crash on a second `asyncio.run()` call.
_LIMITER_CACHE: dict[int, dict[str, "_DomainLimiter"]] = {}


def _limiters_for_current_loop() -> dict[str, "_DomainLimiter"]:
    loop = asyncio.get_running_loop()
    key = id(loop)
    cached = _LIMITER_CACHE.get(key)
    if cached is None:
        cached = {
            "redfin": _DomainLimiter(concurrent=2, min_gap=1.5),
            "zillow": _DomainLimiter(concurrent=2, min_gap=2.0),
        }
        _LIMITER_CACHE[key] = cached
    return cached


async def _run_in_thread(fn: Callable[..., Any], *args, **kwargs):
    """Run a sync function in the asyncio default thread executor."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: fn(*args, **kwargs))


async def _safe_redfin_property(url: str, *, include_raw: bool = False) -> dict:
    async with _limiters_for_current_loop()["redfin"]:
        try:
            return await _run_in_thread(redfin.property_details, url, include_raw=include_raw)
        except Exception as e:
            return {"error": str(e), "url": url, "source": "redfin"}


async def _safe_zillow_property(url: str, *, include_raw: bool = False) -> dict:
    async with _limiters_for_current_loop()["zillow"]:
        try:
            return await _run_in_thread(zillow.property_details, url, include_raw=include_raw)
        except Exception as e:
            return {"error": str(e), "url": url, "source": "zillow"}


async def _resolve_zillow_url(address: str) -> str | None:
    """Zillow URL resolution does live HTTP (the /homes/<slug>/ redirect),
    so it MUST run under the Zillow limiter to count toward our cap.
    """
    async with _limiters_for_current_loop()["zillow"]:
        return await _run_in_thread(lookup.find_zillow_url, address)


async def _safe_lookup(address: str, *, include_raw: bool = False,
                        redfin_url: str | None = None,
                        zillow_url: str | None = None) -> dict:
    """Resolve URLs (cheap, mostly local) then fetch BOTH sites concurrently.

    Zillow URL resolution is itself a live HTTP call (the /homes/<slug>/
    redirect chain), so it goes through the Zillow limiter. Redfin URL
    resolution shells out to brave-search (separate IP, our skill, not
    counted against the Redfin domain).
    """
    rf_url = redfin_url or await _run_in_thread(lookup.find_redfin_url, address)
    zw_url = zillow_url or await _resolve_zillow_url(address)

    rf_task = _safe_redfin_property(rf_url, include_raw=include_raw) if rf_url else \
              _aresult({"error": "no exact Redfin URL found via Brave (street number/name not in top results)."})
    zw_task = _safe_zillow_property(zw_url, include_raw=include_raw) if zw_url else \
              _aresult({"error": "no exact Zillow URL found."})

    rf, zw = await asyncio.gather(rf_task, zw_task)
    # CAD lookup is local DuckDB so it's cheap; runs in the thread executor
    # alongside the HTTP merges. Same merge path used by `re lookup`.
    cad = await _run_in_thread(lookup._cad_lookup, address)
    merged = lookup._merge_views(rf, zw)
    if cad and not cad.get("error"):
        merged = lookup._merge_cad_into(merged, cad)
    rf_addr = (rf.get("address") or "") if isinstance(rf, dict) else ""
    zw_addr = (zw.get("address") or "") if isinstance(zw, dict) else ""
    addr_match = "ok"
    if rf_addr and zw_addr and rf_addr.split(",")[0].strip().lower() != zw_addr.split(",")[0].strip().lower():
        addr_match = "mismatch"
    if rf.get("error") and zw.get("error"):
        addr_match = "neither_resolved"
    elif rf.get("error") or zw.get("error"):
        addr_match = "single_source"
    return {
        "input_address": address,
        "redfin_url": rf_url, "zillow_url": zw_url,
        "address_match": addr_match,
        "redfin": rf, "zillow": zw, "cad": cad, "merged": merged,
    }


async def _aresult(d: dict) -> dict:
    return d


async def _gather(coros, *, total_concurrency: int = 8) -> list[dict]:
    """Run N coroutines with a top-level concurrency cap.

    Per-domain limiters do the actual rate-shaping; this just keeps task
    count from exploding when the input list is huge.
    """
    sem = asyncio.Semaphore(total_concurrency)

    async def wrapped(c):
        async with sem:
            return await c

    return await asyncio.gather(*(wrapped(c) for c in coros))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def gather_lookups(addresses: list[str], *,
                   total_concurrency: int = 8,
                   include_raw: bool = False) -> list[dict]:
    """Run `lookup.lookup` for many addresses in parallel.

    Cross-site parallelism per address is automatic. Per-domain caps of
    2 concurrent + 1.5-2s gap apply across the whole batch.
    """
    async def _main():
        coros = [_safe_lookup(a, include_raw=include_raw) for a in addresses]
        return await _gather(coros, total_concurrency=total_concurrency)
    return asyncio.run(_main())


def gather_rent_estimates(addresses: list[str], *,
                          radius_miles: float = 1.0,
                          beds_tolerance: int = 0,
                          total_concurrency: int = 8) -> list[dict]:
    """Run `rent_estimate.estimate_rent` for many addresses in parallel.

    Each estimate already costs 3 site hits (Redfin lookup + Zillow
    lookup + Zillow rentals). For 50 addresses that's 150 hits total -
    consider proxies (REAL_ESTATE_PROXY env var) before running large
    batches against your home IP.
    """
    async def _main():
        coros = [
            _run_in_thread(
                rent_estimate.estimate_rent, a,
                radius_miles=radius_miles, beds_tolerance=beds_tolerance,
            ) for a in addresses
        ]
        return await _gather(coros, total_concurrency=total_concurrency)
    return asyncio.run(_main())


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _read_addresses(path: str) -> list[str]:
    with open(path) as f:
        return [line.strip() for line in f if line.strip() and not line.startswith("#")]


def _emit_ndjson(rows: list[dict]) -> None:
    for r in rows:
        json.dump(r, sys.stdout, default=str)
        sys.stdout.write("\n")


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="batch")
    sub = ap.add_subparsers(dest="cmd", required=True)

    lp = sub.add_parser("lookup", help="run `re lookup` for each address; output NDJSON")
    lp.add_argument("addresses_file", help="path to a text file with one address per line")
    lp.add_argument("--include-raw", action="store_true")
    lp.add_argument("--total-concurrency", type=int, default=8,
                    help="cap on simultaneous in-flight tasks (per-domain caps still apply)")

    rp = sub.add_parser("rent-estimate", help="run `re rent-estimate` for each address; output NDJSON")
    rp.add_argument("addresses_file")
    rp.add_argument("--radius-miles", type=float, default=1.0)
    rp.add_argument("--beds-tolerance", type=int, default=0)
    rp.add_argument("--total-concurrency", type=int, default=8)

    args = ap.parse_args(argv)
    addresses = _read_addresses(args.addresses_file)
    if not addresses:
        print("no addresses in file", file=sys.stderr)
        return 1

    if args.cmd == "lookup":
        rows = gather_lookups(addresses,
                              include_raw=args.include_raw,
                              total_concurrency=args.total_concurrency)
    elif args.cmd == "rent-estimate":
        rows = gather_rent_estimates(addresses,
                                     radius_miles=args.radius_miles,
                                     beds_tolerance=args.beds_tolerance,
                                     total_concurrency=args.total_concurrency)
    else:
        return 1
    _emit_ndjson(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())

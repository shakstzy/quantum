"""CAD CLI subcommands.

Wired into the top-level `re` script as:
    re cad refresh travis              # download + ingest latest export
    re cad lookup "5509 Casco Walk"    # look up by address
    re cad summary                      # show what's ingested
    re cad ingest-local travis --dir ~/.quantum/.../extracted  # for hand-downloaded data
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import Request, urlopen

from . import registry, resolver, store


def _fmt_row(d: dict) -> str:
    return json.dumps(d, default=str, ensure_ascii=False)


def _download(url: str, dest: Path) -> None:
    """Stream a large file to disk with a progress indicator."""
    print(f"downloading {url} -> {dest}", file=sys.stderr)
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    t0 = time.monotonic()
    with urlopen(req, timeout=60) as resp, open(dest, "wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        got = 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            mb_s = (got / (time.monotonic() - t0)) / (1 << 20) if time.monotonic() > t0 else 0
            pct = (100 * got / total) if total else 0
            sys.stderr.write(f"\r  {got/(1<<20):,.0f} MB / {total/(1<<20):,.0f} MB  ({pct:.1f}%, {mb_s:.1f} MB/s)")
            sys.stderr.flush()
    sys.stderr.write("\n")


def cmd_refresh(args):
    ad = registry.for_name(args.county)
    if not ad:
        print(f"unknown county: {args.county}. known: {', '.join(registry.all_names())}", file=sys.stderr)
        return 2
    if not args.skip_download:
        info = ad.find_latest_export()
        if not info:
            print("could not locate latest export URL", file=sys.stderr)
            return 1
        print(f"latest: {info.kind} {info.year} -> {info.url}", file=sys.stderr)
        cache = ad.cache_dir()
        cache.mkdir(parents=True, exist_ok=True)
        zip_path = cache / "raw" / Path(info.url).name.replace("%20", "_")
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        if zip_path.exists() and not args.force_download:
            print(f"already have {zip_path} (use --force-download to refetch)", file=sys.stderr)
        else:
            _download(info.url, zip_path)
        # extract
        extract_dir = cache / "extracted"
        extract_dir.mkdir(parents=True, exist_ok=True)
        # only re-extract if PROP.TXT is missing or older than the zip
        prop_path = extract_dir / ad.PROP_FILE
        if not prop_path.exists() or prop_path.stat().st_mtime < zip_path.stat().st_mtime:
            print(f"extracting to {extract_dir}", file=sys.stderr)
            subprocess.run(
                ["unzip", "-oq", str(zip_path), "-d", str(extract_dir)],
                check=True,
            )
        else:
            print(f"already extracted at {extract_dir}", file=sys.stderr)
        val_year = info.year
    else:
        extract_dir = ad.find_local_extract()
        if not extract_dir:
            print(f"no local extract found for {args.county}", file=sys.stderr)
            return 1
        val_year = args.val_year or 0  # caller must specify

    if not val_year:
        print("--val-year required when --skip-download is set", file=sys.stderr)
        return 2

    con = store.open_db()
    try:
        prop_path = extract_dir / ad.PROP_FILE
        imp_path = extract_dir / ad.IMP_DET_FILE
        land_path = extract_dir / ad.LAND_DET_FILE

        print(f"ingesting parcels from {prop_path}", file=sys.stderr)
        store.ingest_parcels(con, prop_path, ad.NAME, val_year=val_year)
        if land_path.exists():
            print(f"ingesting land from {land_path}", file=sys.stderr)
            store.ingest_land_detail(con, land_path, ad.NAME, val_year=val_year)
        if imp_path.exists():
            print(f"ingesting improvements_detail from {imp_path}", file=sys.stderr)
            store.ingest_improvements_detail(con, imp_path, ad.NAME, val_year=val_year)
        # Optionally: prune extracted files to free disk
        if args.prune_after:
            print(f"pruning {extract_dir}", file=sys.stderr)
            shutil.rmtree(extract_dir, ignore_errors=True)
    finally:
        con.close()
    return 0


def cmd_lookup(args):
    ad = None
    if args.county:
        ad = registry.for_name(args.county)
    if ad is None:
        ad = resolver.resolve_from_address(args.address)
    county = ad.NAME if ad else None

    con = store.open_db()
    try:
        candidates = store.lookup_address(con, args.address, county=county)
        if not candidates:
            print(json.dumps({"error": "no matching parcels", "address": args.address, "county": county}))
            return 1
        if args.full and len(candidates) == 1:
            full = store.get_property_full(con, candidates[0]["county"], candidates[0]["prop_id"],
                                           val_year=candidates[0]["val_year"])
            print(_fmt_row(full or {}))
        else:
            for c in candidates:
                print(_fmt_row({
                    "county": c["county"], "prop_id": c["prop_id"], "val_year": c["val_year"],
                    "geo_id": c.get("geo_id"),
                    "owner": c.get("owner_name"),
                    "situs": f"{(c.get('situs_full') or '').strip()} {c.get('situs_city') or ''} {c.get('situs_zip') or ''}".strip(),
                    "appraised_val": c.get("appraised_val"),
                    "assessed_val": c.get("assessed_val"),
                    "market_val": c.get("market_val"),
                    "legal_acreage": c.get("legal_acreage"),
                    "hs_exempt": c.get("hs_exempt"),
                    "deed_dt": c.get("deed_dt"),
                }))
    finally:
        con.close()
    return 0


def cmd_summary(_args):
    con = store.open_db()
    try:
        print(json.dumps(store.get_db_summary(con), default=str, indent=2))
    finally:
        con.close()
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="re-cad")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("refresh", help="download + ingest latest CAD export")
    r.add_argument("county", help=f"one of: {', '.join(registry.all_names())}")
    r.add_argument("--skip-download", action="store_true",
                   help="reuse the local extract instead of re-downloading")
    r.add_argument("--force-download", action="store_true")
    r.add_argument("--val-year", type=int, help="required if --skip-download")
    r.add_argument("--prune-after", action="store_true",
                   help="delete the extracted .TXT files after ingest to save disk")
    r.set_defaults(fn=cmd_refresh)

    l = sub.add_parser("lookup", help="look up an address against the local CAD store")
    l.add_argument("address")
    l.add_argument("--county", help="force a specific county; default is zip-based routing")
    l.add_argument("--full", action="store_true", help="return improvements + land if single match")
    l.set_defaults(fn=cmd_lookup)

    sub.add_parser("summary", help="show ingested counties + parcel counts").set_defaults(fn=cmd_summary)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())

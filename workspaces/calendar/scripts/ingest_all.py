#!/usr/bin/env python3
"""All-history calendar ingest for one account.

- Lists all calendars, then dumps every event from each calendar.
- Window: 2000-01-01 through one year from today.
- Output: raw/calendar/<account>/<calendar-slug>.ndjson (one event per line).
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[3]
RAW = ROOT / "raw" / "calendar"

START = "2000-01-01"
PACE_SEC = 0.1
MAX_RETRIES = 6


def gog_json(args: list[str]) -> dict | list:
    delay = 1.0
    last_err = ""
    for _ in range(MAX_RETRIES):
        proc = subprocess.run(["gog", "-j", *args], check=False, capture_output=True, text=True)
        if proc.returncode == 0:
            return json.loads(proc.stdout) if proc.stdout.strip() else {}
        last_err = proc.stderr.strip()
        retryable = any(t in last_err for t in (
            "rateLimitExceeded", "userRateLimitExceeded", "Quota exceeded",
            "429", "503", "backendError", "internalError",
        ))
        if not retryable:
            raise RuntimeError(f"gog {' '.join(args)} failed (exit {proc.returncode}): {last_err}")
        time.sleep(delay)
        delay = min(delay * 2, 60.0)
    raise RuntimeError(f"gog {' '.join(args)} failed after {MAX_RETRIES} retries: {last_err}")


def slugify_account(account: str) -> str:
    return account.replace("@", "-").replace(".", "-")


def slugify_calendar(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", s)[:80].strip("-").lower() or "cal"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--account", required=True)
    args = parser.parse_args()
    account = args.account
    slug = slugify_account(account)

    out_dir = RAW / slug
    out_dir.mkdir(parents=True, exist_ok=True)

    end = (dt.date.today() + dt.timedelta(days=365)).isoformat()
    print(f"[{account}] window: {START} -> {end}", flush=True)

    cals_result = gog_json(["-a", account, "calendar", "calendars"])
    cals = (cals_result or {}).get("calendars") or cals_result if isinstance(cals_result, list) else (cals_result or {}).get("calendars") or []
    if isinstance(cals_result, dict) and "items" in cals_result:
        cals = cals_result["items"]
    print(f"[{account}] calendars: {len(cals)}", flush=True)

    for cal in cals:
        cal_id = cal.get("id") or cal.get("calendarId")
        summary = cal.get("summary") or cal.get("name") or cal_id or "calendar"
        if not cal_id:
            continue
        cal_slug = slugify_calendar(summary)
        out_path = out_dir / f"{cal_slug}.ndjson"
        print(f"[{account}]   pulling {summary} ({cal_id}) -> {out_path.name}", flush=True)
        page_token = None
        page_n = 0
        with out_path.open("w") as fh:
            while True:
                page_n += 1
                cmd = [
                    "-a", account,
                    "calendar", "events",
                    "--cal", cal_id,
                    "--from", START,
                    "--to", end,
                    "--max", "500",
                ]
                if page_token:
                    cmd += ["--page", page_token]
                result = gog_json(cmd)
                events = (result or {}).get("events") or (result or {}).get("items") or []
                for ev in events:
                    fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
                page_token = (result or {}).get("nextPageToken")
                print(f"[{account}]     page {page_n}: +{len(events)} events", flush=True)
                if not page_token:
                    break
                time.sleep(PACE_SEC)

    print(f"[{account}] done.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

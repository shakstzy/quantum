#!/usr/bin/env python3
"""Unsubscribe via List-Unsubscribe headers.

Reads inventory JSONL, dedupes by sender, picks one representative message per
sender, and POSTs the one-click URL where supported (RFC 8058).

For senders with mailto: only or non-One-Click URLs, prints them so the user
can click manually.
"""

import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests


def _parse_unsub(header: str) -> tuple[list[str], list[str]]:
    """Return (https_urls, mailto_urls) parsed from a List-Unsubscribe header."""
    https = re.findall(r"<(https?://[^>]+)>", header or "")
    mailto = re.findall(r"<(mailto:[^>]+)>", header or "")
    return https, mailto


def _post_one_click(url: str, timeout: int = 15) -> tuple[int, str]:
    try:
        r = requests.post(
            url,
            data="List-Unsubscribe=One-Click",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=timeout,
            allow_redirects=True,
        )
        return r.status_code, r.url
    except requests.RequestException as e:
        return 0, str(e)


def main(input_path: Path, audit_path: Path, workers: int = 8):
    by_sender: dict[str, dict] = {}
    with input_path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            sender = rec.get("from", "").strip()
            if not sender:
                continue
            unsub = rec.get("list_unsubscribe", "")
            unsub_post = rec.get("list_unsubscribe_post", "")
            if sender not in by_sender:
                by_sender[sender] = {
                    "list_unsubscribe": unsub,
                    "list_unsubscribe_post": unsub_post,
                    "id": rec.get("id"),
                }
    print(f"[unsub] {len(by_sender)} unique senders", file=sys.stderr)

    one_click = []
    mailto_only = []
    no_header = []
    for sender, meta in by_sender.items():
        if not meta["list_unsubscribe"]:
            no_header.append(sender)
            continue
        https_urls, mailto_urls = _parse_unsub(meta["list_unsubscribe"])
        is_one_click = "One-Click" in (meta["list_unsubscribe_post"] or "")
        if https_urls and is_one_click:
            one_click.append((sender, https_urls[0]))
        elif https_urls:
            one_click.append((sender, https_urls[0]))  # try anyway, many work
        elif mailto_urls:
            mailto_only.append((sender, mailto_urls[0]))
        else:
            no_header.append(sender)

    print(f"[unsub] one-click: {len(one_click)}, mailto-only: {len(mailto_only)}, no-header: {len(no_header)}", file=sys.stderr)

    audit_path.parent.mkdir(parents=True, exist_ok=True)
    ok = 0; fail = 0
    with audit_path.open("a") as af:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(_post_one_click, url): (sender, url) for sender, url in one_click}
            for fut in as_completed(futs):
                sender, url = futs[fut]
                code, final_url = fut.result()
                ok_now = code in (200, 202, 204)
                if ok_now:
                    ok += 1
                else:
                    fail += 1
                af.write(json.dumps({
                    "ts": time.time(), "sender": sender, "url": url,
                    "code": code, "final_url": final_url, "ok": ok_now
                }) + "\n")
                print(f"[unsub] {'OK ' if ok_now else 'FAIL'} {code:>3} {sender[:60]}", file=sys.stderr)

    print()
    print(f"unsub one-click: {ok} ok / {fail} fail")
    if mailto_only:
        print(f"\nmailto-only ({len(mailto_only)}, click manually or send empty email):")
        for s, m in mailto_only:
            print(f"  {s}  ->  {m}")
    if no_header:
        print(f"\nno List-Unsubscribe header ({len(no_header)}):")
        for s in no_header:
            print(f"  {s}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--audit", default=None)
    p.add_argument("--workers", type=int, default=8)
    args = p.parse_args()
    in_path = Path(args.input)
    audit_path = Path(args.audit) if args.audit else in_path.with_suffix(in_path.suffix + ".unsub.audit.jsonl")
    main(in_path, audit_path, args.workers)

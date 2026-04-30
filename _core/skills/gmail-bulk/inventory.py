#!/usr/bin/env python3
"""Inventory: search query -> JSONL of matching messages with metadata.

Pulls IDs via users.messages.list (paged), then fetches headers in parallel
batches via users.messages.get with format=metadata.

Output JSONL fields: id, threadId, from, subject, date, snippet, labels,
list_unsubscribe, list_unsubscribe_post.
"""

import argparse
import json
import sys
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from auth import get_creds

SKILL_DIR = Path(__file__).resolve().parent


def _service(email: str):
    return build("gmail", "v1", credentials=get_creds(email), cache_discovery=False)


def _list_ids(svc, query: str, limit: int | None = None):
    ids = []
    page_token = None
    while True:
        resp = svc.users().messages().list(
            userId="me", q=query, maxResults=500, pageToken=page_token
        ).execute()
        for m in resp.get("messages", []):
            ids.append((m["id"], m["threadId"]))
            if limit and len(ids) >= limit:
                return ids
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return ids


def _extract_headers(payload: dict) -> dict:
    headers = {h["name"].lower(): h["value"] for h in payload.get("headers", [])}
    return headers


def _get_metadata(svc, mid: str, retries: int = 3):
    for attempt in range(retries):
        try:
            return svc.users().messages().get(
                userId="me", id=mid, format="metadata",
                metadataHeaders=["From", "Subject", "Date", "List-Unsubscribe", "List-Unsubscribe-Post"]
            ).execute()
        except HttpError as e:
            if e.resp.status in (429, 500, 503):
                time.sleep(2 ** attempt)
                continue
            return {"id": mid, "_error": str(e)}
    return {"id": mid, "_error": "exhausted retries"}


def inventory(email: str, query: str, out_path: Path, fetch_metadata: bool = True, workers: int = 16):
    svc = _service(email)
    print(f"[inventory] query='{query}' account={email}", file=sys.stderr)
    t0 = time.time()
    ids = _list_ids(svc, query)
    print(f"[inventory] {len(ids)} message IDs in {time.time()-t0:.1f}s", file=sys.stderr)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if not fetch_metadata:
        with out_path.open("w") as f:
            for mid, tid in ids:
                f.write(json.dumps({"id": mid, "threadId": tid}) + "\n")
        return len(ids)
    n_done = 0
    t0 = time.time()
    with out_path.open("w") as f:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            future_map = {ex.submit(_get_metadata, svc, mid): (mid, tid) for mid, tid in ids}
            for fut in as_completed(future_map):
                msg = fut.result()
                mid, tid = future_map[fut]
                headers = _extract_headers(msg.get("payload", {})) if "payload" in msg else {}
                rec = {
                    "id": msg.get("id", mid),
                    "threadId": msg.get("threadId", tid),
                    "snippet": msg.get("snippet", ""),
                    "labels": msg.get("labelIds", []),
                    "from": headers.get("from", ""),
                    "subject": headers.get("subject", ""),
                    "date": headers.get("date", ""),
                    "list_unsubscribe": headers.get("list-unsubscribe", ""),
                    "list_unsubscribe_post": headers.get("list-unsubscribe-post", ""),
                }
                if "_error" in msg:
                    rec["_error"] = msg["_error"]
                f.write(json.dumps(rec) + "\n")
                n_done += 1
                if n_done % 200 == 0:
                    print(f"[inventory] fetched {n_done}/{len(ids)}", file=sys.stderr)
    print(f"[inventory] wrote {n_done} records to {out_path} in {time.time()-t0:.1f}s", file=sys.stderr)
    return n_done


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("-a", "--account", required=True)
    p.add_argument("-q", "--query", required=True)
    p.add_argument("-o", "--out", required=True)
    p.add_argument("--no-metadata", action="store_true", help="only collect IDs, skip header fetch (fastest)")
    p.add_argument("--workers", type=int, default=16)
    args = p.parse_args()
    inventory(args.account, args.query, Path(args.out), fetch_metadata=not args.no_metadata, workers=args.workers)

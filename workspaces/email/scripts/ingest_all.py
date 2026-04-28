#!/usr/bin/env python3
"""All-time Gmail ingest for one account.

- Paginates `gog gmail messages search` to enumerate all message IDs (excluding trash/spam).
- Dedupes by threadId, fetches each thread once via `gog gmail thread get`.
- Strips noisy SMTP headers and any attachment payloads (keeps attachment metadata only).
- Writes NDJSON sharded by year-month into raw/email/<account>/YYYY-MM.ndjson.
- Resumable: tracks processed thread IDs in raw/.ingest-log/email-<account>.threads.txt.
- Paced at 5 req/sec to stay well under Gmail's 250 quota-units/sec/user budget.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import os
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[3]
RAW = ROOT / "raw" / "email"
LOG = ROOT / "raw" / ".ingest-log"

# Headers worth keeping. Everything else (DKIM, ARC, Received, X-*, Authentication-Results, etc.) is dropped.
KEEP_HEADERS = {
    "from", "to", "cc", "bcc", "reply-to", "subject", "date",
    "message-id", "in-reply-to", "references", "list-id", "list-unsubscribe",
}

PACE_SEC = 0.3  # ~3.3 req/sec; Gmail's standard per-user limit is 250 queries/min (~4/sec)
MAX_RETRIES = 6  # Exponential backoff on 429/rateLimitExceeded


def gog_json(args: list[str]) -> dict | list:
    """Run gog with -j; retry with exponential backoff on rate-limit / 429 / 503."""
    delay = 1.0
    last_err = ""
    for attempt in range(MAX_RETRIES):
        proc = subprocess.run(["gog", "-j", *args], check=False, capture_output=True, text=True)
        if proc.returncode == 0:
            return json.loads(proc.stdout) if proc.stdout.strip() else {}
        last_err = proc.stderr.strip()
        retryable = any(token in last_err for token in (
            "rateLimitExceeded", "userRateLimitExceeded", "Quota exceeded",
            "429", "503", "500", "502", "504",
            "backendError", "internalError",
            "TLS handshake timeout", "i/o timeout", "context deadline",
            "connection reset", "EOF", "no such host", "temporary failure",
        ))
        if not retryable:
            raise RuntimeError(f"gog {' '.join(args)} failed (exit {proc.returncode}): {last_err}")
        time.sleep(delay)
        delay = min(delay * 2, 60.0)
    raise RuntimeError(f"gog {' '.join(args)} failed after {MAX_RETRIES} retries: {last_err}")


def slugify(account: str) -> str:
    return account.replace("@", "-").replace(".", "-")


def strip_payload(payload: dict) -> dict:
    """Strip attachment binaries; keep attachment metadata. Recurse into multipart.

    For multipart/alternative with both text/plain and text/html siblings, drop the
    text/html sibling -- plaintext carries the same content at ~10x less weight.
    """
    if not payload:
        return payload
    out = {
        "mimeType": payload.get("mimeType"),
        "filename": payload.get("filename"),
        "headers": [
            {"name": h.get("name", ""), "value": h.get("value", "")}
            for h in payload.get("headers", [])
            if h.get("name", "").lower() in KEEP_HEADERS
        ],
    }
    body = payload.get("body", {}) or {}
    mt = (payload.get("mimeType") or "").lower()
    if mt.startswith("text/"):
        if "data" in body:
            out["body"] = {"data": body["data"], "size": body.get("size")}
        elif "attachmentId" in body:
            out["body"] = {"attachmentId": body["attachmentId"], "size": body.get("size")}
        else:
            out["body"] = {"size": body.get("size")}
    else:
        if "attachmentId" in body or payload.get("filename"):
            out["attachment"] = {
                "filename": payload.get("filename"),
                "mimeType": payload.get("mimeType"),
                "size": body.get("size"),
                "attachmentId": body.get("attachmentId"),
            }
    parts = payload.get("parts") or []
    if parts:
        sibling_mts = {(p.get("mimeType") or "").lower() for p in parts}
        kept_parts = []
        for p in parts:
            p_mt = (p.get("mimeType") or "").lower()
            if p_mt == "text/html" and "text/plain" in sibling_mts:
                kept_parts.append({
                    "mimeType": "text/html",
                    "body": {"size": (p.get("body") or {}).get("size"), "dropped": "plaintext-sibling-present"},
                })
                continue
            kept_parts.append(strip_payload(p))
        out["parts"] = kept_parts
    return out


def slim_message(msg: dict) -> dict:
    return {
        "id": msg.get("id"),
        "threadId": msg.get("threadId"),
        "internalDate": msg.get("internalDate"),
        "labelIds": msg.get("labelIds"),
        "snippet": msg.get("snippet"),
        "historyId": msg.get("historyId"),
        "sizeEstimate": msg.get("sizeEstimate"),
        "payload": strip_payload(msg.get("payload") or {}),
    }


def shard_for(thread: dict) -> str:
    msgs = thread.get("messages") or []
    if not msgs:
        return "unknown"
    try:
        ts_ms = int(msgs[0].get("internalDate") or 0)
        if ts_ms == 0:
            return "unknown"
        d = dt.datetime.fromtimestamp(ts_ms / 1000)
        return d.strftime("%Y-%m")
    except (ValueError, TypeError, OSError):
        return "unknown"


def enumerate_threads(account: str) -> list[str]:
    """Page through `gog gmail messages search` and return unique thread IDs."""
    print(f"[{account}] enumerating thread IDs...", flush=True)
    seen: set[str] = set()
    order: list[str] = []
    page_token: str | None = None
    page_n = 0
    while True:
        page_n += 1
        args = [
            "-a", account,
            "gmail", "messages", "search",
            "in:anywhere -in:trash -in:spam",
            "--max", "500",
        ]
        if page_token:
            args += ["--page", page_token]
        result = gog_json(args)
        msgs = (result or {}).get("messages") or []
        for m in msgs:
            tid = m.get("threadId")
            if tid and tid not in seen:
                seen.add(tid)
                order.append(tid)
        page_token = (result or {}).get("nextPageToken")
        print(f"[{account}]   page {page_n}: +{len(msgs)} msgs, {len(seen)} unique threads", flush=True)
        if not page_token:
            break
        time.sleep(PACE_SEC)
    print(f"[{account}] total unique threads: {len(seen)}", flush=True)
    return order


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--account", required=True)
    args = parser.parse_args()
    account = args.account
    slug = slugify(account)

    out_dir = RAW / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    LOG.mkdir(parents=True, exist_ok=True)
    state_path = LOG / f"email-{slug}.threads.txt"
    err_path = LOG / f"email-{slug}.errors.log"

    processed: set[str] = set()
    if state_path.exists():
        processed = {line.strip() for line in state_path.read_text().splitlines() if line.strip()}
        print(f"[{account}] resuming: {len(processed)} threads already processed", flush=True)

    thread_ids = enumerate_threads(account)
    todo = [tid for tid in thread_ids if tid not in processed]
    print(f"[{account}] {len(todo)} threads to fetch", flush=True)

    shard_handles: dict[str, any] = {}
    state_fh = state_path.open("a")
    err_fh = err_path.open("a")

    try:
        for i, tid in enumerate(todo, 1):
            try:
                result = gog_json(["-a", account, "gmail", "thread", "get", tid])
            except Exception as e:
                err_fh.write(f"{tid}\t{e}\n")
                err_fh.flush()
                continue
            thread = (result or {}).get("thread") or {}
            if not thread:
                err_fh.write(f"{tid}\tempty thread\n")
                err_fh.flush()
                continue
            msgs = thread.get("messages") or []
            slim = {
                "threadId": thread.get("id"),
                "historyId": thread.get("historyId"),
                "messages": [slim_message(m) for m in msgs],
            }
            shard = shard_for(thread)
            if shard not in shard_handles:
                shard_handles[shard] = (out_dir / f"{shard}.ndjson").open("a")
            shard_handles[shard].write(json.dumps(slim, ensure_ascii=False) + "\n")
            shard_handles[shard].flush()
            state_fh.write(tid + "\n")
            state_fh.flush()
            if i % 50 == 0:
                print(f"[{account}]   fetched {i}/{len(todo)}", flush=True)
            time.sleep(PACE_SEC)
    finally:
        for fh in shard_handles.values():
            fh.close()
        state_fh.close()
        err_fh.close()

    print(f"[{account}] done.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

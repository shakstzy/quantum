#!/usr/bin/env python3
"""Bulk action runner: trash / archive / add-label / remove-label / delete-permanent.

Uses users.messages.batchModify (1000 messages per call) for label changes,
users.messages.batchDelete for permanent deletion (max 1000 per call).

Input: JSONL file (from inventory.py) OR plain text file with one message ID per line.
Output: prints summary; writes <input>.audit.jsonl with per-batch results.
"""

import argparse
import json
import sys
import time
from pathlib import Path
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from auth import get_creds

CHUNK = 1000  # Gmail batchModify limit


def _service(email: str):
    return build("gmail", "v1", credentials=get_creds(email), cache_discovery=False)


def _read_ids(path: Path):
    ids = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith("{"):
                try:
                    obj = json.loads(line)
                    mid = obj.get("id")
                    if mid:
                        ids.append(mid)
                except json.JSONDecodeError:
                    pass
            else:
                ids.append(line)
    return ids


ACTION_LABEL_DELTAS = {
    "trash":          {"addLabelIds": ["TRASH"],  "removeLabelIds": ["INBOX"]},
    "archive":        {"addLabelIds": [],          "removeLabelIds": ["INBOX"]},
    "untrash":        {"addLabelIds": ["INBOX"],   "removeLabelIds": ["TRASH"]},
    "mark-read":      {"addLabelIds": [],          "removeLabelIds": ["UNREAD"]},
    "mark-unread":    {"addLabelIds": ["UNREAD"],  "removeLabelIds": []},
}


def run(email: str, action: str, ids: list[str], dry_run: bool, audit_path: Path, force: bool):
    print(f"[bulk] account={email} action={action} ids={len(ids)} dry_run={dry_run}", file=sys.stderr)
    if dry_run:
        print(f"[bulk] would process {len(ids)} messages in {(len(ids) + CHUNK - 1) // CHUNK} batches")
        return
    if action in ACTION_LABEL_DELTAS:
        delta = ACTION_LABEL_DELTAS[action]
        svc = _service(email)
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        success_total = 0
        with audit_path.open("a") as af:
            t0 = time.time()
            for i in range(0, len(ids), CHUNK):
                chunk = ids[i:i + CHUNK]
                body = {"ids": chunk, **delta}
                attempt = 0
                while True:
                    try:
                        svc.users().messages().batchModify(userId="me", body=body).execute()
                        success_total += len(chunk)
                        af.write(json.dumps({"ts": time.time(), "action": action, "batch": i // CHUNK, "n": len(chunk), "ok": True}) + "\n")
                        break
                    except HttpError as e:
                        if e.resp.status in (429, 500, 503) and attempt < 4:
                            time.sleep(2 ** attempt)
                            attempt += 1
                            continue
                        af.write(json.dumps({"ts": time.time(), "action": action, "batch": i // CHUNK, "n": len(chunk), "ok": False, "error": str(e)}) + "\n")
                        break
                print(f"[bulk] batch {i // CHUNK + 1}/{(len(ids) + CHUNK - 1) // CHUNK} done", file=sys.stderr)
            print(f"[bulk] {success_total}/{len(ids)} messages updated in {time.time()-t0:.1f}s")
    elif action == "delete-permanent":
        if not force:
            sys.exit("delete-permanent requires --force (irrecoverable)")
        svc = _service(email)
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        success_total = 0
        with audit_path.open("a") as af:
            t0 = time.time()
            for i in range(0, len(ids), CHUNK):
                chunk = ids[i:i + CHUNK]
                attempt = 0
                while True:
                    try:
                        svc.users().messages().batchDelete(userId="me", body={"ids": chunk}).execute()
                        success_total += len(chunk)
                        af.write(json.dumps({"ts": time.time(), "action": action, "batch": i // CHUNK, "n": len(chunk), "ok": True}) + "\n")
                        break
                    except HttpError as e:
                        if e.resp.status in (429, 500, 503) and attempt < 4:
                            time.sleep(2 ** attempt)
                            attempt += 1
                            continue
                        af.write(json.dumps({"ts": time.time(), "action": action, "batch": i // CHUNK, "n": len(chunk), "ok": False, "error": str(e)}) + "\n")
                        break
                print(f"[bulk] batch {i // CHUNK + 1}/{(len(ids) + CHUNK - 1) // CHUNK} done", file=sys.stderr)
            print(f"[bulk] {success_total}/{len(ids)} messages permanently deleted in {time.time()-t0:.1f}s")
    elif action.startswith("add-label:") or action.startswith("remove-label:"):
        op, label_id = action.split(":", 1)
        delta = {"addLabelIds": [label_id], "removeLabelIds": []} if op == "add-label" else {"addLabelIds": [], "removeLabelIds": [label_id]}
        svc = _service(email)
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        success_total = 0
        with audit_path.open("a") as af:
            t0 = time.time()
            for i in range(0, len(ids), CHUNK):
                chunk = ids[i:i + CHUNK]
                body = {"ids": chunk, **delta}
                attempt = 0
                while True:
                    try:
                        svc.users().messages().batchModify(userId="me", body=body).execute()
                        success_total += len(chunk)
                        af.write(json.dumps({"ts": time.time(), "action": action, "batch": i // CHUNK, "n": len(chunk), "ok": True}) + "\n")
                        break
                    except HttpError as e:
                        if e.resp.status in (429, 500, 503) and attempt < 4:
                            time.sleep(2 ** attempt)
                            attempt += 1
                            continue
                        af.write(json.dumps({"ts": time.time(), "action": action, "batch": i // CHUNK, "n": len(chunk), "ok": False, "error": str(e)}) + "\n")
                        break
                print(f"[bulk] batch {i // CHUNK + 1}/{(len(ids) + CHUNK - 1) // CHUNK} done", file=sys.stderr)
            print(f"[bulk] {success_total}/{len(ids)} messages updated ({action}) in {time.time()-t0:.1f}s")
    else:
        sys.exit(f"unknown action: {action}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("-a", "--account", required=True)
    p.add_argument("--action", required=True, help="trash | archive | untrash | mark-read | mark-unread | delete-permanent | add-label:<id> | remove-label:<id>")
    p.add_argument("--input", required=True, help="JSONL or plain text file of message IDs")
    p.add_argument("--audit", default=None, help="audit log path (default: <input>.audit.jsonl)")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--force", action="store_true", help="required for delete-permanent")
    args = p.parse_args()
    in_path = Path(args.input)
    if not in_path.exists():
        sys.exit(f"input not found: {in_path}")
    ids = _read_ids(in_path)
    audit_path = Path(args.audit) if args.audit else in_path.with_suffix(in_path.suffix + ".audit.jsonl")
    run(args.account, args.action, ids, args.dry_run, audit_path, args.force)

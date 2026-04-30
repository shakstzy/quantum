#!/usr/bin/env python3
"""Run gmail-bulk inventory/bulk against synps using gog's stored refresh token.

Bridges gog's keychain -> gmail-bulk venv so we don't have to OAuth again.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

GOG_CRED_PATH = Path.home() / "Library/Application Support/gogcli/credentials.json"
SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]


def get_creds_from_gog(email: str) -> Credentials:
    blob = subprocess.run(
        ["security", "find-generic-password", "-s", "gogcli",
         "-a", f"token:default:{email}", "-w"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    refresh = json.loads(blob)["refresh_token"]
    cli = json.loads(GOG_CRED_PATH.read_text())
    info = {
        "refresh_token": refresh,
        "client_id": cli["client_id"],
        "client_secret": cli["client_secret"],
        "token_uri": "https://oauth2.googleapis.com/token",
        "scopes": SCOPES,
    }
    creds = Credentials.from_authorized_user_info(info, SCOPES)
    from google.auth.transport.requests import Request
    creds.refresh(Request())
    return creds


def inventory(email: str, query: str, out_path: Path):
    creds = get_creds_from_gog(email)
    svc = build("gmail", "v1", credentials=creds, cache_discovery=False)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    page = None
    with out_path.open("w") as f:
        while True:
            req = svc.users().messages().list(
                userId="me", q=query, maxResults=500, pageToken=page,
            ).execute()
            msgs = req.get("messages", [])
            for m in msgs:
                f.write(json.dumps({"id": m["id"], "threadId": m["threadId"]}) + "\n")
                n += 1
            page = req.get("nextPageToken")
            if not page:
                break
    print(f"inventory ok: {n} messages -> {out_path}")
    return n


def trash(email: str, in_path: Path, audit_path: Path):
    creds = get_creds_from_gog(email)
    svc = build("gmail", "v1", credentials=creds, cache_discovery=False)
    ids = [json.loads(line)["id"] for line in in_path.read_text().splitlines() if line.strip()]
    if not ids:
        print("no ids to trash")
        return 0
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    audited = 0
    with audit_path.open("w") as f:
        for i in range(0, len(ids), 1000):
            chunk = ids[i:i+1000]
            try:
                svc.users().messages().batchModify(
                    userId="me",
                    body={"ids": chunk, "addLabelIds": ["TRASH"], "removeLabelIds": ["INBOX"]},
                ).execute()
                for mid in chunk:
                    f.write(json.dumps({"id": mid, "result": "trashed"}) + "\n")
                audited += len(chunk)
                print(f"trashed batch {i//1000+1}: {len(chunk)} msgs (running total {audited}/{len(ids)})")
            except HttpError as e:
                for mid in chunk:
                    f.write(json.dumps({"id": mid, "result": f"err:{e.status_code}"}) + "\n")
                print(f"batch err {i//1000+1}: {e}")
            time.sleep(0.1)
    print(f"trash ok: {audited}/{len(ids)} -> {audit_path}")
    return audited


def headers(email: str, in_path: Path, out_path: Path, limit: int = 200):
    creds = get_creds_from_gog(email)
    svc = build("gmail", "v1", credentials=creds, cache_discovery=False)
    ids = [json.loads(line)["id"] for line in in_path.read_text().splitlines() if line.strip()][:limit]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out_path.open("w") as f:
        for mid in ids:
            try:
                msg = svc.users().messages().get(
                    userId="me", id=mid, format="metadata",
                    metadataHeaders=["From", "Subject", "List-Unsubscribe", "List-Unsubscribe-Post"],
                ).execute()
                hh = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
                f.write(json.dumps({
                    "id": mid,
                    "from": hh.get("From"),
                    "subject": hh.get("Subject"),
                    "list_unsub": hh.get("List-Unsubscribe"),
                    "list_unsub_post": hh.get("List-Unsubscribe-Post"),
                }) + "\n")
                n += 1
            except HttpError as e:
                f.write(json.dumps({"id": mid, "err": str(e)}) + "\n")
    print(f"headers ok: {n} -> {out_path}")
    return n


def top_senders(email: str, query: str, out_path: Path, sample: int = 1500):
    creds = get_creds_from_gog(email)
    svc = build("gmail", "v1", credentials=creds, cache_discovery=False)
    counts = {}
    page = None
    seen = 0
    while seen < sample:
        req = svc.users().messages().list(
            userId="me", q=query, maxResults=500, pageToken=page,
        ).execute()
        msgs = req.get("messages", [])
        for m in msgs:
            try:
                got = svc.users().messages().get(
                    userId="me", id=m["id"], format="metadata",
                    metadataHeaders=["From"],
                ).execute()
                hh = {h["name"]: h["value"] for h in got.get("payload", {}).get("headers", [])}
                frm = hh.get("From", "?")
                counts[frm] = counts.get(frm, 0) + 1
                seen += 1
                if seen >= sample:
                    break
            except HttpError:
                pass
        page = req.get("nextPageToken")
        if not page:
            break
    sorted_senders = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as f:
        for s, n in sorted_senders:
            f.write(f"{n}\t{s}\n")
    print(f"top senders ok: {len(sorted_senders)} unique, sample={seen} -> {out_path}")
    return len(sorted_senders)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    pi = sub.add_parser("inventory")
    pi.add_argument("-a", "--account", required=True)
    pi.add_argument("-q", "--query", required=True)
    pi.add_argument("-o", "--out", required=True)
    pt = sub.add_parser("trash")
    pt.add_argument("-a", "--account", required=True)
    pt.add_argument("-i", "--input", required=True)
    pt.add_argument("--audit", required=True)
    ph = sub.add_parser("headers")
    ph.add_argument("-a", "--account", required=True)
    ph.add_argument("-i", "--input", required=True)
    ph.add_argument("-o", "--out", required=True)
    ph.add_argument("--limit", type=int, default=200)
    ps = sub.add_parser("top-senders")
    ps.add_argument("-a", "--account", required=True)
    ps.add_argument("-q", "--query", required=True)
    ps.add_argument("-o", "--out", required=True)
    ps.add_argument("--sample", type=int, default=1500)
    args = p.parse_args()
    if args.cmd == "inventory":
        inventory(args.account, args.query, Path(args.out))
    elif args.cmd == "trash":
        trash(args.account, Path(args.input), Path(args.audit))
    elif args.cmd == "headers":
        headers(args.account, Path(args.input), Path(args.out), limit=args.limit)
    elif args.cmd == "top-senders":
        top_senders(args.account, args.query, Path(args.out), sample=args.sample)

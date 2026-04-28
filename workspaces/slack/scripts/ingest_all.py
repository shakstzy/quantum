#!/usr/bin/env python3
"""Incremental Slack ingest for one workspace (default: eclipse-labs).

- Lists conversations the user is a member of (public channels + DMs).
- For each conversation, fetches `conversations.history` from the last-seen ts forward.
- Appends messages to NDJSON sharded by message month: raw/slack/<workspace>/YYYY-MM.ndjson.
- Dedupes on (channel, ts) before append.
- Resumable: per-channel cursor map in raw/.ingest-log/slack-<workspace>.cursors.json.
- Token from macOS Keychain: service=quantum-slack account=<workspace>.

Scopes required (granted on eclipse-labs as of 2026-04):
- channels:read, channels:history (public channels)
- im:read, im:history (DMs)
Missing groups:read / mpim:read mean private channels and group DMs are NOT enumerated.
Add those scopes (see _core/skills/slack/references/scopes.md) to expand coverage.
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
import urllib.parse
import urllib.request
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parents[3]
RAW_BASE = ROOT / "raw" / "slack"
LOG = ROOT / "raw" / ".ingest-log"
API = "https://slack.com/api"
KEYCHAIN_SERVICE = "quantum-slack"

PACE_SEC = 1.2  # conversations.history is Tier 2 (~50/min); 1.2s pace stays comfortable
MAX_RETRIES = 6
PAGE_SIZE = 200


def get_token(workspace: str) -> str:
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", workspace, "-w"],
            check=True, capture_output=True, text=True,
        )
        return out.stdout.strip()
    except subprocess.CalledProcessError:
        sys.exit(
            f"No token in Keychain for service={KEYCHAIN_SERVICE} account={workspace}.\n"
            f"Store with:\n  security add-generic-password -s {KEYCHAIN_SERVICE} -a {workspace} -w \"xoxp-...\" -U"
        )


def slack(method: str, token: str, params: dict | None = None) -> dict:
    """POST to Slack API with form encoding. Retry on 429 / 5xx."""
    body = urllib.parse.urlencode(params or {}).encode("utf-8")
    delay = 1.0
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(
            f"{API}/{method}",
            data=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                retry = int(e.headers.get("retry-after", "5"))
                sys.stderr.write(f"[slack] 429 on {method}; sleeping {retry}s\n")
                time.sleep(retry)
                continue
            if e.code in (500, 502, 503, 504):
                sys.stderr.write(f"[slack] {e.code} on {method}; backoff {delay:.1f}s\n")
                time.sleep(delay)
                delay = min(delay * 2, 60.0)
                continue
            raise
        if not data.get("ok"):
            err = data.get("error", "unknown")
            if err in ("ratelimited", "rate_limited"):
                time.sleep(delay)
                delay = min(delay * 2, 60.0)
                continue
            raise RuntimeError(f"slack.{method} failed: {err}")
        return data
    raise RuntimeError(f"slack.{method} failed after {MAX_RETRIES} retries")


def list_conversations(token: str) -> list[dict]:
    """Enumerate every conversation the user is a member of (public + DM)."""
    out = []
    cursor = None
    while True:
        params = {
            "types": "public_channel,im",
            "exclude_archived": "true",
            "limit": "1000",
        }
        if cursor:
            params["cursor"] = cursor
        data = slack("conversations.list", token, params)
        out.extend(data.get("channels", []))
        cursor = data.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            break
        time.sleep(PACE_SEC)
    # only conversations the user is in (DMs are always "in"; channels need is_member)
    return [c for c in out if c.get("is_im") or c.get("is_member")]


def fetch_history(token: str, channel: str, oldest: str | None) -> list[dict]:
    """Cursor-paginate conversations.history from `oldest` (exclusive) forward."""
    msgs = []
    cursor = None
    while True:
        params: dict[str, str] = {"channel": channel, "limit": str(PAGE_SIZE)}
        if oldest:
            params["oldest"] = oldest
        if cursor:
            params["cursor"] = cursor
        data = slack("conversations.history", token, params)
        msgs.extend(data.get("messages", []))
        cursor = data.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            break
        time.sleep(PACE_SEC)
    return msgs


def shard_path(workspace: str, ts: str) -> pathlib.Path:
    """Shard NDJSON by message month (slack ts is unix seconds with fractional)."""
    month = dt.datetime.fromtimestamp(float(ts), tz=dt.timezone.utc).strftime("%Y-%m")
    return RAW_BASE / workspace / f"{month}.ndjson"


def existing_keys(path: pathlib.Path) -> set[tuple[str, str]]:
    """Read (channel, ts) pairs already in this shard."""
    if not path.exists():
        return set()
    keys: set[tuple[str, str]] = set()
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                keys.add((obj.get("channel"), obj.get("ts")))
            except json.JSONDecodeError:
                continue
    return keys


def normalize(m: dict, channel_id: str, channel_name: str | None) -> dict:
    """Strip to a stable, graph-friendly shape."""
    out = {
        "channel": channel_id,
        "channel_name": channel_name,
        "ts": m.get("ts"),
        "user": m.get("user") or m.get("bot_id") or m.get("username"),
        "text": m.get("text", ""),
    }
    if m.get("thread_ts") and m["thread_ts"] != m["ts"]:
        out["thread_ts"] = m["thread_ts"]
    if m.get("reply_count"):
        out["reply_count"] = m["reply_count"]
    if m.get("subtype"):
        out["subtype"] = m["subtype"]
    if m.get("files"):
        out["files"] = [
            {"id": f.get("id"), "name": f.get("name"), "mimetype": f.get("mimetype")}
            for f in m["files"]
        ]
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default=os.environ.get("SLACK_ACCOUNT", "eclipse-labs"))
    args = parser.parse_args()
    workspace = args.workspace

    LOG.mkdir(parents=True, exist_ok=True)
    (RAW_BASE / workspace).mkdir(parents=True, exist_ok=True)

    cursors_path = LOG / f"slack-{workspace}.cursors.json"
    errors_path = LOG / f"slack-{workspace}.errors.log"
    channels_path = LOG / f"slack-{workspace}.channels.json"

    cursors: dict[str, str] = {}
    if cursors_path.exists():
        try:
            cursors = json.loads(cursors_path.read_text())
        except json.JSONDecodeError:
            cursors = {}

    token = get_token(workspace)

    convos = list_conversations(token)
    sys.stderr.write(f"[slack] {workspace}: {len(convos)} conversations to scan\n")

    # cache channel metadata for graph context
    channels_path.write_text(json.dumps(
        [{"id": c["id"], "name": c.get("name"), "is_im": c.get("is_im", False), "user": c.get("user")} for c in convos],
        indent=2,
    ))

    total_new = 0
    for c in convos:
        cid = c["id"]
        cname = c.get("name") or (f"im-{c.get('user')}" if c.get("is_im") else cid)
        oldest = cursors.get(cid)
        try:
            msgs = fetch_history(token, cid, oldest)
        except Exception as e:
            with errors_path.open("a") as f:
                f.write(f"{dt.datetime.now().isoformat()} {cid} {cname}: {e}\n")
            sys.stderr.write(f"[slack] !! {cname}: {e}\n")
            continue
        if not msgs:
            time.sleep(PACE_SEC)
            continue

        # group new messages by shard, dedupe per shard
        by_shard: dict[pathlib.Path, list[dict]] = {}
        for m in msgs:
            if not m.get("ts"):
                continue
            by_shard.setdefault(shard_path(workspace, m["ts"]), []).append(m)

        new_in_chan = 0
        max_ts = oldest or "0"
        for shard, group in by_shard.items():
            shard.parent.mkdir(parents=True, exist_ok=True)
            seen = existing_keys(shard)
            with shard.open("a", encoding="utf-8") as f:
                for m in group:
                    key = (cid, m["ts"])
                    if key in seen:
                        continue
                    f.write(json.dumps(normalize(m, cid, cname), ensure_ascii=False) + "\n")
                    seen.add(key)
                    new_in_chan += 1
                    if m["ts"] > max_ts:
                        max_ts = m["ts"]

        if new_in_chan:
            cursors[cid] = max_ts
            total_new += new_in_chan
            sys.stderr.write(f"[slack]   {cname}: +{new_in_chan} (cursor -> {max_ts})\n")
        time.sleep(PACE_SEC)

    cursors_path.write_text(json.dumps(cursors, indent=2, sort_keys=True))
    sys.stderr.write(f"[slack] {workspace}: {total_new} new messages total\n")


if __name__ == "__main__":
    main()

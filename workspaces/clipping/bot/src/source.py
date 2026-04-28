"""Download a long-form source for an active campaign. Document rights status.

Usage:
    python bot/src/source.py <campaign-slug> <url> --rights authorized --evidence "campaign asset drive: <link>"
    python bot/src/source.py <campaign-slug> <url> --rights fair_use_review --evidence "creator pinned tweet: clips encouraged"
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import db
import transcribe

SRC_DIR = Path.home() / ".quantum" / "clipping" / "sources"
RIGHTS_VALUES = {"authorized", "campaign_allowed", "fair_use_review"}


def yt_extract_id(url: str) -> str:
    m = re.search(r"(?:v=|/shorts/|/embed/|youtu\.be/|/watch\?v=)([A-Za-z0-9_-]{8,})", url)
    if m:
        return m.group(1)
    proc = subprocess.run(["yt-dlp", "--get-id", url], capture_output=True, text=True, timeout=30)
    if proc.returncode == 0:
        return proc.stdout.strip()
    return hashlib.sha256(url.encode()).hexdigest()[:12]


def download(url: str, video_id: str) -> tuple[Path, dict]:
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    out_template = str(SRC_DIR / f"{video_id}.%(ext)s")
    cmd = ["yt-dlp", "-f", "bv*+ba/best[ext=mp4]/best", "--merge-output-format", "mp4",
           "--print-json", "--no-progress", "-o", out_template, url]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {proc.stderr.strip()}")
    info_line = proc.stdout.strip().splitlines()[-1]
    info = json.loads(info_line)
    file_path = SRC_DIR / f"{video_id}.mp4"
    if not file_path.exists():
        for ext in ("mkv", "webm", "mp4"):
            cand = SRC_DIR / f"{video_id}.{ext}"
            if cand.exists():
                file_path = cand
                break
    if not file_path.exists():
        raise RuntimeError(f"yt-dlp finished but file missing: {file_path}")
    return file_path, info


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("campaign_slug")
    p.add_argument("url")
    p.add_argument("--rights", required=True, choices=sorted(RIGHTS_VALUES))
    p.add_argument("--evidence", required=True, help="Why is this rights status valid (link / quote / rule citation)")
    args = p.parse_args(argv)

    with db.conn() as c:
        camp = c.execute("SELECT * FROM campaigns WHERE slug = ?", (args.campaign_slug,)).fetchone()
    if not camp:
        print(f"no campaign with slug={args.campaign_slug}", file=sys.stderr)
        return 2
    if camp["status"] != "active":
        print(f"campaign status={camp['status']}; only active campaigns can source", file=sys.stderr)
        return 2

    video_id = yt_extract_id(args.url)
    with db.conn() as c:
        existing = c.execute("SELECT * FROM sources WHERE source_video_id = ?", (video_id,)).fetchone()
    if existing:
        print(f"already sourced id={existing['id']} {existing['filepath']}", file=sys.stderr)
        return 0

    print(f"downloading {args.url} -> {video_id}", file=sys.stderr)
    file_path, info = download(args.url, video_id)
    a_hash = transcribe.audio_hash(str(file_path))

    sid = db.insert_source(
        source_video_id=video_id,
        url=args.url,
        title=info.get("title"),
        creator=info.get("uploader") or info.get("channel"),
        duration_s=info.get("duration"),
        audio_hash=a_hash,
        campaign_id=camp["id"],
        rights_status=args.rights,
        rights_evidence=args.evidence,
        downloaded_at="datetime('now')",  # placeholder; SQLite default would have been used if not provided
        filepath=str(file_path),
    )
    with db.conn() as c:
        c.execute("UPDATE sources SET downloaded_at = CURRENT_TIMESTAMP WHERE id = ?", (sid,))
    print(f"source id={sid} title={info.get('title')!r}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

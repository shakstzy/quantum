"""Publish approved candidates via _core/skills/zernio-post/. Default dry-run.

Usage:
    python bot/src/publish.py <candidate-id>           # dry-run
    LIVE=1 python bot/src/publish.py <candidate-id>    # actually post
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import db
from gate import gate

REPO_ROOT = Path(__file__).resolve().parents[2].parents[1]
ZERNIO = REPO_ROOT / "_core" / "skills" / "zernio-post" / "scripts" / "zernio.sh"
LOG_DIR = Path.home() / ".quantum" / "clipping" / "logs"


def make_caption(cand_row, account_row, campaign_row) -> str:
    hook = (cand_row["hook"] or "").strip()
    niche = (campaign_row["niche"] or "").lower().replace(" ", "")
    tag = f"#{niche}" if niche else ""
    base = f"{hook}\n\n#ad {tag}".strip()
    return base[:2200]


def emit_dry_run_preview(payload: dict) -> Path:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = LOG_DIR / f"publish-dryrun-{ts}.md"
    path.write_text("# dry-run publish\n\n```json\n" + json.dumps(payload, indent=2) + "\n```\n")
    return path


def write_raw_artifact(cand_row, account_row, campaign_row, post_url: str | None) -> Path:
    raw_dir = REPO_ROOT / "raw" / "clipping"
    raw_dir.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    slug_src = (cand_row["hook"] or f"clip-{cand_row['id']}").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug_src).strip("-")[:60] or f"clip-{cand_row['id']}"
    path = raw_dir / f"{today}-{slug}.md"
    fm = {
        "candidate_id": cand_row["id"],
        "campaign_slug": campaign_row["slug"],
        "source_id": cand_row["source_id"],
        "account_alias": account_row["alias"],
        "platform": account_row["platform"],
        "post_url": post_url or "",
        "posted_at": today,
        "links": [campaign_row["slug"]],
    }
    body = (
        "---\n" + json.dumps(fm, indent=2) + "\n---\n\n"
        f"# {cand_row['hook'] or 'untitled clip'}\n\n"
        f"Campaign: [[{campaign_row['slug']}]]\n"
        f"Source row: {cand_row['source_id']}\n"
        f"Hook: {cand_row['hook'] or '(none)'}\n"
        f"Excerpt:\n\n> {(cand_row['transcript_excerpt'] or '')[:500]}\n"
    )
    path.write_text(body)
    return path


def publish_candidate(candidate_id: int) -> int:
    cand = db.get_candidate(candidate_id)
    if not cand:
        print(f"no candidate id={candidate_id}", file=sys.stderr)
        return 2
    if cand["status"] != "qa_approved":
        print(f"candidate status={cand['status']}; not qa_approved", file=sys.stderr)
        return 2

    camp = db.get_campaign(cand["campaign_id"])
    accounts = db.list_active_accounts(niche=camp["niche"])
    if not accounts:
        print(f"no active accounts for niche={camp['niche']!r}; aborting", file=sys.stderr)
        return 2

    with db.conn() as c:
        render = c.execute(
            "SELECT * FROM renders WHERE candidate_id = ? ORDER BY id DESC LIMIT 1",
            (candidate_id,),
        ).fetchone()
    if not render:
        print("no render for candidate; run compose first", file=sys.stderr)
        return 2

    live = os.environ.get("LIVE") == "1"
    posted_any = False
    for acct in accounts:
        caption = make_caption(cand, acct, camp)
        gres = gate(candidate_id, acct["id"], caption=caption)
        if not gres.passed:
            print(f"gate FAILED for account={acct['alias']}: {gres.failed}", file=sys.stderr)
            continue

        attempt_id = db.insert_publish_attempt(
            candidate_id=candidate_id,
            render_id=render["id"],
            account_id=acct["id"],
            status="dry_run" if not live else "queued",
            caption=caption,
            hashtags="",
        )

        payload = {
            "attempt_id": attempt_id,
            "alias": acct["alias"],
            "platform": acct["platform"],
            "filepath": render["filepath"],
            "caption": caption,
            "live": live,
        }

        if not live:
            preview_path = emit_dry_run_preview(payload)
            print(f"dry-run wrote {preview_path}")
            posted_any = True
            continue

        if "ZERNIO_NO_CONFIRM" not in os.environ:
            print("LIVE=1 set. zernio-post requires `PUBLISH` confirmation in caller env.", file=sys.stderr)

        cmd = ["bash", str(ZERNIO), "post", render["filepath"]]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            with db.conn() as c:
                c.execute("UPDATE publish_attempts SET status = 'failed', failure_reason = ? WHERE id = ?",
                          (proc.stderr[-500:], attempt_id))
            print(f"FAILED account={acct['alias']}: {proc.stderr[-200:]}", file=sys.stderr)
            continue

        try:
            resp = json.loads(proc.stdout)
            post_id = resp.get("_id") or resp.get("id")
            url = resp.get("platform_url") or resp.get("url")
        except Exception:
            post_id, url = None, None

        with db.conn() as c:
            c.execute(
                "UPDATE publish_attempts SET status = 'posted', zernio_post_id = ?, platform_url = ?, "
                "posted_at = CURRENT_TIMESTAMP WHERE id = ?",
                (post_id, url, attempt_id),
            )
        write_raw_artifact(cand, acct, camp, url)
        posted_any = True
        print(f"posted account={acct['alias']} url={url}")

    if posted_any:
        db.update_candidate_status(candidate_id, "published")
    return 0 if posted_any else 1


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("candidate_id", type=int)
    args = p.parse_args(argv)
    return publish_candidate(args.candidate_id)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

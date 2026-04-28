"""Reconcile views to payouts. Update north-star metric.

Usage:
    python bot/src/track.py refresh         # poll metrics for all posted attempts
    python bot/src/track.py northstar       # compute and append daily north-star
    python bot/src/track.py kill-list       # surface dead campaigns
    python bot/src/track.py ingest-payouts  # import ~/.quantum/clipping/inbox/payouts/*.json
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import db

REPO_ROOT = Path(__file__).resolve().parents[2].parents[1]
ZERNIO = REPO_ROOT / "_core" / "skills" / "zernio-post" / "scripts" / "zernio.sh"
LOG_DIR = Path.home() / ".quantum" / "clipping" / "logs"
INBOX = Path.home() / ".quantum" / "clipping" / "inbox" / "payouts"


def refresh_metrics() -> int:
    if not os.environ.get("ZERNIO_API_KEY"):
        print("ZERNIO_API_KEY not set; cannot refresh metrics", file=sys.stderr)
        return 2
    with db.conn() as c:
        rows = c.execute(
            """SELECT id, zernio_post_id FROM publish_attempts
               WHERE status = 'posted' AND zernio_post_id IS NOT NULL
               AND created_at >= datetime('now','-30 days')"""
        ).fetchall()
    refreshed = 0
    for r in rows:
        proc = subprocess.run(["bash", str(ZERNIO), "status", r["zernio_post_id"]],
                              capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            continue
        try:
            data = json.loads(proc.stdout)
            views = data.get("views") or data.get("metrics", {}).get("views")
            likes = data.get("likes") or data.get("metrics", {}).get("likes")
            comments = data.get("comments") or data.get("metrics", {}).get("comments")
            shares = data.get("shares") or data.get("metrics", {}).get("shares")
        except Exception:
            continue
        with db.conn() as c:
            c.execute("INSERT INTO metrics_snapshots(publish_attempt_id, views, likes, comments, shares) "
                      "VALUES (?,?,?,?,?)",
                      (r["id"], views, likes, comments, shares))
        refreshed += 1
    print(f"refreshed metrics for {refreshed} attempts", file=sys.stderr)
    return 0


def compute_north_star() -> dict:
    with db.conn() as c:
        approved = c.execute(
            "SELECT count(DISTINCT candidate_id) AS n FROM qa_reviews WHERE decision='approve'"
        ).fetchone()["n"]
        attempts = c.execute(
            """SELECT count(DISTINCT pa.candidate_id) AS n
               FROM publish_attempts pa
               JOIN qa_reviews qa ON qa.candidate_id = pa.candidate_id
               WHERE qa.decision='approve' AND pa.status IN ('posted','dry_run')"""
        ).fetchone()["n"]
        total_views = c.execute(
            """SELECT COALESCE(SUM(views), 0) AS v FROM (
                 SELECT publish_attempt_id, MAX(views) AS views
                 FROM metrics_snapshots GROUP BY publish_attempt_id
               )"""
        ).fetchone()["v"]
        paid = c.execute("SELECT COALESCE(SUM(paid_usd),0) AS p FROM payout_claims WHERE status='paid'").fetchone()["p"]
    metric = {
        "date": datetime.utcnow().date().isoformat(),
        "approved_publishes": attempts,
        "total_qa_approved_candidates": approved,
        "total_views": total_views,
        "total_paid_usd": paid,
        "paid_views_per_approved_publish": (total_views / attempts) if attempts else 0,
    }
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with (LOG_DIR / "north-star.ndjson").open("a") as f:
        f.write(json.dumps(metric) + "\n")
    return metric


def kill_list() -> list[dict]:
    with db.conn() as c:
        rows = c.execute(
            """SELECT campaigns.id, campaigns.slug,
                      count(DISTINCT pa.id) AS posted_count,
                      COALESCE(SUM(latest.views), 0) AS total_views
               FROM campaigns
               LEFT JOIN publish_attempts pa ON pa.candidate_id IN (
                   SELECT id FROM clip_candidates WHERE campaign_id = campaigns.id
               ) AND pa.status = 'posted'
               LEFT JOIN (
                   SELECT publish_attempt_id, MAX(views) AS views
                   FROM metrics_snapshots GROUP BY publish_attempt_id
               ) latest ON latest.publish_attempt_id = pa.id
               WHERE campaigns.status = 'active'
               GROUP BY campaigns.id"""
        ).fetchall()
    candidates_for_kill = []
    for r in rows:
        if r["posted_count"] >= 10 and (r["total_views"] / max(r["posted_count"], 1)) < 1000:
            candidates_for_kill.append(dict(r))
    return candidates_for_kill


def ingest_payouts() -> int:
    INBOX.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in INBOX.glob("*.json"):
        data = json.loads(f.read_text())
        slug = data.get("campaign_slug") or f.stem
        with db.conn() as c:
            camp = c.execute("SELECT id FROM campaigns WHERE slug = ?", (slug,)).fetchone()
            if not camp:
                continue
            for entry in data.get("entries", []):
                attempt_url = entry.get("platform_url")
                paid = entry.get("paid_usd") or 0
                if not attempt_url:
                    continue
                row = c.execute("SELECT id FROM publish_attempts WHERE platform_url = ?",
                                (attempt_url,)).fetchone()
                if not row:
                    continue
                c.execute(
                    """INSERT INTO payout_claims(campaign_id, publish_attempt_id, paid_usd, status, paid_at)
                       VALUES (?, ?, ?, 'paid', CURRENT_TIMESTAMP)""",
                    (camp["id"], row["id"], paid),
                )
                n += 1
    return n


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["refresh", "northstar", "kill-list", "ingest-payouts"])
    args = p.parse_args(argv)
    if args.cmd == "refresh":
        return refresh_metrics()
    if args.cmd == "northstar":
        m = compute_north_star()
        print(json.dumps(m, indent=2))
        return 0
    if args.cmd == "kill-list":
        rows = kill_list()
        print(json.dumps(rows, indent=2))
        return 0
    if args.cmd == "ingest-payouts":
        n = ingest_payouts()
        print(f"ingested {n} payout entries", file=sys.stderr)
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""SQLite control plane for the clipping workspace.

The DB is the source of truth. Filesystem is artifact storage.

Usage:
    python bot/src/db.py init                  # apply shared/schema.sql
    python bot/src/db.py status                # quick counts
    python bot/src/db.py override <cand-id> "<reason>"
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path

WS_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = WS_ROOT.parents[1]
SCHEMA = WS_ROOT / "shared" / "schema.sql"

STATE_DIR = Path.home() / ".quantum" / "clipping"
DB_PATH = STATE_DIR / "clipping.db"


def ensure_state_dirs() -> None:
    for sub in ("transcripts", "sources", "candidates", "approved", "logs", "inbox/payouts"):
        (STATE_DIR / sub).mkdir(parents=True, exist_ok=True)


@contextmanager
def conn():
    ensure_state_dirs()
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init() -> None:
    ensure_state_dirs()
    sql = SCHEMA.read_text()
    with conn() as c:
        c.executescript(sql)
    print(f"initialized {DB_PATH}", file=sys.stderr)


def status() -> dict:
    with conn() as c:
        out = {}
        for tbl in ("campaigns", "sources", "transcripts", "clip_candidates",
                    "renders", "qa_reviews", "accounts", "publish_attempts",
                    "metrics_snapshots", "payout_claims"):
            row = c.execute(f"SELECT count(*) AS n FROM {tbl}").fetchone()
            out[tbl] = row["n"]
        out["candidates_by_status"] = {
            r["status"]: r["n"] for r in c.execute(
                "SELECT status, count(*) AS n FROM clip_candidates GROUP BY status"
            ).fetchall()
        }
        out["campaigns_by_status"] = {
            r["status"]: r["n"] for r in c.execute(
                "SELECT status, count(*) AS n FROM campaigns GROUP BY status"
            ).fetchall()
        }
    return out


def get_campaign(campaign_id: int) -> sqlite3.Row | None:
    with conn() as c:
        return c.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()


def get_source(source_id: int) -> sqlite3.Row | None:
    with conn() as c:
        return c.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()


def get_candidate(candidate_id: int) -> sqlite3.Row | None:
    with conn() as c:
        return c.execute("SELECT * FROM clip_candidates WHERE id = ?", (candidate_id,)).fetchone()


def upsert_campaign(slug: str, **fields) -> int:
    with conn() as c:
        existing = c.execute("SELECT id FROM campaigns WHERE slug = ?", (slug,)).fetchone()
        if existing:
            sets = ", ".join(f"{k} = ?" for k in fields)
            c.execute(f"UPDATE campaigns SET {sets} WHERE id = ?", (*fields.values(), existing["id"]))
            return existing["id"]
        cols = ["slug", *fields.keys()]
        placeholders = ", ".join("?" * len(cols))
        cur = c.execute(
            f"INSERT INTO campaigns ({', '.join(cols)}) VALUES ({placeholders})",
            (slug, *fields.values()),
        )
        return cur.lastrowid


def insert_source(**fields) -> int:
    cols = ", ".join(fields.keys())
    placeholders = ", ".join("?" * len(fields))
    with conn() as c:
        cur = c.execute(f"INSERT INTO sources ({cols}) VALUES ({placeholders})", tuple(fields.values()))
        return cur.lastrowid


def find_transcript(source_id: int, model_version: str) -> sqlite3.Row | None:
    with conn() as c:
        return c.execute(
            "SELECT * FROM transcripts WHERE source_id = ? AND model_version = ?",
            (source_id, model_version),
        ).fetchone()


def insert_transcript(**fields) -> int:
    cols = ", ".join(fields.keys())
    placeholders = ", ".join("?" * len(fields))
    with conn() as c:
        cur = c.execute(f"INSERT INTO transcripts ({cols}) VALUES ({placeholders})", tuple(fields.values()))
        return cur.lastrowid


def insert_candidate(**fields) -> int:
    cols = ", ".join(fields.keys())
    placeholders = ", ".join("?" * len(fields))
    with conn() as c:
        cur = c.execute(f"INSERT INTO clip_candidates ({cols}) VALUES ({placeholders})", tuple(fields.values()))
        return cur.lastrowid


def update_candidate_status(candidate_id: int, status: str) -> None:
    with conn() as c:
        c.execute("UPDATE clip_candidates SET status = ? WHERE id = ?", (status, candidate_id))


def find_duplicate_candidates(ngram_hash: str | None, perceptual_hash: str | None,
                              days: int = 30, phash_bit_threshold: int = 24) -> list[sqlite3.Row]:
    """Return candidates with same ngram_hash, OR with pHash within `phash_bit_threshold`
    bit-Hamming distance, in the last N days. With imagehash.phash(hash_size=16) the
    output is 256 bits; 24 bits is a fairly tight near-duplicate window."""
    if not ngram_hash and not perceptual_hash:
        return []
    with conn() as c:
        rows = c.execute(
            f"""
            SELECT * FROM clip_candidates
            WHERE created_at >= datetime('now', '-{days} days')
              AND (ngram_hash = ? OR perceptual_hash IS NOT NULL)
            """,
            (ngram_hash,),
        ).fetchall()
    out = []
    for r in rows:
        if r["ngram_hash"] == ngram_hash and ngram_hash:
            out.append(r)
            continue
        if perceptual_hash and r["perceptual_hash"]:
            if _hamming(perceptual_hash, r["perceptual_hash"]) <= phash_bit_threshold:
                out.append(r)
    return out


def _hamming(a: str, b: str) -> int:
    """True bit-Hamming distance for hex-encoded perceptual hashes."""
    if len(a) != len(b) or not a:
        return 10**6
    try:
        return (int(a, 16) ^ int(b, 16)).bit_count()
    except ValueError:
        return 10**6


def insert_render(**fields) -> int:
    cols = ", ".join(fields.keys())
    placeholders = ", ".join("?" * len(fields))
    with conn() as c:
        cur = c.execute(f"INSERT INTO renders ({cols}) VALUES ({placeholders})", tuple(fields.values()))
        return cur.lastrowid


def insert_qa(**fields) -> int:
    cols = ", ".join(fields.keys())
    placeholders = ", ".join("?" * len(fields))
    with conn() as c:
        cur = c.execute(f"INSERT INTO qa_reviews ({cols}) VALUES ({placeholders})", tuple(fields.values()))
        return cur.lastrowid


def create_publish_attempt_after_gate(*, candidate_id: int, account_id: int, render_id: int,
                                      caption: str, gate_passed: bool, failed_checks: list[str],
                                      full_checks_json: str, status: str = "queued") -> tuple[int, int]:
    """Atomic: write the gate_decision row, then (if passed) the publish_attempt row referencing it.

    Returns (gate_decision_id, publish_attempt_id_or_None).

    This is the ONLY public path that creates publish_attempts. There is no public
    insert_publish_attempt() because the schema (publish_attempts.gate_decision_id NOT NULL)
    enforces that every attempt is bound to a recorded gate run.
    """
    with conn() as c:
        c.execute("BEGIN IMMEDIATE")
        cur = c.execute(
            """INSERT INTO gate_decisions(candidate_id, account_id, passed, failed_checks,
                                          full_checks_json, caption)
               VALUES (?,?,?,?,?,?)""",
            (candidate_id, account_id, int(gate_passed),
             json.dumps(failed_checks), full_checks_json, caption),
        )
        gate_id = cur.lastrowid
        attempt_id = None
        if gate_passed:
            cur = c.execute(
                """INSERT INTO publish_attempts(candidate_id, render_id, account_id,
                                                gate_decision_id, status, caption)
                   VALUES (?,?,?,?,?,?)""",
                (candidate_id, render_id, account_id, gate_id, status, caption),
            )
            attempt_id = cur.lastrowid
        return gate_id, attempt_id


def update_publish_attempt(attempt_id: int, **fields) -> None:
    sets = ", ".join(f"{k} = ?" for k in fields)
    with conn() as c:
        c.execute(f"UPDATE publish_attempts SET {sets} WHERE id = ?", (*fields.values(), attempt_id))


def list_active_accounts(niche: str | None = None) -> list[sqlite3.Row]:
    with conn() as c:
        if niche:
            return c.execute(
                "SELECT * FROM accounts WHERE status = 'active' AND niche = ?", (niche,)
            ).fetchall()
        return c.execute("SELECT * FROM accounts WHERE status = 'active'").fetchall()


def override_candidate(candidate_id: int, reason: str) -> None:
    insert_qa(
        candidate_id=candidate_id,
        reviewer="manual_override",
        decision="approve",
        reasons=f"MANUAL_OVERRIDE: {reason}",
        rights_check=1, disclosure_check=1, originality_check=1,
        duplicate_check=1, account_fit_check=1, campaign_fit_check=1,
        platform_risk_score=0,
    )
    update_candidate_status(candidate_id, "qa_approved")


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd = argv[0]
    if cmd == "init":
        init()
        return 0
    if cmd == "status":
        print(json.dumps(status(), indent=2, default=str))
        return 0
    if cmd == "override":
        if len(argv) < 3:
            print("usage: db.py override <candidate-id> \"<reason>\"", file=sys.stderr)
            return 2
        override_candidate(int(argv[1]), argv[2])
        print(f"overrode candidate {argv[1]}")
        return 0
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

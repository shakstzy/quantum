"""Pre-publish gate. Per Adv Review v2: this IS the system.

Every candidate-to-account combo must pass every check before publish.
No bypass except explicit `db.py override`.

Usage:
    python bot/src/gate.py <candidate-id> <account-id> [--apply]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

import db
from lib.banned import is_banned

_URL_RE = re.compile(r"https?://\S+", re.I)
_DISCLOSURE_TOKENS = re.compile(
    r"(?<![A-Za-z0-9])"
    r"(#ad|#paidpartnership|#sponsored|paid partnership|paid promotion|sponsored by|advertisement|\bad:)"
    r"(?![A-Za-z0-9-])",
    re.I,
)


def _has_disclosure(caption: str | None) -> bool:
    """Strip URLs first so #ad-fragment URLs do not satisfy the check.
    Then require a standalone disclosure token, not a substring."""
    if not caption:
        return False
    stripped = _URL_RE.sub(" ", caption)
    return bool(_DISCLOSURE_TOKENS.search(stripped))


@dataclass
class Check:
    name: str
    passed: bool
    detail: str = ""


@dataclass
class GateResult:
    passed: bool
    failed: list[str]
    checks: list[Check]


def _campaign_verified(campaign_row) -> Check:
    if not campaign_row:
        return Check("campaign_verified", False, "no campaign")
    ok = campaign_row["status"] == "active" and campaign_row["verified_at"] is not None
    return Check("campaign_verified", ok, f"status={campaign_row['status']} verified_at={campaign_row['verified_at']}")


def _rights_check(source_row) -> Check:
    rs = source_row["rights_status"] if source_row else None
    ok = rs in ("authorized", "campaign_allowed", "fair_use_review")
    return Check("rights_check", ok, f"rights_status={rs}")


def _duplicate_check(cand) -> Check:
    score = cand["duplicate_score"] if cand["duplicate_score"] is not None else 1.0
    # Hard zero. Any duplicate is a fail. Per Codex code review #5.
    return Check("duplicate_check", score == 0.0, f"score={score:.2f}")


def _account_cadence(account_row) -> Check:
    if not account_row:
        return Check("account_cadence", False, "no account")
    with db.conn() as c:
        day = c.execute(
            """SELECT count(*) AS n FROM publish_attempts
               WHERE account_id = ? AND status IN ('posted','queued')
               AND created_at >= datetime('now','-1 day')""",
            (account_row["id"],),
        ).fetchone()["n"]
        hour = c.execute(
            """SELECT count(*) AS n FROM publish_attempts
               WHERE account_id = ? AND status IN ('posted','queued')
               AND created_at >= datetime('now','-1 hour')""",
            (account_row["id"],),
        ).fetchone()["n"]
    daily_ok = day < account_row["daily_post_cap"]
    hourly_ok = hour < account_row["hourly_post_cap"]
    return Check("account_cadence", daily_ok and hourly_ok,
                 f"day={day}/{account_row['daily_post_cap']} hour={hour}/{account_row['hourly_post_cap']}")


def _account_niche_fit(campaign_row, account_row) -> Check:
    if not campaign_row or not account_row:
        return Check("account_niche_fit", False, "missing rows")
    cn = (campaign_row["niche"] or "").strip().lower()
    an = (account_row["niche"] or "").strip().lower()
    return Check("account_niche_fit", cn == an, f"campaign={cn!r} account={an!r}")


def _originality_check(cand) -> Check:
    has_hook = bool((cand["hook"] or "").strip())
    has_excerpt = bool((cand["transcript_excerpt"] or "").strip())
    ok = has_hook and has_excerpt
    return Check("originality_check", ok, f"hook={has_hook} captions={has_excerpt}")


def _disclosure_check(campaign_row, caption: str | None) -> Check:
    if not campaign_row:
        return Check("disclosure_resolved", True, "no campaign; not paid")
    has_tag = _has_disclosure(caption)
    return Check("disclosure_resolved", has_tag, f"caption_has_disclosure={has_tag}")


def _qa_status(candidate_id: int) -> Check:
    with db.conn() as c:
        row = c.execute(
            "SELECT decision FROM qa_reviews WHERE candidate_id = ? ORDER BY id DESC LIMIT 1",
            (candidate_id,),
        ).fetchone()
    if not row:
        return Check("qa_status", False, "no qa review")
    return Check("qa_status", row["decision"] == "approve", f"decision={row['decision']}")


def _platform_risk(cand, source_row, account_row) -> Check:
    score = 0
    plat = (account_row["platform"] if account_row else "") or ""
    rs = source_row["rights_status"] if source_row else ""
    if rs == "fair_use_review":
        score += 30
    if plat == "youtube":
        if rs in ("fair_use_review", "campaign_allowed"):
            score += 10
        dur = (cand["end_s"] or 0) - (cand["start_s"] or 0)
        if dur > 60:
            score += 30
    if account_row and account_row["status"] == "warmup":
        score += 20
    text = (cand["transcript_excerpt"] or "") + " " + (cand["hook"] or "")
    banned, _ = is_banned(text)
    if banned:
        score += 50
    return Check("platform_risk_score", score < 30, f"score={score} platform={plat}")


def _banned_clean(cand, caption: str | None) -> Check:
    text = (cand["transcript_excerpt"] or "") + " " + (cand["hook"] or "") + " " + (caption or "")
    banned, hits = is_banned(text)
    return Check("banned_niche_clean", not banned, f"hits={hits}")


def gate(candidate_id: int, account_id: int, caption: str | None = None) -> GateResult:
    cand = db.get_candidate(candidate_id)
    if not cand:
        return GateResult(False, ["no_candidate"], [Check("no_candidate", False)])
    src = db.get_source(cand["source_id"])
    camp = db.get_campaign(cand["campaign_id"])
    with db.conn() as c:
        acct = c.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()

    checks = [
        _campaign_verified(camp),
        _rights_check(src),
        _duplicate_check(cand),
        _account_cadence(acct),
        _account_niche_fit(camp, acct),
        _originality_check(cand),
        _disclosure_check(camp, caption),
        _qa_status(candidate_id),
        _platform_risk(cand, src, acct),
        _banned_clean(cand, caption),
    ]
    failed = [c.name for c in checks if not c.passed]
    return GateResult(passed=(len(failed) == 0), failed=failed, checks=checks)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("candidate_id", type=int)
    p.add_argument("account_id", type=int)
    p.add_argument("--caption", default=None)
    p.add_argument("--apply", action="store_true",
                   help="Insert qa_reviews row + advance candidate status based on result")
    args = p.parse_args(argv)
    res = gate(args.candidate_id, args.account_id, caption=args.caption)
    out = {"passed": res.passed, "failed": res.failed,
           "checks": [asdict(c) for c in res.checks]}
    print(json.dumps(out, indent=2))
    if args.apply:
        check_map = {c.name: int(c.passed) for c in res.checks}
        db.insert_qa(
            candidate_id=args.candidate_id,
            reviewer="gate.py",
            decision="approve" if res.passed else "reject",
            reasons=json.dumps({"failed": res.failed}),
            rights_check=check_map.get("rights_check"),
            disclosure_check=check_map.get("disclosure_resolved"),
            originality_check=check_map.get("originality_check"),
            duplicate_check=check_map.get("duplicate_check"),
            account_fit_check=check_map.get("account_niche_fit"),
            campaign_fit_check=check_map.get("campaign_verified"),
            platform_risk_score=0 if res.passed else 50,
        )
        db.update_candidate_status(args.candidate_id, "qa_approved" if res.passed else "qa_rejected")
    return 0 if res.passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

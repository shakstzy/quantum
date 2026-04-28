"""Discover and verify clipper-bounty campaigns.

For v1: takes a path to a markdown file (manual paste from a Whop/Vyro/Discord page),
runs LLM extraction, scores via scam-checklist heuristics, persists to DB.

Auto-scrape via firecrawl is wired but only fires when FIRECRAWL_API_KEY is set
and explicit URLs are passed via --url.

Usage:
    python bot/src/discover.py --file ~/inbox/whop-page-paste.md --source whop
    python bot/src/discover.py --url https://whop.com/.../  --source whop
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import db
from lib.claude import claude_json, load_prompt
from lib.banned import is_banned

SCAM_RATE_CAP = 10.0


def _firecrawl(url: str) -> str:
    """Call _core/skills/firecrawl/ to extract clean markdown. Requires FIRECRAWL_API_KEY."""
    key = os.environ.get("FIRECRAWL_API_KEY")
    if not key:
        raise SystemExit("FIRECRAWL_API_KEY not set; pass --file instead")
    body = json.dumps({"url": url, "formats": ["markdown"]})
    proc = subprocess.run(
        ["curl", "-sS", "-X", "POST", "https://api.firecrawl.dev/v1/scrape",
         "-H", f"Authorization: Bearer {key}",
         "-H", "Content-Type: application/json",
         "-d", body],
        capture_output=True, text=True, timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"firecrawl failed: {proc.stderr}")
    data = json.loads(proc.stdout)
    return data.get("data", {}).get("markdown", "")


def score_scam(extracted: dict, raw_text: str) -> tuple[int, list[str]]:
    """Return (scam_score 0-100, signals_hit)."""
    score = 50
    signals: list[str] = []
    rate = extracted.get("rate_per_1k_usd")
    paid_out = extracted.get("total_paid_out_usd") or 0
    rules = extracted.get("rules", "")
    rules_text = (rules + " " + raw_text).lower()

    if 0.30 <= (rate or 0) <= 8.0:
        score -= 10; signals.append("plausible_cpm")
    if paid_out and paid_out > 1000:
        score -= 10; signals.append("paid_out_over_1k")
    if "content rewards" in rules_text or "/content-rewards/" in raw_text:
        score -= 10; signals.append("uses_official_content_rewards")
    if "disclosure" in rules_text or "min" in rules_text and "view" in rules_text:
        score -= 10; signals.append("clear_policy_text")

    if rate and rate > SCAM_RATE_CAP:
        score += 30; signals.append("impossible_cpm")
    if re.search(r"buy|wallet|connect|verification fee|course|membership", rules_text):
        score += 20; signals.append("requires_payment_or_wallet")
    if re.search(r"referral|downline|recruit|MLM", rules_text):
        score += 20; signals.append("affiliate_recruitment")
    if re.search(r"DM for payout|telegram|whatsapp|private channel", rules_text):
        score += 20; signals.append("offplatform_payout")
    if re.search(r"share TikTok login|provide cookies|proxy setup", rules_text):
        score += 30; signals.append("asks_for_credentials")
    banned, cats = is_banned(rules_text)
    if banned:
        score += 30; signals.append(f"banned_niche:{','.join(cats)}")
    return max(0, min(100, score)), signals


def slugify(payer: str, niche: str, source: str) -> str:
    parts = [re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-") for s in (payer, niche, source)]
    return "-".join(p for p in parts if p) or "unnamed"


def discover(text: str, source: str, url: str | None = None) -> int | None:
    prompt = load_prompt("extract-campaign").replace("__INPUT__", text[:30000])
    extracted = claude_json(prompt)
    if not isinstance(extracted, dict):
        print("extractor returned non-dict; skipping", file=sys.stderr)
        return None

    rate = extracted.get("rate_per_1k_usd")
    if rate is not None and rate > SCAM_RATE_CAP:
        print(f"auto-reject: rate ${rate}/1K exceeds cap ${SCAM_RATE_CAP}", file=sys.stderr)
        return None

    score, signals = score_scam(extracted, text)
    slug = slugify(extracted.get("payer", "unknown"), extracted.get("niche", "unknown"), source)

    cid = db.upsert_campaign(
        slug=slug,
        source=source,
        url=url or extracted.get("url"),
        payer=extracted.get("payer"),
        niche=extracted.get("niche"),
        rate_per_1k_usd=rate,
        min_views=extracted.get("min_views"),
        max_payout_usd=extracted.get("max_payout_usd"),
        total_paid_out_usd=extracted.get("total_paid_out_usd"),
        scam_score=score,
        scam_signals=json.dumps(signals),
        status="dead" if score > 70 else "pending",
        rules_json=json.dumps(extracted.get("rules", {})),
        notes=extracted.get("notes", ""),
    )
    print(f"campaign id={cid} slug={slug} scam_score={score} signals={signals}", file=sys.stderr)
    return cid


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--file", help="Local markdown file with the campaign listing")
    p.add_argument("--url", help="URL to scrape via firecrawl")
    p.add_argument("--source", required=True, choices=["whop", "vyro", "discord", "direct", "skool", "other"])
    args = p.parse_args(argv)
    if not args.file and not args.url:
        print("must provide --file or --url", file=sys.stderr)
        return 2
    text = Path(args.file).read_text() if args.file else _firecrawl(args.url)
    discover(text, args.source, url=args.url)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""End-to-end clip stage: transcribe -> rank -> filter -> cut -> fingerprint -> persist.

Combines transcribe.py + rank.py + cut.py + fingerprint.py into one orchestrated run.

Usage:
    python bot/src/clip.py <source-id> [--top 5]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cut
import db
import fingerprint
import rank
import transcribe
from lib.banned import is_banned


def words_in_window(transcript_segments: list[dict], start_s: float, end_s: float) -> list[dict]:
    out = []
    for seg in transcript_segments:
        for w in seg.get("words", []):
            ws, we = w.get("start"), w.get("end")
            if ws is None or we is None:
                continue
            if we <= start_s or ws >= end_s:
                continue
            out.append({"word": w["word"], "start": ws - start_s, "end": we - start_s})
    return out


def excerpt_text(transcript_segments: list[dict], start_s: float, end_s: float) -> str:
    parts = []
    for seg in transcript_segments:
        if seg["end"] <= start_s or seg["start"] >= end_s:
            continue
        parts.append(seg.get("text", ""))
    return " ".join(parts).strip()


def run(source_id: int, top: int = 5, model: str = "sonnet") -> int:
    src = db.get_source(source_id)
    if not src:
        print(f"no source id={source_id}", file=sys.stderr)
        return 2
    if not src["campaign_id"]:
        print(f"source {source_id} has no campaign", file=sys.stderr)
        return 2

    print(f"transcribing source id={source_id} ({src['title']!r})...", file=sys.stderr)
    tx = transcribe.transcribe(source_id)
    segments = tx["segments"]

    print("ranking moments...", file=sys.stderr)
    raw_cands = rank.rank_source(source_id, top=top, model=model)

    persisted = 0
    for c in raw_cands:
        text = excerpt_text(segments, c["start_s"], c["end_s"])
        banned, cats = is_banned(text + " " + (c.get("hook", "") or ""))
        if banned:
            print(f"  drop banned [{','.join(cats)}]: {c.get('hook')!r}", file=sys.stderr)
            continue

        s, e = cut.refine(source_id, c["start_s"], c["end_s"])
        text = excerpt_text(segments, s, e)
        n_hash, p_hash, dup_score = fingerprint.fingerprint_excerpt(source_id, s, e, text)

        cid = db.insert_candidate(
            source_id=source_id,
            campaign_id=src["campaign_id"],
            start_s=s, end_s=e,
            hook=c.get("hook"),
            rank_score=c.get("score"),
            rank_rationale=c.get("rationale"),
            transcript_excerpt=text[:5000],
            ngram_hash=n_hash,
            perceptual_hash=p_hash,
            duplicate_score=dup_score,
            status="candidate",
        )
        persisted += 1
        print(f"  candidate id={cid} {s:.1f}-{e:.1f} dup={dup_score:.2f} hook={c.get('hook')!r}", file=sys.stderr)

    print(f"persisted {persisted} candidates", file=sys.stderr)
    return 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("source_id", type=int)
    p.add_argument("--top", type=int, default=5)
    p.add_argument("--model", default="sonnet")
    args = p.parse_args(argv)
    return run(args.source_id, top=args.top, model=args.model)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

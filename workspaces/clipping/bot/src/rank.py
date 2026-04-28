"""Rank moments in a transcript by clip-virality potential.

Sends sliding 5-min windows (30s overlap) to Claude with the rank-moments prompt,
parses JSON candidates, returns top-N per source.

Usage:
    python bot/src/rank.py <source-id> [--top 5] [--model sonnet]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import db
import transcribe
from lib.claude import claude_json, load_prompt

WINDOW_S = 300
OVERLAP_S = 30


def chunk_segments(segments: list[dict], window_s: int = WINDOW_S, overlap_s: int = OVERLAP_S):
    """Yield (start_s, end_s, text) windows."""
    if not segments:
        return
    total = segments[-1]["end"] or 0
    cursor = 0
    while cursor < total:
        win_end = min(cursor + window_s, total)
        chunk = [s for s in segments if s["end"] is not None and s["start"] is not None
                 and s["end"] > cursor and s["start"] < win_end]
        text = "\n".join(f"[{s['start']:.1f}-{s['end']:.1f}] {s['text']}" for s in chunk)
        if text.strip():
            yield cursor, win_end, text
        if win_end >= total:
            return
        cursor = max(cursor + window_s - overlap_s, cursor + 1)


def rank_source(source_id: int, top: int = 5, model: str = "sonnet") -> list[dict]:
    src = db.get_source(source_id)
    if not src:
        raise SystemExit(f"no source id={source_id}")
    if not src["campaign_id"]:
        raise SystemExit(f"source {source_id} has no campaign_id; cannot rank without campaign rules")

    transcripts = transcribe.transcribe(source_id)
    segments = transcripts.get("segments", [])

    prompt_template = load_prompt("rank-moments")
    out: list[dict] = []
    for win_start, win_end, text in chunk_segments(segments):
        prompt = prompt_template.replace("__WINDOW_START__", f"{win_start:.1f}") \
                                .replace("__WINDOW_END__", f"{win_end:.1f}") \
                                .replace("__TRANSCRIPT_WINDOW__", text) \
                                .replace("__TOP_N__", str(top))
        try:
            cands = claude_json(prompt, model=model, timeout_s=180)
        except Exception as e:
            print(f"window {win_start}-{win_end}: rank failed: {e}", file=sys.stderr)
            continue
        if not isinstance(cands, list):
            continue
        for c in cands:
            if not all(k in c for k in ("start_s", "end_s", "hook", "score")):
                continue
            if c["start_s"] >= c["end_s"] or (c["end_s"] - c["start_s"]) > 90:
                continue
            out.append(c)

    out.sort(key=lambda x: x.get("score", 0), reverse=True)
    return out[: top * 6]  # carry 6x window's top to allow downstream pruning


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("source_id", type=int)
    p.add_argument("--top", type=int, default=5)
    p.add_argument("--model", default="sonnet")
    p.add_argument("--print", action="store_true")
    args = p.parse_args(argv)
    cands = rank_source(args.source_id, top=args.top, model=args.model)
    if args.print:
        print(json.dumps(cands, indent=2))
    print(f"ranked {len(cands)} candidates", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

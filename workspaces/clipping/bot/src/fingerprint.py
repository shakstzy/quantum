"""Compute clip fingerprints (transcript n-gram hash + perceptual frame hash).

Per Adv Review v2: every candidate must be deduped against the last 30 days
of `clip_candidates` before render.

Usage:
    python bot/src/fingerprint.py <source-id> --start 12.5 --end 47.0
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import db


def normalize_text(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def ngrams(text: str, n: int = 8) -> list[str]:
    words = normalize_text(text).split()
    if len(words) < n:
        return [" ".join(words)] if words else []
    return [" ".join(words[i:i + n]) for i in range(len(words) - n + 1)]


def ngram_hash(text: str, n: int = 8) -> str:
    grams = sorted(set(ngrams(text, n)))
    return hashlib.sha256(("\n".join(grams)).encode()).hexdigest()


def perceptual_hash(source_filepath: str, midpoint_s: float) -> str:
    """Extract a single I-frame at midpoint and pHash it."""
    import imagehash
    from PIL import Image

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        proc = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{midpoint_s}",
             "-i", source_filepath, "-frames:v", "1", "-q:v", "2", tmp_path],
            capture_output=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg phash extract failed: {proc.stderr.decode(errors='replace')}")
        img = Image.open(tmp_path).convert("RGB")
        return str(imagehash.phash(img, hash_size=16))
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def fingerprint_excerpt(source_id: int, start_s: float, end_s: float,
                        transcript_excerpt: str) -> tuple[str, str, float]:
    """Return (ngram_hash, perceptual_hash, duplicate_score)."""
    src = db.get_source(source_id)
    if not src:
        raise SystemExit(f"no source id={source_id}")

    n_hash = ngram_hash(transcript_excerpt)
    midpoint = (start_s + end_s) / 2
    p_hash = perceptual_hash(src["filepath"], midpoint)
    matches = db.find_duplicate_candidates(n_hash, p_hash, days=30)
    score = min(1.0, len(matches) / 5.0)
    return n_hash, p_hash, score


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("source_id", type=int)
    p.add_argument("--start", type=float, required=True)
    p.add_argument("--end", type=float, required=True)
    p.add_argument("--text", required=True, help="transcript excerpt for the candidate")
    args = p.parse_args(argv)
    n, ph, score = fingerprint_excerpt(args.source_id, args.start, args.end, args.text)
    print(json.dumps({"ngram_hash": n, "perceptual_hash": ph, "duplicate_score": score}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""Transcribe a source video with mlx-whisper. Cache forever by (source_id, model).

Per Adv Review v2: never re-whisper. The transcript is the most expensive step.

Usage:
    python bot/src/transcribe.py <source-id> [--model <model>]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import db

DEFAULT_MODEL = os.environ.get("CLIPPING_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
TRANSCRIPT_DIR = Path.home() / ".quantum" / "clipping" / "transcripts"


def audio_hash(filepath: str) -> str:
    """SHA256 of first 60s of mono 16kHz audio. Stable across reencodes of same source."""
    proc = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", filepath,
         "-t", "60", "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg audio_hash failed: {proc.stderr.decode(errors='replace')}")
    return hashlib.sha256(proc.stdout).hexdigest()


def transcribe(source_id: int, model: str = DEFAULT_MODEL) -> dict:
    src = db.get_source(source_id)
    if not src:
        raise SystemExit(f"no source row for id={source_id}")
    if not src["filepath"] or not Path(src["filepath"]).exists():
        raise SystemExit(f"source filepath missing: {src['filepath']}")

    cached = db.find_transcript(source_id, model)
    if cached:
        print(f"cache hit: {cached['filepath']}", file=sys.stderr)
        return json.loads(Path(cached["filepath"]).read_text())

    a_hash = src["audio_hash"] or audio_hash(src["filepath"])

    print(f"whispering {src['filepath']} with {model}...", file=sys.stderr)
    import mlx_whisper
    result = mlx_whisper.transcribe(
        src["filepath"],
        path_or_hf_repo=model,
        word_timestamps=True,
    )

    out = {
        "model": model,
        "audio_hash": a_hash,
        "language": result.get("language"),
        "duration": result.get("duration"),
        "segments": [
            {
                "start": s.get("start"),
                "end": s.get("end"),
                "text": s.get("text", "").strip(),
                "words": [
                    {"word": w["word"], "start": w["start"], "end": w["end"]}
                    for w in s.get("words", [])
                    if "start" in w and "end" in w
                ],
            }
            for s in result.get("segments", [])
        ],
    }

    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    safe_model = model.replace("/", "_")
    out_path = TRANSCRIPT_DIR / f"{src['source_video_id']}-{safe_model}.json"
    out_path.write_text(json.dumps(out, indent=2))

    word_count = sum(len(s["words"]) for s in out["segments"])
    db.insert_transcript(
        source_id=source_id,
        model_version=model,
        audio_hash=a_hash,
        filepath=str(out_path),
        word_count=word_count,
        duration_s=out.get("duration"),
    )
    print(f"wrote {out_path} ({word_count} words)", file=sys.stderr)
    return out


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("source_id", type=int)
    p.add_argument("--model", default=DEFAULT_MODEL)
    args = p.parse_args(argv)
    transcribe(args.source_id, model=args.model)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

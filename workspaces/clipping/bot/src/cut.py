"""Refine candidate boundaries via PySceneDetect, snap to nearest shot change.

Used by the clip pipeline before persisting candidates: takes LLM-suggested
(start_s, end_s) and snaps each end to the nearest shot change within +/- 1.5s.

Usage:
    python bot/src/cut.py <source-id> --start 12.5 --end 47.0
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import db


def detect_shots(filepath: str, t_min: float, t_max: float, threshold: float = 27.0) -> list[float]:
    """Return shot-change timestamps (seconds) within [t_min, t_max]."""
    from scenedetect import open_video, SceneManager, ContentDetector
    video = open_video(filepath)
    sm = SceneManager()
    sm.add_detector(ContentDetector(threshold=threshold))
    video.seek(target=max(0.0, t_min - 2.0))
    sm.detect_scenes(video=video, end_time=t_max + 2.0)
    cuts = []
    for start, end in sm.get_scene_list():
        cuts.append(start.get_seconds())
        cuts.append(end.get_seconds())
    return sorted(set(t for t in cuts if t_min - 2 <= t <= t_max + 2))


def snap(boundary_s: float, shots: list[float], window_s: float = 1.5) -> float:
    in_window = [t for t in shots if abs(t - boundary_s) <= window_s]
    if not in_window:
        return boundary_s
    return min(in_window, key=lambda t: abs(t - boundary_s))


def refine(source_id: int, start_s: float, end_s: float) -> tuple[float, float]:
    src = db.get_source(source_id)
    if not src or not src["filepath"]:
        return start_s, end_s
    try:
        shots = detect_shots(src["filepath"], start_s, end_s)
    except Exception as e:
        print(f"scenedetect failed: {e}; using original boundaries", file=sys.stderr)
        return start_s, end_s
    new_start = snap(start_s, shots)
    new_end = snap(end_s, shots)
    if new_end <= new_start:
        return start_s, end_s
    return new_start, new_end


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("source_id", type=int)
    p.add_argument("--start", type=float, required=True)
    p.add_argument("--end", type=float, required=True)
    args = p.parse_args(argv)
    s, e = refine(args.source_id, args.start, args.end)
    print(json.dumps({"start_s": s, "end_s": e}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

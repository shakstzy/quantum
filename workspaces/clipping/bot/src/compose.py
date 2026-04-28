"""Render a clip_candidate to a vertical 9:16 mp4 with word-level captions.

Drives the Remotion project at workspaces/clipping/remotion/.

Usage:
    python bot/src/compose.py <candidate-id>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import db
import clip as clipmod

WS_ROOT = Path(__file__).resolve().parents[2]
REMOTION_ROOT = WS_ROOT / "remotion"
CANDIDATES_DIR = Path.home() / ".quantum" / "clipping" / "candidates"


def cut_segment(source_path: str, start_s: float, end_s: float, out_path: Path) -> None:
    cmd = ["ffmpeg", "-y", "-loglevel", "error",
           "-ss", f"{start_s}", "-to", f"{end_s}",
           "-i", source_path,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-c:a", "aac", "-b:a", "128k",
           str(out_path)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg cut failed: {proc.stderr}")


def detect_face_track(cut_path: str) -> list[dict]:
    """Sample one frame per second, run a Haar face detector, return [(t, x, y, w, h)]."""
    import cv2
    cap = cv2.VideoCapture(cut_path)
    if not cap.isOpened():
        return []
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080)
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(cascade_path)
    track: list[dict] = []
    for sec in range(int(total / fps) + 1):
        cap.set(cv2.CAP_PROP_POS_MSEC, sec * 1000)
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.2, minNeighbors=5)
        if len(faces):
            x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
            cx, cy = x + w / 2, y + h / 2
        else:
            cx, cy = width / 2, height / 2
        track.append({"t": sec, "cx": float(cx), "cy": float(cy), "w": float(width), "h": float(height)})
    cap.release()
    return track


def smooth_track(track: list[dict], alpha: float = 0.3) -> list[dict]:
    if not track:
        return track
    smoothed = [dict(track[0])]
    for cur in track[1:]:
        prev = smoothed[-1]
        smoothed.append({
            "t": cur["t"],
            "cx": prev["cx"] * (1 - alpha) + cur["cx"] * alpha,
            "cy": prev["cy"] * (1 - alpha) + cur["cy"] * alpha,
            "w": cur["w"], "h": cur["h"],
        })
    return smoothed


def render(candidate_id: int) -> int:
    cand = db.get_candidate(candidate_id)
    if not cand:
        print(f"no candidate id={candidate_id}", file=sys.stderr)
        return 2
    if cand["duplicate_score"] is not None and cand["duplicate_score"] > 0.0:
        print(f"refusing render: duplicate_score={cand['duplicate_score']:.2f}", file=sys.stderr)
        return 3

    src = db.get_source(cand["source_id"])
    tx_row = db.find_transcript(cand["source_id"], os.environ.get("CLIPPING_WHISPER_MODEL",
                                                                  "mlx-community/whisper-large-v3-turbo"))
    if not tx_row:
        print("no transcript cached; run transcribe first", file=sys.stderr)
        return 2
    tx = json.loads(Path(tx_row["filepath"]).read_text())

    CANDIDATES_DIR.mkdir(parents=True, exist_ok=True)
    out_path = CANDIDATES_DIR / f"{candidate_id}.mp4"

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        cut_path = td / "cut.mp4"
        cut_segment(src["filepath"], cand["start_s"], cand["end_s"], cut_path)

        track = smooth_track(detect_face_track(str(cut_path)))
        words = clipmod.words_in_window(tx["segments"], cand["start_s"], cand["end_s"])
        props = {
            "videoSrc": str(cut_path),
            "durationSec": cand["end_s"] - cand["start_s"],
            "faceTrack": track,
            "captions": words,
            "hook": cand["hook"] or "",
        }
        props_path = td / "props.json"
        props_path.write_text(json.dumps(props))

        cmd = ["npx", "remotion", "render", "src/index.ts", "ClipComposition",
               str(out_path),
               "--props", str(props_path),
               "--codec=h264",
               "--concurrency=4"]
        proc = subprocess.run(cmd, cwd=REMOTION_ROOT, capture_output=True, text=True)
        if proc.returncode != 0:
            print("remotion render stderr:", proc.stderr[-2000:], file=sys.stderr)
            return 1

    rh = hashlib.sha256(out_path.read_bytes()[:1024 * 1024]).hexdigest()
    rid = db.insert_render(
        candidate_id=candidate_id,
        template="vertical-captions-v1",
        filepath=str(out_path),
        duration_s=cand["end_s"] - cand["start_s"],
        render_hash=rh,
    )
    db.update_candidate_status(candidate_id, "rendered")
    print(f"rendered candidate {candidate_id} -> render id={rid} {out_path}", file=sys.stderr)
    return 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("candidate_id", type=int)
    args = p.parse_args(argv)
    return render(args.candidate_id)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

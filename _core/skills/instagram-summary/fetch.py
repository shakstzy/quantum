#!/usr/bin/env python3
"""
Instagram post/reel fetcher + summarizer.

Posts: caption + metadata + visual analysis (cloud-llm).
Reels: same plus audio transcript (faster-whisper).
"""
import json
import re
import sys
import time
import subprocess
import tempfile
import urllib.request
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from instaloader import Instaloader, Post
from instaloader.exceptions import InstaloaderException, LoginRequiredException

# Cloud LLM dispatch lives in the cloud-llm skill so providers/models change in one place.
sys.path.insert(0, "/Users/shakstzy/QUANTUM/_core/skills/cloud-llm")
from client import describe_images, CloudLLMUnreachable

SHORTCODE_RE = re.compile(
    r"instagram\.com/(?:share/)?(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)"
)
REEL_RE = re.compile(r"/(?:share/)?reels?/")

WHISPER_MODEL = "small.en"
N_FRAMES = 4
MAX_TOKENS = 400
CAROUSEL_CAP = 10
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Safari/605"


def count(n) -> str:
    return "(hidden)" if n is None or n < 0 else str(n)


def shortcode(url: str) -> str:
    m = SHORTCODE_RE.search(url)
    if not m:
        sys.exit(f"Could not parse Instagram shortcode from: {url}")
    return m.group(1)


def fetch_post(url: str) -> dict:
    L = Instaloader(quiet=True)
    try:
        post = Post.from_shortcode(L.context, shortcode(url))
    except LoginRequiredException:
        return {"error": "LoginRequired: run `~/.quantum/instagram-summary/.venv/bin/instaloader --login=<username>` once."}
    except InstaloaderException as e:
        return {"error": f"{type(e).__name__}: {e}"}
    return {"post": post}


def post_image_urls(post: Post, cap: int) -> list[str]:
    """Returns image URLs for a post. For carousels, uses display_url (image or video thumbnail)."""
    if post.typename == "GraphSidecar":
        urls = []
        for node in post.get_sidecar_nodes():
            urls.append(node.display_url)
            if len(urls) >= cap:
                break
        return urls
    return [post.url]


def download_image(url: str, out: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r, open(out, "wb") as f:
            f.write(r.read())
    except Exception as e:
        sys.exit(f"Image download failed: {type(e).__name__}: {e}")


def download_video(url: str, out: Path) -> None:
    r = subprocess.run(
        ["yt-dlp", "-f", "mp4/best", "--merge-output-format", "mp4",
         "-o", str(out), "--no-warnings", "--quiet", url],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"yt-dlp failed: {r.stderr.strip() or r.stdout.strip()}")


def probe_video(video: Path) -> tuple[bool, float]:
    r = subprocess.run(
        ["ffprobe", "-v", "error",
         "-show_entries", "format=duration:stream=codec_type",
         "-of", "json", str(video)],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(r.stdout)
    has_audio = any(s.get("codec_type") == "audio" for s in data.get("streams", []))
    try:
        duration = float(data["format"]["duration"])
    except (KeyError, ValueError):
        duration = 0.0
    if duration <= 0:
        sys.exit("Could not determine video duration.")
    return has_audio, duration


def extract_audio(video: Path, audio: Path) -> None:
    r = subprocess.run(
        ["ffmpeg", "-y", "-i", str(video), "-ac", "1", "-ar", "16000",
         "-loglevel", "error", str(audio)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"ffmpeg audio extract failed: {r.stderr.strip()}")


def extract_frames(video: Path, out_dir: Path, n: int, duration: float) -> list[Path]:
    out_dir.mkdir(exist_ok=True)
    frames = []
    for i in range(n):
        t = duration * (i + 0.5) / n
        frame = out_dir / f"f{i:02d}.jpg"
        r = subprocess.run(
            ["ffmpeg", "-y", "-ss", f"{t:.2f}", "-i", str(video),
             "-vframes", "1", "-q:v", "3", "-loglevel", "error", str(frame)],
            capture_output=True, text=True,
        )
        if r.returncode != 0 or not frame.exists():
            sys.exit(f"ffmpeg frame extract failed at t={t:.2f}s: {r.stderr.strip()}")
        frames.append(frame)
    return frames


def transcribe(audio: Path) -> str:
    from faster_whisper import WhisperModel
    model = WhisperModel(WHISPER_MODEL, device="auto", compute_type="int8")
    segments, _ = model.transcribe(str(audio), vad_filter=True)
    return " ".join(s.text.strip() for s in segments).strip()


def analyze_visual(images: list[Path], caption: str, kind: str, transcript: str = "") -> str:
    """Vision+text synthesis delegated to the shared cloud-llm skill.

    Engine cycle (URL, models, accounts) lives in `_core/skills/cloud-llm/client.py`:
    gemini Pro across cached accounts → gemini Flash → claude -p sonnet.
    """
    visual_desc = "frames sampled across the reel" if kind == "reel" else "images from the post"
    audio_line = f"AUDIO TRANSCRIPT: {transcript or '(no speech)'}\n\n" if kind == "reel" else ""
    prompt_text = (
        f"You are analyzing an Instagram {kind}. You are given the poster's caption"
        f"{', the audio transcript,' if kind == 'reel' else ''} and "
        f"{len(images)} {visual_desc}.\n\n"
        f"CAPTION: {caption or '(empty)'}\n"
        f"{audio_line}"
        "Write a tight summary: what happens visually, the main message or hook, "
        "and any takeaway. If the images form a narrative sequence (tutorial, story, "
        "before/after), call that out. Do not pad. Do not restate the caption verbatim."
    )

    try:
        result = describe_images([str(p) for p in images], prompt_text)
    except CloudLLMUnreachable as e:
        sys.exit(f"cloud-llm dispatch failed:\n{e}")
    return result["output"]


def handle_reel(url: str) -> None:
    t0 = time.time()
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "reel.mp4"
        audio = tmp / "audio.wav"
        frames_dir = tmp / "frames"

        download_video(url, video)
        audio_present, duration = probe_video(video)
        if audio_present:
            extract_audio(video, audio)

        with ThreadPoolExecutor(max_workers=3) as pool:
            f_trans = pool.submit(transcribe, audio) if audio_present else None
            f_frames = pool.submit(extract_frames, video, frames_dir, N_FRAMES, duration)
            f_meta = pool.submit(fetch_post, url)
            try:
                transcript = f_trans.result() if f_trans else ""
                frames = f_frames.result()
                meta = f_meta.result()
            except Exception as e:
                sys.exit(f"Pipeline stage failed: {type(e).__name__}: {e}")

        if "error" in meta:
            post = None
            caption = ""
        else:
            post = meta["post"]
            caption = post.caption or ""

        summary = analyze_visual(frames, caption, kind="reel", transcript=transcript)

    elapsed = time.time() - t0
    print("TYPE: reel")
    print(f"AUTHOR: @{post.owner_username if post else '?'}")
    print(f"DATE: {post.date_utc.isoformat() if post else '?'}")
    print(f"LIKES: {count(post.likes if post else None)}  COMMENTS: {count(post.comments if post else None)}")
    print(f"CAPTION:\n{caption or '(no caption)'}")
    print(f"\nAUDIO TRANSCRIPT:\n{transcript or '(no speech detected)'}")
    print(f"\nVISUAL+SYNTHESIS SUMMARY:\n{summary}")
    print(f"\n[pipeline: {elapsed:.1f}s]", file=sys.stderr)


def handle_post(url: str) -> None:
    t0 = time.time()
    meta = fetch_post(url)
    if "error" in meta:
        sys.exit(meta["error"])
    post = meta["post"]
    is_carousel = post.typename == "GraphSidecar"
    total_items = post.mediacount if is_carousel else 1

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        imgs_dir = tmp / "imgs"
        imgs_dir.mkdir()
        paths = []
        for i, u in enumerate(post_image_urls(post, CAROUSEL_CAP)):
            p = imgs_dir / f"img{i:02d}.jpg"
            download_image(u, p)
            paths.append(p)
        summary = analyze_visual(paths, post.caption or "", kind="post")

    elapsed = time.time() - t0
    print("TYPE: post")
    print(f"AUTHOR: @{post.owner_username}")
    print(f"DATE: {post.date_utc.isoformat()}")
    print(f"LIKES: {count(post.likes)}  COMMENTS: {count(post.comments)}")
    if is_carousel:
        suffix = f" (analyzed first {CAROUSEL_CAP})" if total_items > CAROUSEL_CAP else ""
        print(f"CAROUSEL: {total_items} items{suffix}")
    print(f"CAPTION:\n{post.caption or '(no caption)'}")
    print(f"\nVISUAL+SYNTHESIS SUMMARY:\n{summary}")
    print(f"\n[pipeline: {elapsed:.1f}s]", file=sys.stderr)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: fetch.py <instagram-url>")
    url = sys.argv[1]
    shortcode(url)  # validate
    (handle_reel if REEL_RE.search(url) else handle_post)(url)


if __name__ == "__main__":
    main()

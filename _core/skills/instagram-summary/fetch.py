#!/usr/bin/env python3
"""
Instagram post/reel fetcher + summarizer.

Posts (single image or carousel): caption + metadata + visual analysis of images (MLX Gemma 4 26B-A4B).
Reels: caption + metadata + audio transcript (faster-whisper) + visual analysis of sampled frames.
"""
import re
import sys
import time
import subprocess
import tempfile
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from instaloader import Instaloader, Post
from instaloader.exceptions import InstaloaderException, LoginRequiredException

# Delegate all daemon contract (URL, model, payload) to the local-llm skill.
# If Gemma's port/model/host changes, only that skill's client.py is edited.
sys.path.insert(0, "/Users/shakstzy/QUANTUM/_core/skills/local-llm")
from client import chat as local_llm_chat, image_block, LocalLLMUnreachable, UNREACHABLE_HINT

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


def has_audio_stream(video: Path) -> bool:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=codec_type",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video)],
        capture_output=True, text=True,
    )
    return "audio" in r.stdout


def extract_audio(video: Path, audio: Path) -> None:
    r = subprocess.run(
        ["ffmpeg", "-y", "-i", str(video), "-ac", "1", "-ar", "16000",
         "-loglevel", "error", str(audio)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"ffmpeg audio extract failed: {r.stderr.strip()}")


def video_duration(video: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video)],
        capture_output=True, text=True, check=True,
    )
    try:
        d = float(r.stdout.strip())
    except ValueError:
        d = 0.0
    if d <= 0:
        sys.exit("Could not determine video duration.")
    return d


def extract_frames(video: Path, out_dir: Path, n: int) -> list[Path]:
    out_dir.mkdir(exist_ok=True)
    duration = video_duration(video)
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


LOCAL_LLM_URL = "http://127.0.0.1:8765/v1/chat/completions"


def analyze_visual(images: list[Path], caption: str, kind: str, transcript: str = "") -> str:
    """Vision+text synthesis via the shared local-llm server (mlx_vlm.server, Gemma 4 26B-A4B).

    Server contract: _core/skills/local-llm/SKILL.md.
    No in-process MLX load; the daemon stays warm across calls.
    """
    import base64
    import json

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

    content: list[dict] = [{"type": "text", "text": prompt_text}]
    for img in images:
        b64 = base64.b64encode(img.read_bytes()).decode()
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })

    payload = json.dumps({
        "model": MLX_MODEL,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": MAX_TOKENS,
        "temperature": 0.3,
    }).encode()

    req = urllib.request.Request(
        LOCAL_LLM_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.loads(r.read())
    except urllib.error.URLError as e:
        sys.exit(
            f"local-llm server unreachable at {LOCAL_LLM_URL}: {e}\n"
            f"Ensure the shared local-llm skill is installed and running:\n"
            f"  bash /Users/shakstzy/QUANTUM/_core/skills/local-llm/scripts/status.sh\n"
            f"If not installed:\n"
            f"  bash /Users/shakstzy/QUANTUM/_core/skills/local-llm/scripts/install.sh"
        )
    return data["choices"][0]["message"]["content"]


def handle_reel(url: str) -> None:
    t0 = time.time()
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "reel.mp4"
        audio = tmp / "audio.wav"
        frames_dir = tmp / "frames"

        download_video(url, video)
        audio_present = has_audio_stream(video)
        if audio_present:
            extract_audio(video, audio)

        with ThreadPoolExecutor(max_workers=3) as pool:
            f_trans = pool.submit(transcribe, audio) if audio_present else None
            f_frames = pool.submit(extract_frames, video, frames_dir, N_FRAMES)
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
        urls = post_image_urls(post, CAROUSEL_CAP)
        paths = []
        for i, u in enumerate(urls):
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

#!/usr/bin/env python3
"""Drive ingest for one account: full metadata index + selective body extraction.

Pass A: enumerate every non-trashed file (own + shared-with-me) and write metadata
        to raw/gdrive/<account>/_index.ndjson.

Pass B: for each file, route by mimeType + size:
  - Native Google Doc/Slides       -> export to .md  via gog drive download --format md
  - Native Google Sheet            -> export to .csv via gog drive download --format csv
  - PDF / Word / PowerPoint / HTML -> download then markitdown to .md (drop original)
  - Plain text formats (md/txt/csv/json/code) under threshold -> download verbatim
  - Excel sheets                   -> markitdown to .md
  - Images, audio, video           -> SKIP body, metadata only
  - Anything > 25 MB without a markitdown route -> SKIP body, metadata only

Resumable: tracks processed file IDs in raw/.ingest-log/gdrive-<account>.files.txt.
Paced at 5 req/sec. Read-only operations only.
"""
from __future__ import annotations
import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[3]
RAW = ROOT / "raw" / "gdrive"
LOG = ROOT / "raw" / ".ingest-log"

PACE_SEC = 0.1  # Drive quota is roomier (12k/min/user); 10/sec safe
MAX_RETRIES = 6
HEAVY_MAX_BYTES = 25 * 1024 * 1024  # 25 MB

# Native Google formats -> export format.
NATIVE_EXPORTS = {
    "application/vnd.google-apps.document": ("md", "md"),
    "application/vnd.google-apps.presentation": ("md", "md"),
    "application/vnd.google-apps.spreadsheet": ("csv", "csv"),
}

# Office / web formats -> download, then markitdown.
MARKITDOWN_MIMES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/msword",
    "application/vnd.ms-powerpoint",
    "application/vnd.ms-excel",
    "application/rtf",
    "application/epub+zip",
    "text/html",
    "application/xhtml+xml",
}

# Plain text mimetypes -> download verbatim.
PLAIN_TEXT_PREFIXES = ("text/",)
PLAIN_TEXT_EXACT = {
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/javascript",
    "application/x-sh",
    "application/x-typescript",
}

# Skip these entirely (body), keep metadata.
SKIP_PREFIXES = ("image/", "audio/", "video/")


def gog_json(args: list[str]) -> dict | list:
    delay = 1.0
    last_err = ""
    for _ in range(MAX_RETRIES):
        proc = subprocess.run(["gog", "-j", *args], check=False, capture_output=True, text=True)
        if proc.returncode == 0:
            return json.loads(proc.stdout) if proc.stdout.strip() else {}
        last_err = proc.stderr.strip()
        retryable = any(t in last_err for t in (
            "rateLimitExceeded", "userRateLimitExceeded", "Quota exceeded",
            "429", "503", "500", "502", "504",
            "backendError", "internalError",
            "TLS handshake timeout", "i/o timeout", "context deadline",
            "connection reset", "EOF", "no such host", "temporary failure",
        ))
        if not retryable:
            raise RuntimeError(f"gog {' '.join(args)} failed (exit {proc.returncode}): {last_err}")
        time.sleep(delay)
        delay = min(delay * 2, 60.0)
    raise RuntimeError(f"gog {' '.join(args)} failed after {MAX_RETRIES} retries: {last_err}")


def slugify(account: str) -> str:
    return account.replace("@", "-").replace(".", "-")


def classify(file: dict) -> str:
    """Return one of: native, markitdown, plaintext, skip."""
    mime = (file.get("mimeType") or "").lower()
    size_str = file.get("size")
    size = int(size_str) if size_str and str(size_str).isdigit() else 0

    if mime in NATIVE_EXPORTS:
        return "native"
    if any(mime.startswith(p) for p in SKIP_PREFIXES):
        return "skip"
    if mime in MARKITDOWN_MIMES:
        if size and size > HEAVY_MAX_BYTES:
            return "skip"
        return "markitdown"
    if mime in PLAIN_TEXT_EXACT or any(mime.startswith(p) for p in PLAIN_TEXT_PREFIXES):
        if size and size > HEAVY_MAX_BYTES:
            return "skip"
        return "plaintext"
    return "skip"


def enumerate_files(account: str) -> list[dict]:
    """Page through drive search, return all non-trashed file metadata."""
    print(f"[{account}] enumerating drive files...", flush=True)
    files: list[dict] = []
    page_token: str | None = None
    page_n = 0
    while True:
        page_n += 1
        cmd = [
            "-a", account,
            "drive", "search",
            "--raw-query", "trashed=false",
            "--max", "1000",
        ]
        if page_token:
            cmd += ["--page", page_token]
        result = gog_json(cmd)
        batch = (result or {}).get("files") or (result or {}).get("items") or []
        files.extend(batch)
        page_token = (result or {}).get("nextPageToken")
        print(f"[{account}]   page {page_n}: +{len(batch)} (total {len(files)})", flush=True)
        if not page_token:
            break
        time.sleep(PACE_SEC)
    return files


def safe_ext(file: dict, fallback: str) -> str:
    name = file.get("name") or ""
    if "." in name:
        ext = name.rsplit(".", 1)[1].lower()
        if 1 <= len(ext) <= 6 and ext.isalnum():
            return ext
    return fallback


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--account", required=True)
    args = parser.parse_args()
    account = args.account
    slug = slugify(account)

    out_dir = RAW / slug
    md_dir = out_dir / "md"
    files_dir = out_dir / "files"
    md_dir.mkdir(parents=True, exist_ok=True)
    files_dir.mkdir(parents=True, exist_ok=True)
    LOG.mkdir(parents=True, exist_ok=True)

    state_path = LOG / f"gdrive-{slug}.files.txt"
    err_path = LOG / f"gdrive-{slug}.errors.log"
    index_path = out_dir / "_index.ndjson"

    processed: set[str] = set()
    if state_path.exists():
        processed = {line.strip() for line in state_path.read_text().splitlines() if line.strip()}
        print(f"[{account}] resuming: {len(processed)} files already processed", flush=True)

    # Pass A: index.
    files = enumerate_files(account)
    with index_path.open("w") as fh:
        for f in files:
            fh.write(json.dumps(f, ensure_ascii=False) + "\n")
    print(f"[{account}] index written: {len(files)} files", flush=True)

    # Pass B: bodies.
    state_fh = state_path.open("a")
    err_fh = err_path.open("a")
    counts = {"native": 0, "markitdown": 0, "plaintext": 0, "skip": 0, "fail": 0}

    try:
        for i, f in enumerate(files, 1):
            fid = f.get("id")
            if not fid or fid in processed:
                continue
            mime = (f.get("mimeType") or "").lower()
            decision = classify(f)

            if decision == "skip":
                counts["skip"] += 1
                state_fh.write(fid + "\n")
                state_fh.flush()
                continue

            try:
                if decision == "native":
                    fmt, ext = NATIVE_EXPORTS[mime]
                    out_path = md_dir / f"{fid}.{ext}"
                    subprocess.run(
                        ["gog", "-a", account, "drive", "download", fid,
                         "--format", fmt, "--out", str(out_path)],
                        check=True, capture_output=True, text=True, timeout=120,
                    )
                    counts["native"] += 1
                elif decision == "plaintext":
                    ext = safe_ext(f, "txt")
                    out_path = files_dir / f"{fid}.{ext}"
                    subprocess.run(
                        ["gog", "-a", account, "drive", "download", fid, "--out", str(out_path)],
                        check=True, capture_output=True, text=True, timeout=120,
                    )
                    counts["plaintext"] += 1
                elif decision == "markitdown":
                    ext = safe_ext(f, "bin")
                    raw_path = files_dir / f"{fid}.{ext}"
                    md_path = md_dir / f"{fid}.md"
                    subprocess.run(
                        ["gog", "-a", account, "drive", "download", fid, "--out", str(raw_path)],
                        check=True, capture_output=True, text=True, timeout=300,
                    )
                    md_proc = subprocess.run(
                        ["markitdown", str(raw_path), "-o", str(md_path)],
                        check=False, capture_output=True, text=True, timeout=300,
                    )
                    if md_proc.returncode == 0 and md_path.exists() and md_path.stat().st_size > 0:
                        # Markitdown succeeded -> drop the binary original.
                        try:
                            raw_path.unlink()
                        except OSError:
                            pass
                        counts["markitdown"] += 1
                    else:
                        # Conversion failed; keep the original so we at least have the bytes.
                        err_fh.write(f"{fid}\tmarkitdown failed: {md_proc.stderr.strip()[:300]}\n")
                        err_fh.flush()
                        counts["fail"] += 1
            except subprocess.CalledProcessError as e:
                err_fh.write(f"{fid}\t{decision} failed: {e.stderr.strip()[:300]}\n")
                err_fh.flush()
                counts["fail"] += 1
            except subprocess.TimeoutExpired:
                err_fh.write(f"{fid}\t{decision} timed out\n")
                err_fh.flush()
                counts["fail"] += 1

            state_fh.write(fid + "\n")
            state_fh.flush()
            if i % 25 == 0:
                print(f"[{account}]   {i}/{len(files)}  {counts}", flush=True)
            time.sleep(PACE_SEC)
    finally:
        state_fh.close()
        err_fh.close()

    print(f"[{account}] done. {counts}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

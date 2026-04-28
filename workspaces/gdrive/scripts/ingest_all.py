#!/Users/shakstzy/QUANTUM/_core/scripts/.venv/bin/python
"""Drive ingest for one account: full metadata index + clean-markdown body extraction.

Pass A: enumerate every non-trashed file (own + shared-with-me) and write metadata
        to raw/gdrive/<account>/_index.ndjson.

Pass B: route by mimeType to a per-type tool that produces clean markdown:

  Google Doc       -> gog drive download --format md            (Drive native export)
  Google Sheet     -> gog drive download --format csv           (Drive native export)
  Google Slides    -> gog drive download --format pptx, then pptx2md
  PDF              -> pymupdf4llm.to_markdown (in-process, fast)
  DOCX             -> pandoc -f docx -t gfm --wrap=none
  PPTX (Office)    -> pptx2md
  XLSX             -> markitdown (markdown table)
  HTML / EPUB / RTF / DOC / PPT / XLS -> markitdown (fallback)
  Plain text       -> download verbatim
  Image/audio/video -> SKIP body, metadata only
  > 25 MB without a route -> SKIP body, metadata only

Output naming: raw/gdrive/<account>/md/<sanitized-name>--<id8>.<ext>
               raw/gdrive/<account>/files/<sanitized-name>--<id8>.<ext>

All produced markdown is post-scrubbed for known artifacts (GoogleShape*.jpg lines,
file://file-* text-fragment URLs).

Resumable: tracks processed file IDs in raw/.ingest-log/gdrive-<account>.files.txt.
"""
from __future__ import annotations
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[3]
RAW = ROOT / "raw" / "gdrive"
LOG = ROOT / "raw" / ".ingest-log"

PACE_SEC = 0.1
MAX_RETRIES = 6
HEAVY_MAX_BYTES = 25 * 1024 * 1024  # 25 MB
NAME_MAX_LEN = 80
ID_SUFFIX_LEN = 8

# mime -> route tag
NATIVE_DOC = "application/vnd.google-apps.document"
NATIVE_SHEET = "application/vnd.google-apps.spreadsheet"
NATIVE_SLIDES = "application/vnd.google-apps.presentation"

PDF_MIME = "application/pdf"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# markitdown is the catch-all for older/legacy office and web formats.
MARKITDOWN_MIMES = {
    "application/msword",
    "application/vnd.ms-powerpoint",
    "application/vnd.ms-excel",
    "application/rtf",
    "application/epub+zip",
    "text/html",
    "application/xhtml+xml",
}

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

SKIP_PREFIXES = ("image/", "audio/", "video/")

# Post-scrub regexes for markdown.
SCRUB_PATTERNS = [
    re.compile(r"^\s*GoogleShape\d+p?\d*\.jpe?g\s*$", re.I | re.M),
    re.compile(r"file://file-[A-Za-z0-9]+#:~:text=[^\s)]*", re.I),
    re.compile(r"!\[\]\(GoogleShape\d+p?\d*\.jpe?g\)", re.I),  # empty image refs
]
COLLAPSE_BLANKS = re.compile(r"\n{3,}")


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


def gog_download(account: str, fid: str, out_path: pathlib.Path,
                 export_format: str | None = None, timeout: int = 300) -> None:
    """Download (or export) a Drive file with retries."""
    delay = 1.0
    last_err = ""
    for _ in range(MAX_RETRIES):
        cmd = ["gog", "-a", account, "drive", "download", fid, "--out", str(out_path)]
        if export_format:
            cmd += ["--format", export_format]
        proc = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=timeout)
        if proc.returncode == 0:
            return
        last_err = proc.stderr.strip()
        retryable = any(t in last_err for t in (
            "rateLimitExceeded", "userRateLimitExceeded", "Quota exceeded",
            "429", "503", "500", "502", "504",
            "backendError", "internalError",
            "TLS handshake timeout", "i/o timeout", "context deadline",
            "connection reset", "EOF", "no such host", "temporary failure",
        ))
        if not retryable:
            raise RuntimeError(last_err)
        time.sleep(delay)
        delay = min(delay * 2, 60.0)
    raise RuntimeError(f"download failed after {MAX_RETRIES} retries: {last_err}")


def slugify_account(account: str) -> str:
    return account.replace("@", "-").replace(".", "-")


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def sanitize_name(name: str) -> str:
    base = name.rsplit(".", 1)[0] if "." in name else name
    s = _SLUG_RE.sub("-", base.lower()).strip("-")
    return (s[:NAME_MAX_LEN].rstrip("-")) or "untitled"


def filename(file: dict, ext: str) -> str:
    name = sanitize_name(file.get("name") or "")
    fid = (file.get("id") or "")[:ID_SUFFIX_LEN]
    return f"{name}--{fid}.{ext}"


def safe_ext(file: dict, fallback: str) -> str:
    name = file.get("name") or ""
    if "." in name:
        ext = name.rsplit(".", 1)[1].lower()
        if 1 <= len(ext) <= 6 and ext.isalnum():
            return ext
    return fallback


def scrub_markdown(text: str) -> str:
    for pat in SCRUB_PATTERNS:
        text = pat.sub("", text)
    text = COLLAPSE_BLANKS.sub("\n\n", text)
    return text.strip() + "\n"


def write_md(md_path: pathlib.Path, text: str) -> None:
    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text(scrub_markdown(text))


def classify(file: dict) -> str:
    """Return route tag: native_doc, native_sheet, native_slides, pdf, docx, pptx,
    xlsx, markitdown, plaintext, skip."""
    mime = (file.get("mimeType") or "").lower()
    size_str = file.get("size")
    size = int(size_str) if size_str and str(size_str).isdigit() else 0
    if any(mime.startswith(p) for p in SKIP_PREFIXES):
        return "skip"
    if mime == NATIVE_DOC:
        return "native_doc"
    if mime == NATIVE_SHEET:
        return "native_sheet"
    if mime == NATIVE_SLIDES:
        return "native_slides"
    if mime == PDF_MIME:
        return "pdf" if not size or size <= HEAVY_MAX_BYTES else "skip"
    if mime == DOCX_MIME:
        return "docx" if not size or size <= HEAVY_MAX_BYTES else "skip"
    if mime == PPTX_MIME:
        return "pptx" if not size or size <= HEAVY_MAX_BYTES else "skip"
    if mime == XLSX_MIME:
        return "xlsx" if not size or size <= HEAVY_MAX_BYTES else "skip"
    if mime in MARKITDOWN_MIMES:
        return "markitdown" if not size or size <= HEAVY_MAX_BYTES else "skip"
    if mime in PLAIN_TEXT_EXACT or any(mime.startswith(p) for p in PLAIN_TEXT_PREFIXES):
        return "plaintext" if not size or size <= HEAVY_MAX_BYTES else "skip"
    return "skip"


def enumerate_files(account: str) -> list[dict]:
    print(f"[{account}] enumerating drive files...", flush=True)
    files: list[dict] = []
    page_token: str | None = None
    page_n = 0
    while True:
        page_n += 1
        cmd = ["-a", account, "drive", "search", "--raw-query", "trashed=false", "--max", "1000"]
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


def convert_pdf(src: pathlib.Path) -> str:
    import pymupdf4llm  # type: ignore
    return pymupdf4llm.to_markdown(str(src))


def run_pandoc(src: pathlib.Path) -> str:
    proc = subprocess.run(
        ["pandoc", "-f", "docx", "-t", "gfm", "--wrap=none", str(src)],
        check=True, capture_output=True, text=True, timeout=120,
    )
    return proc.stdout


def run_pptx2md(src: pathlib.Path, out: pathlib.Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["pptx2md", str(src), "--disable-image", "-o", str(out)],
        check=True, capture_output=True, text=True, timeout=300,
    )


def run_markitdown(src: pathlib.Path, out: pathlib.Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["markitdown", str(src), "-o", str(out)],
        check=True, capture_output=True, text=True, timeout=300,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--account", required=True)
    args = parser.parse_args()
    account = args.account
    slug = slugify_account(account)

    out_dir = RAW / slug
    md_dir = out_dir / "md"
    files_dir = out_dir / "files"
    work_dir = out_dir / ".work"  # temp dir for downloads we will convert and discard
    md_dir.mkdir(parents=True, exist_ok=True)
    files_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    LOG.mkdir(parents=True, exist_ok=True)

    state_path = LOG / f"gdrive-{slug}.files.txt"
    err_path = LOG / f"gdrive-{slug}.errors.log"
    index_path = out_dir / "_index.ndjson"

    processed: set[str] = set()
    if state_path.exists():
        processed = {line.strip() for line in state_path.read_text().splitlines() if line.strip()}
        print(f"[{account}] resuming: {len(processed)} files already processed", flush=True)

    files = enumerate_files(account)
    with index_path.open("w") as fh:
        for f in files:
            fh.write(json.dumps(f, ensure_ascii=False) + "\n")
    print(f"[{account}] index written: {len(files)} files", flush=True)

    state_fh = state_path.open("a")
    err_fh = err_path.open("a")
    counts: dict[str, int] = {}

    def bump(k: str) -> None:
        counts[k] = counts.get(k, 0) + 1

    try:
        for i, f in enumerate(files, 1):
            fid = f.get("id")
            if not fid or fid in processed:
                continue
            decision = classify(f)

            try:
                if decision == "skip":
                    bump("skip")

                elif decision == "native_doc":
                    out = md_dir / filename(f, "md")
                    gog_download(account, fid, out, export_format="md")
                    if out.exists():
                        out.write_text(scrub_markdown(out.read_text(errors="replace")))
                    bump("native_doc")

                elif decision == "native_sheet":
                    out = md_dir / filename(f, "csv")
                    gog_download(account, fid, out, export_format="csv")
                    bump("native_sheet")

                elif decision == "native_slides":
                    pptx_tmp = work_dir / f"{fid}.pptx"
                    out = md_dir / filename(f, "md")
                    gog_download(account, fid, pptx_tmp, export_format="pptx")
                    run_pptx2md(pptx_tmp, out)
                    if out.exists():
                        out.write_text(scrub_markdown(out.read_text(errors="replace")))
                    pptx_tmp.unlink(missing_ok=True)
                    bump("native_slides")

                elif decision == "pdf":
                    src = work_dir / f"{fid}.pdf"
                    out = md_dir / filename(f, "md")
                    gog_download(account, fid, src)
                    md_text = convert_pdf(src)
                    write_md(out, md_text)
                    src.unlink(missing_ok=True)
                    bump("pdf")

                elif decision == "docx":
                    src = work_dir / f"{fid}.docx"
                    out = md_dir / filename(f, "md")
                    gog_download(account, fid, src)
                    md_text = run_pandoc(src)
                    write_md(out, md_text)
                    src.unlink(missing_ok=True)
                    bump("docx")

                elif decision == "pptx":
                    src = work_dir / f"{fid}.pptx"
                    out = md_dir / filename(f, "md")
                    gog_download(account, fid, src)
                    run_pptx2md(src, out)
                    if out.exists():
                        out.write_text(scrub_markdown(out.read_text(errors="replace")))
                    src.unlink(missing_ok=True)
                    bump("pptx")

                elif decision == "xlsx":
                    src = work_dir / f"{fid}.xlsx"
                    out = md_dir / filename(f, "md")
                    gog_download(account, fid, src)
                    run_markitdown(src, out)
                    if out.exists():
                        out.write_text(scrub_markdown(out.read_text(errors="replace")))
                    src.unlink(missing_ok=True)
                    bump("xlsx")

                elif decision == "markitdown":
                    ext = safe_ext(f, "bin")
                    src = work_dir / f"{fid}.{ext}"
                    out = md_dir / filename(f, "md")
                    gog_download(account, fid, src)
                    run_markitdown(src, out)
                    if out.exists():
                        out.write_text(scrub_markdown(out.read_text(errors="replace")))
                    src.unlink(missing_ok=True)
                    bump("markitdown")

                elif decision == "plaintext":
                    ext = safe_ext(f, "txt")
                    out = files_dir / filename(f, ext)
                    gog_download(account, fid, out)
                    bump("plaintext")

            except subprocess.CalledProcessError as e:
                err_fh.write(f"{fid}\t{decision} failed: {(e.stderr or '').strip()[:300]}\n")
                err_fh.flush()
                bump("fail")
            except subprocess.TimeoutExpired:
                err_fh.write(f"{fid}\t{decision} timed out\n")
                err_fh.flush()
                bump("fail")
            except Exception as e:
                err_fh.write(f"{fid}\t{decision} error: {str(e)[:300]}\n")
                err_fh.flush()
                bump("fail")

            state_fh.write(fid + "\n")
            state_fh.flush()
            if i % 25 == 0:
                print(f"[{account}]   {i}/{len(files)}  {counts}", flush=True)
            time.sleep(PACE_SEC)
    finally:
        state_fh.close()
        err_fh.close()
        # Best-effort cleanup of work dir.
        try:
            for p in work_dir.iterdir():
                p.unlink(missing_ok=True)
            work_dir.rmdir()
        except OSError:
            pass

    print(f"[{account}] done. {counts}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
ask.py — query the library via graphify.

Usage:
    ask.py "what does the literature say about habit formation?"
    ask.py --book atomic-habits-clear "what is the 4-step model?"
    ask.py --status        # list books and their state

Behavior:
    - Default mode: shells out to `graphify query` (cross-resource synthesis).
    - --book mode: hint that the question is scoped to one book (graphify still
      searches the whole corpus, but we prepend the book context to the query).
    - --status: walks raw/library/books/ and prints each slug + status from
      summary.md frontmatter.

This is intentionally thin. Graphify already does the heavy lifting; we just
route the call from inside the workspace.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
RAW_BOOKS = REPO_ROOT / "raw" / "library" / "books"


def list_status() -> int:
    if not RAW_BOOKS.exists():
        print("(no books yet)")
        return 0
    rows = []
    for d in sorted(RAW_BOOKS.iterdir()):
        if not d.is_dir():
            continue
        summary = d / "summary.md"
        status = "?"
        title = d.name
        added = ""
        if summary.exists():
            text = summary.read_text(encoding="utf-8", errors="replace")
            m = re.search(r"^status:\s*(\S+)", text, re.MULTILINE)
            if m:
                status = m.group(1)
            t = re.search(r'^title:\s*"?([^"\n]+)"?', text, re.MULTILINE)
            if t:
                title = t.group(1).strip()
            a = re.search(r"^added_at:\s*(\S+)", text, re.MULTILINE)
            if a:
                added = a.group(1)
        rows.append((d.name, status, added, title))
    width = max((len(r[0]) for r in rows), default=10)
    for slug, status, added, title in rows:
        print(f"{slug:<{width}}  {status:<10}  {added:<25}  {title}")
    return 0


def ask(query: str, book_slug: str | None) -> int:
    if book_slug:
        scoped = f"in the context of {book_slug}: {query}"
    else:
        scoped = query
    cmd = ["graphify", "query", scoped]
    print(f"[ask] {' '.join(cmd)}", file=sys.stderr)
    try:
        r = subprocess.run(cmd, cwd=str(REPO_ROOT))
        return r.returncode
    except FileNotFoundError:
        print("graphify CLI not found in PATH", file=sys.stderr)
        return 127


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="?", help="natural-language question")
    ap.add_argument("--book", default=None, help="scope the question to one book slug")
    ap.add_argument("--status", action="store_true", help="list books + status")
    args = ap.parse_args()

    if args.status:
        return list_status()
    if not args.query:
        ap.print_help()
        return 1
    return ask(args.query, args.book)


if __name__ == "__main__":
    sys.exit(main())

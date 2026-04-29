#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests>=2.31",
#     "beautifulsoup4>=4.12",
#     "pymupdf>=1.24",
# ]
# ///
"""
add_book.py — search LibGen, score, download, parse, draft summary.

Usage:
    add_book.py "Atomic Habits"
    add_book.py "Atomic Habits" --md5 abc123def456...
    add_book.py "Atomic Habits" --author "James Clear"
    add_book.py "Atomic Habits" --dry-run    # show top picks, don't download

Behavior:
    1. Searches LibGen mirrors (libgen.is -> libgen.rs -> libgen.li).
    2. Scores results by extension (epub > pdf), realistic page count, recency.
    3. Warns if a similar slug already exists in raw/library/books/.
    4. Downloads via library.lol mirror.
    5. Parses EPUB via pandoc, PDF via pymupdf.
    6. Writes raw/library/books/<slug>/{source.<ext>, content.md, summary.md}.
    7. Prints slug + content path so Claude can write the summary body.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin, quote

import requests
from bs4 import BeautifulSoup

REPO_ROOT = Path(__file__).resolve().parents[3]
RAW_BOOKS = REPO_ROOT / "raw" / "library" / "books"
FIXTURES = Path(__file__).resolve().parent.parent / ".dev-fixtures"
MIRRORS = ["libgen.is", "libgen.rs", "libgen.li"]
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/123.0.0.0 Safari/537.36"
)
TIMEOUT = 25
FIXTURE_TTL_SECONDS = 24 * 3600


@dataclass
class Hit:
    md5: str
    title: str
    authors: list[str]
    year: Optional[int]
    pages: Optional[int]
    language: str
    extension: str
    size_bytes: Optional[int]
    publisher: str
    mirror_urls: list[str]

    @property
    def score(self) -> int:
        s = 0
        if self.extension == "epub":
            s += 10
        if self.pages and 150 <= self.pages <= 800:
            s += 5
        elif self.pages and self.pages > 0:
            s -= 2
        if self.year and self.year >= 2000:
            s += min(self.year - 2000, 25) // 5
        if self.language.lower() in ("english", "en"):
            s += 3
        return s


def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    return s


def fixture_path(url: str) -> Path:
    h = hashlib.sha1(url.encode()).hexdigest()[:12]
    return FIXTURES / f"{h}.html"


def fetch_cached(s: requests.Session, url: str, force: bool = False) -> str:
    """Cache HTML to .dev-fixtures/. Use during dev to avoid burning the IP."""
    p = fixture_path(url)
    if not force and p.exists():
        age = time.time() - p.stat().st_mtime
        if age < FIXTURE_TTL_SECONDS:
            return p.read_text(encoding="utf-8", errors="replace")
    r = s.get(url, timeout=TIMEOUT)
    r.raise_for_status()
    FIXTURES.mkdir(parents=True, exist_ok=True)
    p.write_text(r.text, encoding="utf-8")
    return r.text


def search_libgen(s: requests.Session, query: str, author: Optional[str]) -> list[Hit]:
    full_query = f"{query} {author}".strip() if author else query
    encoded = quote(full_query)
    last_err: Optional[Exception] = None
    for host in MIRRORS:
        url = f"https://{host}/search.php?req={encoded}&res=25&view=simple&column=def"
        try:
            html = fetch_cached(s, url)
            hits = parse_libgen_results(html, base=f"https://{host}")
            if hits:
                return hits
        except Exception as e:
            last_err = e
            print(f"[libgen] {host} failed: {e}", file=sys.stderr)
            continue
    if last_err:
        raise SystemExit(f"all libgen mirrors failed: {last_err}")
    return []


def parse_libgen_results(html: str, base: str) -> list[Hit]:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", class_="c") or soup.find("table", {"rules": "rows"})
    if not table:
        return []
    rows = table.find_all("tr")[1:]
    hits: list[Hit] = []
    for row in rows:
        cols = row.find_all("td")
        if len(cols) < 9:
            continue
        try:
            authors = [a.get_text(strip=True) for a in cols[1].find_all("a") or [cols[1]]]
            authors = [a for a in authors if a]
            title_cell = cols[2]
            title_link = title_cell.find("a")
            title = title_link.get_text(" ", strip=True) if title_link else title_cell.get_text(" ", strip=True)
            title = re.sub(r"\s+", " ", title).strip()
            md5 = ""
            if title_link and title_link.get("href"):
                m = re.search(r"md5=([a-fA-F0-9]{32})", title_link["href"])
                if m:
                    md5 = m.group(1).lower()
            publisher = cols[3].get_text(strip=True)
            year_txt = cols[4].get_text(strip=True)
            year = int(year_txt) if year_txt.isdigit() else None
            pages_txt = cols[5].get_text(strip=True).split("/")[0].strip()
            pages = int(pages_txt) if pages_txt.isdigit() else None
            language = cols[6].get_text(strip=True)
            size_txt = cols[7].get_text(strip=True).lower()
            size_bytes = parse_size(size_txt)
            extension = cols[8].get_text(strip=True).lower()
            mirror_urls = []
            for cell in cols[9:11] if len(cols) > 10 else cols[9:10]:
                a = cell.find("a")
                if a and a.get("href"):
                    mirror_urls.append(urljoin(base, a["href"]))
            if not md5 or not title:
                continue
            hits.append(Hit(
                md5=md5, title=title, authors=authors, year=year, pages=pages,
                language=language, extension=extension, size_bytes=size_bytes,
                publisher=publisher, mirror_urls=mirror_urls,
            ))
        except Exception:
            continue
    return hits


def parse_size(s: str) -> Optional[int]:
    m = re.match(r"([\d.]+)\s*(b|kb|mb|gb)?", s)
    if not m:
        return None
    n = float(m.group(1))
    unit = (m.group(2) or "b").lower()
    mult = {"b": 1, "kb": 1024, "mb": 1024**2, "gb": 1024**3}[unit]
    return int(n * mult)


def filter_hits(hits: list[Hit]) -> list[Hit]:
    out = [
        h for h in hits
        if h.extension in ("epub", "pdf")
        and h.language.lower() in ("english", "en")
    ]
    out.sort(key=lambda h: (-h.score, h.size_bytes or 10**12))
    return out


def slugify(title: str, author_lastname: str) -> str:
    title = re.sub(r"[^\w\s-]", "", title.lower())
    title = re.sub(r"[\s_]+", "-", title).strip("-")
    title = re.sub(r"-+", "-", title)
    if author_lastname:
        last = re.sub(r"[^\w]", "", author_lastname.lower())
        return f"{title}-{last}" if last else title
    return title


def author_lastname(authors: list[str]) -> str:
    if not authors:
        return ""
    first = authors[0]
    parts = first.replace(",", " ").split()
    return parts[-1] if parts else ""


def existing_slugs() -> list[str]:
    if not RAW_BOOKS.exists():
        return []
    return sorted(p.name for p in RAW_BOOKS.iterdir() if p.is_dir())


def fuzzy_dedup_warn(slug: str, existing: list[str]) -> Optional[str]:
    """Return a similar existing slug if found, else None."""
    title_part = slug.rsplit("-", 1)[0]
    for ex in existing:
        ex_title = ex.rsplit("-", 1)[0]
        if title_part == ex_title or title_part in ex_title or ex_title in title_part:
            return ex
    return None


def download(s: requests.Session, hit: Hit, dest: Path) -> None:
    """Resolve library.lol or libgen mirror -> direct file URL -> download."""
    last_err = None
    for mirror_url in hit.mirror_urls + [
        f"http://library.lol/main/{hit.md5}",
        f"http://libgen.li/ads.php?md5={hit.md5}",
    ]:
        try:
            r = s.get(mirror_url, timeout=TIMEOUT, allow_redirects=True)
            r.raise_for_status()
            soup = BeautifulSoup(r.text, "html.parser")
            direct = None
            h2 = soup.find("h2")
            if h2 and h2.find("a"):
                direct = h2.find("a")["href"]
            if not direct:
                for a in soup.find_all("a"):
                    href = a.get("href", "")
                    if "get.php" in href or href.endswith(f".{hit.extension}"):
                        direct = urljoin(mirror_url, href)
                        break
            if not direct:
                continue
            print(f"[download] {direct}", file=sys.stderr)
            with s.get(direct, stream=True, timeout=TIMEOUT * 4) as resp:
                resp.raise_for_status()
                dest.parent.mkdir(parents=True, exist_ok=True)
                with open(dest, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=64 * 1024):
                        if chunk:
                            f.write(chunk)
            return
        except Exception as e:
            last_err = e
            print(f"[download] mirror {mirror_url} failed: {e}", file=sys.stderr)
            continue
    raise SystemExit(f"all download mirrors failed: {last_err}")


def epub_to_md(src: Path, dest: Path) -> None:
    subprocess.run(
        ["pandoc", "-f", "epub", "-t", "gfm-raw_html", str(src), "-o", str(dest)],
        check=True,
    )


def pdf_to_md(src: Path, dest: Path) -> None:
    import fitz  # pymupdf
    doc = fitz.open(str(src))
    parts = []
    for page in doc:
        parts.append(page.get_text("text"))
    doc.close()
    dest.write_text("\n\n".join(parts), encoding="utf-8")


def write_summary_stub(book_dir: Path, hit: Hit, slug: str) -> Path:
    p = book_dir / "summary.md"
    fm = {
        "slug": slug,
        "title": hit.title,
        "authors": hit.authors,
        "year": hit.year,
        "language": hit.language,
        "pages": hit.pages,
        "extension": hit.extension,
        "libgen_md5": hit.md5,
        "status": "reading",
        "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "summary_at": None,
        "tags": [],
        "commentary": [],
    }
    fm_yaml = "---\n" + "\n".join(yaml_line(k, v) for k, v in fm.items()) + "\n---\n\n"
    body = (
        "## Big Idea\n_(claude: fill in)_\n\n"
        "## Key Concepts\n- _(claude: fill in)_\n\n"
        "## Memorable Quotes\n> _(claude: fill in)_\n\n"
        "## Action Items\n- _(claude: fill in)_\n\n"
        "## Critiques\n- _(claude: fill in)_\n"
    )
    p.write_text(fm_yaml + body, encoding="utf-8")
    return p


def yaml_line(k: str, v) -> str:
    if v is None:
        return f"{k}: null"
    if isinstance(v, bool):
        return f"{k}: {'true' if v else 'false'}"
    if isinstance(v, (int, float)):
        return f"{k}: {v}"
    if isinstance(v, list):
        if not v:
            return f"{k}: []"
        items = ", ".join(json.dumps(x, ensure_ascii=False) for x in v)
        return f"{k}: [{items}]"
    return f"{k}: {json.dumps(v, ensure_ascii=False)}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("query", help="book title (and optionally author)")
    ap.add_argument("--author", default=None)
    ap.add_argument("--md5", default=None, help="skip search; use this libgen md5 directly")
    ap.add_argument("--dry-run", action="store_true", help="show top picks, no download")
    ap.add_argument("--force", action="store_true", help="proceed even if a similar slug exists")
    args = ap.parse_args()

    s = session()

    if args.md5:
        hit = Hit(
            md5=args.md5.lower(), title=args.query, authors=[args.author or "unknown"],
            year=None, pages=None, language="en", extension="epub", size_bytes=None,
            publisher="", mirror_urls=[],
        )
        candidates = [hit]
    else:
        hits = search_libgen(s, args.query, args.author)
        candidates = filter_hits(hits)
        if not candidates:
            print(f"no usable libgen results for: {args.query}", file=sys.stderr)
            return 1

    top = candidates[:5]
    print("[top candidates]", file=sys.stderr)
    for i, h in enumerate(top):
        print(
            f"  {i+1}. score={h.score} ext={h.extension} pages={h.pages} year={h.year} "
            f"size={h.size_bytes} title={h.title!r} authors={h.authors}",
            file=sys.stderr,
        )

    if args.dry_run:
        print(json.dumps([asdict(h) for h in top], indent=2, default=str))
        return 0

    pick = top[0]
    last = author_lastname(pick.authors)
    slug = slugify(pick.title, last)
    if not slug:
        print("could not derive slug", file=sys.stderr)
        return 1

    if not args.force:
        dup = fuzzy_dedup_warn(slug, existing_slugs())
        if dup:
            print(
                f"WARN: '{slug}' looks similar to existing '{dup}'. "
                f"Re-run with --force to proceed, or pick a different result with --md5.",
                file=sys.stderr,
            )
            return 2

    book_dir = RAW_BOOKS / slug
    book_dir.mkdir(parents=True, exist_ok=True)
    src = book_dir / f"source.{pick.extension}"
    if not src.exists() or src.stat().st_size == 0:
        download(s, pick, src)

    content = book_dir / "content.md"
    if pick.extension == "epub":
        epub_to_md(src, content)
    elif pick.extension == "pdf":
        pdf_to_md(src, content)
    else:
        print(f"unsupported extension: {pick.extension}", file=sys.stderr)
        return 1

    summary = write_summary_stub(book_dir, pick, slug)

    print(json.dumps({
        "slug": slug,
        "title": pick.title,
        "authors": pick.authors,
        "book_dir": str(book_dir.relative_to(REPO_ROOT)),
        "content_path": str(content.relative_to(REPO_ROOT)),
        "summary_path": str(summary.relative_to(REPO_ROOT)),
        "next": "claude: read content.md, write the summary body in summary.md, then set status=done and summary_at=<now>",
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

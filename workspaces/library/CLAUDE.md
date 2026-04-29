# library

Personal learning corpus. Books (and later videos, papers) get pulled, parsed, and dropped into `raw/library/` so Graphify can ingest them and answer cross-resource questions like "what does the lit say about habit formation."

No NotebookLM. Full text + summary live as markdown on disk; the existing Graphify auto-stack handles ingest, clustering, and the wiki layer.

## Scope (v1)

**Books only.** Video and paper pipelines are designed-for but not built. They land here when wired, not before (see root CLAUDE.md "no empty scaffolds" learning).

## Triggers

| Keyword | Action |
|---------|--------|
| `add <title>` | Search LibGen, score, download, parse, draft summary frontmatter. Then Claude writes the summary body. |
| `add <title> --md5 <hash>` | Skip search; download a specific LibGen entry by md5 (use when auto-pick is wrong). |
| `status` | List every book's slug + status + add date |
| `ask "<question>"` | Thin wrapper around `graphify query`, scoped (best-effort) to library content |
| `archive <slug>` | Mark as archived (manual frontmatter edit; no script needed for v1) |

## Layout

```
workspaces/library/
├── CLAUDE.md              (this file)
├── scripts/
│   ├── add_book.py        # libgen search + score + download + pandoc + summary stub
│   └── ask.py             # graphify query wrapper

raw/library/
└── books/<slug>/
    ├── source.epub        # gitignored; copyrighted, never committed
    ├── content.md         # gitignored; full parsed text, fed to Graphify locally
    └── summary.md         # gitignored; 1-page summary, fed to Graphify locally
```

`raw/*/*` is gitignored repo-wide. Graphify still ingests from disk.

## Schema

`summary.md` frontmatter:

```yaml
---
slug: atomic-habits-clear
title: "Atomic Habits"
authors: ["James Clear"]
year: 2018
language: en
pages: 320
extension: epub
libgen_md5: "abc123..."
status: reading       # queued | reading | done | archived
added_at: 2026-04-29T12:00:00
summary_at: null      # set when Claude writes the body
tags: []
commentary: []        # array of {url, transcript_path}
---

## Big Idea
(1-2 sentences)

## Key Concepts
- ...

## Memorable Quotes
> ...

## Action Items
- ...

## Critiques
- (limitations / pushback / where it falls short)
```

The template is loosely enforced. Claude can adapt for genre (fiction won't have "action items"; technical books may add a "prerequisites" section).

## Slug rule

`<title-kebab>-<first-author-lastname-kebab>`

- "Atomic Habits" by James Clear → `atomic-habits-clear`
- "Thinking, Fast and Slow" by Daniel Kahneman → `thinking-fast-and-slow-kahneman`
- ASCII-only, lowercase, hyphens, no punctuation
- If a similar slug already exists, `add_book.py` warns and asks for confirmation before proceeding (stdout warning, exit code 2)

## How `add_book.py` works

1. Search LibGen mirrors in order: `libgen.is` → `libgen.rs` → `libgen.li`. First mirror that responds wins.
2. Filter results: `language == en`, `extension in {epub, pdf}`.
3. Score each result:
   - +10 if extension is epub (vs pdf)
   - +5 if pages in [150, 800] (filter unreasonable values)
   - +2 per recent year vs oldest match
4. Pick highest-scored entry. Tie → smaller file size (cleaner OCR usually).
5. Download via the entry's library.lol mirror page.
6. Run `pandoc -f epub -t markdown <file> -o content.md` (or `pdftotext` for PDF).
7. Write `summary.md` with frontmatter only, `status: reading`.
8. Print to stdout: slug, content.md path, "claude: now write the summary".

Claude then reads `content.md`, writes the summary body into `summary.md`, sets `status: done` and `summary_at`.

## Scraper discipline (per global learning)

- HTML responses cached to `workspaces/library/.dev-fixtures/<sha1>.html`.
- During dev, hit LibGen ≤5 times per session. Iterate parsing on cached fixtures.
- One impersonation profile, no rotation probes.
- `.dev-fixtures/` is gitignored.

## Cross-workspace edges

- `tags[]` shared across books → topical clusters in Graphify
- Book mentions in `raw/journal/...` via `[[<slug>]]` wikilinks → manual cross-references
- Future: `commentary[].transcript_path` will create video-to-book edges

## Planned (not built yet)

- `add_video.py`: `yt-dlp` transcript → `raw/library/videos/<slug>/transcript.md` + summary
- `add_paper.py`: PDF → `raw/library/papers/<slug>/content.md` + summary
- Both follow the same shape; add when first needed, not before.

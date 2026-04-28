---
name: firecrawl
description: Extract clean markdown from a single URL via the Firecrawl REST API as a CLI (no MCP). Use when the user pastes a URL and wants the contents read, summarized, or saved. Pairs with brave-search for full research flows.
---

# firecrawl

Thin curl wrapper around Firecrawl's `/v1/scrape` endpoint. Lives as a shell script so there's zero per-session context cost; only this SKILL.md loads when a trigger fires.

## When this fires

Trigger phrases (semantic, non-exhaustive): "scrape this URL", "read this page", "extract the contents of <url>", "what does <url> say", "save this article", "pull the markdown from <url>", "ingest this link".

Do NOT fire for:
- YouTube URLs — use the `youtube-summary` skill (transcript, not page scrape).
- Instagram URLs — use the `instagram-summary` skill.
- Plain `.md` files — fetch directly, no scraping needed.
- Full-site crawls — Firecrawl `/crawl` is expensive; confirm scope with Adithya first and don't auto-fire from this skill.

## Auth

Key lives in `.claude/settings.local.json` under `env.FIRECRAWL_API_KEY`. Claude Code injects it into the shell, so the script just reads `$FIRECRAWL_API_KEY`. If the var is unset, the script exits with a clear message — surface it back to Adithya rather than guessing or rotating.

## Procedure

1. **Vet the URL.** Skip paywalled, login-gated, or clearly private content — Firecrawl will burn quota for nothing. If unclear, ask Adithya before spending the call.
2. **Run the scrape.** From repo root:
   ```bash
   _core/skills/firecrawl/scrape.sh "<url>" [format]
   ```
   - `format`: defaults to `markdown`. Other options: `html`, `rawHtml`, `links`, `screenshot`.
3. **Read the JSON.** Output is `{url, title, description, markdown}`.
4. **Summarize first, paste second.** Lead with a 2-4 sentence synthesis. Only paste the full markdown if Adithya asks, or if saving an artifact.
5. **Output is ephemeral by default.** Do NOT auto-save scrapes to `raw/library/` — that folder feeds the personal knowledge graph and random pages will pollute it. Two buckets:
   - **Default (no save needed):** stream the JSON to stdout, summarize, done. Most one-off "what does this say" reads stop here.
   - **Ephemeral save (research runs):** if a downstream skill (e.g. `web-research`) needs the raw markdown on disk, write to `~/.quantum/skill-output/firecrawl/<YYYY-MM-DD-HHMMSS>-<slug>.md`. This path is OUTSIDE the repo and graphify-ignored.
   - **Promote to library (explicit only):** ONLY on Adithya saying "save this", "add to my library", "keep this", "ingest this" — write to `raw/library/YYYY-MM-DD-<slug>.md` with frontmatter (`url`, `title`, `captured_at`, `intent`, `relevance`, `source_type`). Promotion always requires explicit user intent. If the ephemeral file already exists, promote it (don't re-scrape).

## Examples

```bash
# Standard read
_core/skills/firecrawl/scrape.sh "https://example.com/post"

# Just the outbound links
_core/skills/firecrawl/scrape.sh "https://example.com/index" links
```

## Budget

- Default cap: 10 scrapes per task. Confirm before going higher.
- Each scrape costs Firecrawl credits — don't loop blindly. If a page returns garbage, switch format or stop, don't retry.

## Dev best practices

When iterating on scripts that consume firecrawl output (parsing the JSON, building downstream pipelines), cache the first response to disk and develop against the fixture. Each live call costs credits, and reviewer-driven fix loops stack fast. Full pattern in `raw/learnings/2026-04-28-cache-html-during-scraper-dev.md`. Hard cap during dev: ~5 live calls per session per URL shape; if you want a 6th, ask whether the cached response already answers it.

## Notes

- API endpoint: `https://api.firecrawl.dev/v1/scrape`.
- Auth header is `Authorization: Bearer ...`.

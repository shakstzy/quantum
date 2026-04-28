---
name: brave-search
description: Web search via the Brave Search API as a CLI (no MCP). Use when the user wants to search the web, look something up, find sources, or check recent info. Pairs naturally with the firecrawl skill — Brave returns candidate URLs, firecrawl extracts the page contents.
---

# brave-search

Thin curl wrapper around Brave's public Web Search API. Lives as a shell script so there's zero per-session context cost; only this SKILL.md loads when a trigger fires.

## When this fires

Trigger phrases (semantic, non-exhaustive): "search the web for X", "look up X", "google X", "find sources on X", "what's the latest on X", "recent news about X", "is X still recommended", "find the docs for X".

Do NOT fire for:
- Questions answerable from loaded context — answer from context first.
- Knowledge-graph questions about Adithya's life — `/graphify query` first (see root `CLAUDE.md`).
- Single-URL extraction — go straight to the `firecrawl` skill.

## Auth

Key lives in `.claude/settings.local.json` under `env.BRAVE_API_KEY`. Claude Code injects it into the shell, so the script just reads `$BRAVE_API_KEY`. If the var is unset, the script exits with a clear message — surface it back to Adithya rather than guessing or rotating.

## Procedure

1. **Frame the query.** Pick 1-3 query variants if the topic has multiple angles. Don't just echo Adithya's phrasing.
2. **Run the search.** From repo root:
   ```bash
   _core/skills/brave-search/search.sh "your query" [count] [freshness]
   ```
   - `count`: 1-20, default 10
   - `freshness`: `pd` (past day), `pw` (past week), `pm` (past month), `py` (past year). Omit for all-time.
3. **Read the JSON.** Output is `{query, results: [{title, url, description, age, extra_snippets}, ...]}`.
4. **Rank and shortlist.** Dedupe by hostname. Score on domain authority, topical fit, recency. Present 5-7 candidates with title + hostname + one-line rationale.
5. **Hand off.** If Adithya wants page contents, call the `firecrawl` skill on the chosen URLs.

## Examples

```bash
# Generic lookup
_core/skills/brave-search/search.sh "claude opus 4.7 release notes"

# Recent news only
_core/skills/brave-search/search.sh "openai sora 2 reception" 10 pw

# Quick top-3
_core/skills/brave-search/search.sh "rust async runtime comparison 2026" 5
```

## Budget

- Default cap: 3 search queries per task. Confirm before going higher.
- Free tier is rate-limited — if a 429 comes back, back off, don't retry-storm.

## Notes

- The API endpoint is `https://api.search.brave.com/res/v1/web/search`.
- The header is `X-Subscription-Token`, not a bearer token.
- For source-quality control patterns (goggles, scrape policy), the same rules from SHAKOS `system/_core/playbooks/web-research/rules/` apply — copy them in if you start running multi-source research from QUANTUM.

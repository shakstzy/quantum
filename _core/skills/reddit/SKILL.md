---
name: reddit
description: Read Reddit (search, listings, posts + comments, users) via a tiny stdlib Python CLI that returns terse markdown. Built specifically to avoid context bloat from raw old.reddit.com HTML or full JSON dumps.
---

# reddit

Single-file Python script. Stdlib only, no PRAW, no auth. Hits Reddit's public `*.json` endpoints (read-only). Default output is compact markdown; `--json` returns cleaned structured data.

## When this fires

Trigger phrases (semantic, non-exhaustive): "what's on r/X", "search reddit for X", "top posts in r/X this week", "what does r/X say about Y", "summarize this reddit thread", "find reddit threads about X", "what's u/X been posting", any `reddit.com/r/.../comments/...` URL.

Do NOT fire for:
- Posting/voting/replying — read-only, no write support.
- Private/quarantined subs — public API returns 403 without OAuth.
- Bulk media downloads — use `bdfr` if that ever gets installed.

## Auth

None. Public JSON endpoints. Reddit rate-limits unauth'd reads to ~10 req/min per IP — back off on 429 (script auto-retries twice with exponential backoff, then surfaces).

## Procedure

Invoke the script directly (works from any cwd):

```bash
/Users/shakstzy/QUANTUM/_core/skills/reddit/reddit.py <subcommand> [args]
```

Subcommands:

```bash
# Search (cross-sub or scoped)
reddit.py search "<query>" [--sub SUB] [--limit N=10] \
  [--time hour|day|week|month|year|all] [--sort relevance|hot|top|new|comments]

# Listings
reddit.py hot <subreddit> [--limit N=10]
reddit.py new <subreddit> [--limit N=10]
reddit.py top <subreddit> [--time hour|day|week|month|year|all=day] [--limit N=10]

# Single post + comment thread
reddit.py post <id|url> [--top N=10] [--depth D=2]
#   id can be a bare ID (1sxmg6z), a full URL, or /r/.../comments/ID/...

# User activity
reddit.py user <username> [--kind submitted|comments] [--limit N=10]
```

Global flags (work before OR after the subcommand):
- `--json` — raw cleaned JSON instead of markdown
- `--ua "<string>"` — override User-Agent (default fine for read-only)

## Output shape

Markdown (default): post header line `r/sub · u/author · score↑ · Nc · age · [flair]`, then `id` + permalink, then external link if any, then a 400-char selftext snippet. Comments are nested with `**u/author** (score↑): body` indented by depth.

JSON: array of post dicts (or `{post, comments}` for the post subcommand). All raw_json=1 (HTML entities decoded).

## Examples

```bash
# What's hot in r/LocalLLaMA right now
/Users/shakstzy/QUANTUM/_core/skills/reddit/reddit.py hot LocalLLaMA --limit 5

# Recent discussion of a topic
/Users/shakstzy/QUANTUM/_core/skills/reddit/reddit.py search "claude opus 4.7" --time week --limit 10

# Read a thread someone shared
/Users/shakstzy/QUANTUM/_core/skills/reddit/reddit.py post "https://www.reddit.com/r/Python/comments/1sxmg6z/" --top 15 --depth 2

# Quick scan of one user
/Users/shakstzy/QUANTUM/_core/skills/reddit/reddit.py user spez --kind submitted --limit 5
```

## Budget

- Default cap: 5 calls per task. Each call = one Reddit listing or thread. Confirm before going higher.
- Reddit unauth limit is roughly 10 req/min — at 5 calls/task there's headroom, but loops over many subs hit the cap fast. Don't fan out without asking.
- For deep comment trees, prefer increasing `--depth` over re-calling — one fetch with `--depth 4` is cheaper than 4 nested fetches.

## Notes

- API base: `https://www.reddit.com<path>.json`. Reddit's old API is the JSON one; new Reddit redirects work too.
- "[deleted]" / "[removed]" comments are filtered out of markdown output.
- "more comments" placeholders are skipped — to expand them you'd need OAuth + the morechildren endpoint, out of scope.
- Quarantined subs return 403; locked threads still readable. NSFW subs work but content not filtered.
- Pairs naturally with `firecrawl` for external links cited in threads.

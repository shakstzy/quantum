# QUANTUM

Adithya's personal life-OS. Single operator. Private repo.

Each life domain has its own ICM workspace under `workspaces/`. Each workspace pulls data from an external source (cron or manual) and deposits raw artifacts into `raw/<workspace>/`. Graphify reads `raw/` and maintains a knowledge graph at `graphify-out/`. When future Claude windows answer questions about Adithya's life, they query the graph first, then drill into raw if needed.

## Folder Map

```
QUANTUM/
├── CLAUDE.md                    (you are here, Layer 0)
├── README.md
├── .graphifyignore              (graphify-managed, do not hand-edit)
├── .claude/settings.json        (graphify hook, do not hand-edit)
├── _core/                       (ICM conventions and templates, source of truth)
│   ├── CONVENTIONS.md
│   ├── placeholder-syntax.md
│   ├── templates/               (workspace template; auto-applied via Pattern 17)
│   ├── playbooks/
│   │   └── icm-audit/           (read-only structural audit; runs every 15 min)
│   └── skills/                  (project-specific skills; stateless callables)
├── raw/                         (gitignored content; structure committed)
│   ├── slack/
│   ├── gdrive/
│   ├── email/
│   ├── imessage/
│   ├── calendar/
│   ├── journal/
│   ├── finance/
│   ├── health/
│   ├── people/
│   ├── library/
│   ├── tinder/                  (per-person markdown <first>-<source>-<city>.md)
│   ├── contacts/                (per-person markdown, macOS Contacts mirror)
│   └── learnings/               (Claude-written observations; auto-injected via hook)
├── graphify-out/                (committed; Graphify owns this, do not hand-edit)
├── workspaces/                  (one ICM workspace per life domain)
│   ├── slack/
│   ├── gdrive/
│   ├── email/
│   ├── imessage/
│   ├── calendar/
│   ├── journal/
│   ├── finance/
│   ├── health/
│   ├── people/
│   ├── library/
│   ├── tinder/                  (patchright bot, no api.gotinder.com)
│   └── contacts/                (macOS Contacts ingest via JXA, daily 4am cron)
└── scripts/                     (sync helpers; quantum-sync runs via launchd)
```

## Routing

| Task | Where to go |
|------|-------------|
| Work on a specific life domain | `workspaces/<name>/CLAUDE.md` |
| Look up an ICM rule | `_core/CONVENTIONS.md` |
| Look up placeholder syntax | `_core/placeholder-syntax.md` |
| Start a new workspace from template | `_core/templates/` |
| Query Adithya's accumulated knowledge | `/graphify query "..."` then read `graphify-out/GRAPH_REPORT.md` |

## Workspace Index

| Workspace | Source | Purpose |
|-----------|--------|---------|
| slack | Slack workspaces | Conversations, threads, decisions |
| gdrive | Google Drive | Documents, folders, shared files |
| email | Gmail | Inbox, sent, labeled threads |
| imessage | macOS Messages (iMessage MCP) | Personal conversations |
| calendar | Google Calendar | Events, meetings, recurring blocks |
| journal | Manual entries | Daily and weekly reflections |
| finance | Manual / banking exports | Accounts, transactions, decisions |
| health | Apple Health exports / manual | Workouts, vitals, habits |
| people | Manual / contacts | Friends, family, colleagues, network NOT in Apple Contacts (manual overlay) |
| library | Manual / browser captures | Books, articles, papers, watchlists |
| tinder | tinder.com via patchright (browser automation) | Swipes, matches, threads, outbound drafting + send. Ban-aversion is priority #1; see workspace CLAUDE.md for hard rules. |
| contacts | macOS Contacts via JXA / osascript | Daily 4am ingest. Per-entry markdown at `raw/contacts/<slug>.md`. Auto-classified `person` / `business` / `noise`. |

Each workspace is self-contained per ICM. Once you cd into a workspace, that workspace's CLAUDE.md takes operational precedence over this root file.

Generative tools that PRODUCE media (vs. ingest personal data) live under `_core/skills/` instead of `workspaces/`. See the Triggers table below for entry points.

## Triggers

| Keyword | Action |
|---------|--------|
| `setup` | Run onboarding questionnaire in current workspace. Auto-runs on workspace creation per CONVENTIONS Pattern 17. |
| `status` | Show pipeline state for current workspace |
| `pull` | Workspace fetches fresh data from its external source into `raw/<workspace>/` |
| `digest` | Roll up recent activity across all workspaces (default last 7 days) |
| `icm audit` / "run the icm audit" / "scan quantum for drift" | Read `_core/playbooks/icm-audit/PLAYBOOK.md`; run `python3 _core/playbooks/icm-audit/scripts/audit.py`. Auto-runs every 15 min via launchd `com.shakstzy.quantum-icm-audit`. Outputs at `~/.quantum/audit/latest/`. |
| "post to IG" / "publish this reel" / "drop this on TikTok" / "upload to YouTube" / "cross-post this" | Read `_core/skills/zernio-post/SKILL.md`. Cross-platform ORGANIC publish via Zernio direct REST. `PUBLISH` gate required. `ZERNIO_API_KEY` lives in `.claude/settings.local.json`. Do NOT use for ads  -  use `zernio-ads` instead. |
| "boost this post" / "promote this post" / "turn this into a paid ad" / "launch an ad on (Meta\|LinkedIn\|TikTok\|Pinterest\|X\|Google)" / "create a Click-to-WhatsApp ad" / "list my ad accounts" / "show my ad spend" / "ad analytics for X" / "show my campaign tree" / "pause this campaign" / "resume this campaign" / "cancel this ad" / "delete this campaign" / "duplicate this campaign" / "update my ad budget" / "connect my (Meta\|LinkedIn\|TikTok\|Pinterest\|X\|Google) ads" / "sync this customer list to a Meta audience" / "create a custom audience" / "create a lookalike audience" / "send this conversion to Meta" / "fire a CAPI event" / "log this purchase to Google Ads" | Read `_core/skills/zernio-ads/SKILL.md`. Paid ads across all six Zernio ad platforms (`metaads`, `googleads`, `linkedinads`, `tiktokads`, `pinterestads`, `xads`) via direct REST. Reads (ad accounts, analytics, tree, list audiences) are unrestricted. Every write path (boost, create, update budget, audience PII sync, conversion events, campaign delete) requires the `LAUNCH-AD` token gate (NOT `PUBLISH`). Same `ZERNIO_API_KEY` as `zernio-post`. Requires the Zernio Ads add-on enabled in billing; the skill surfaces the 403 if it is not. |
| "send slack" / "slack <name>" / "dm <name> on slack" / "post to #<channel>" / "read #<channel>" / "search slack for X" / "who is <name> on slack" | Read `_core/skills/slack/SKILL.md`. Send/read Slack as Adithya via xoxp user token. Token in macOS Keychain `service=quantum-slack`. |
| "text <name>" / "imessage <name>" / "send a text to <name>" / "look up <name> in my contacts" / "what did <name> last text me" / "pull my iMessage history with <name>" | Read `_core/skills/macos-contacts-imessage/SKILL.md`. Native macOS Contacts + iMessage/SMS/RCS via osascript and chat.db. No gate by default. |
| "search notion" / "find in notion" / "create notion page" / "append to notion page" / "query notion db" | Read `_core/skills/notion/SKILL.md`. Notion REST primitives (search, page-get, page-create, block-append, db-query). Token in macOS Keychain `service=quantum-notion`. |
| "dm <name> on discord" / "text <name> on discord" / "message <name> on discord" / "read my dms with <name>" / "search my discord for X" / "post in #<channel> on discord" / "read #<channel> on discord" / "who is <name> on discord" | Read `_core/skills/discord/SKILL.md`. Send/read Discord as Adithya via patchright-driven Chrome session. Cookies in `~/.quantum/chrome-profiles/discord/`. ToS-sensitive (self-bot surface); burner account recommended. |
| "humanize this" / "humanize the draft" / "rewrite in my voice" / "make this sound less AI" / "/humanizer" | Invoke the global Claude Code skill at `~/.claude/skills/humanizer/SKILL.md` (blader/humanizer v2.5.1, MIT). Manual invoke only  -  do not auto-fire. Use as a post-process on per-person message drafts (slack, imessage, discord, email) before the SEND gate, per the humanizer-messaging memory. For voice calibration, paste a 2-3 sentence sample of Adithya's prior writing inline; the skill locks onto it for that rewrite. |
| "ship this PR" / "open a PR" / "draft a PR" / "merge this PR" / "what PRs are open" / "comment on PR <N>" / "what's failing in CI" / "rerun the failed run" / "cut a release" / "create a gist" / "open an issue for X" | Use `gh` directly (no SKILL.md  -  Claude knows the CLI). Already authenticated as `shakstzy` (keyring; scopes: `gist`, `read:org`, `repo`, `workflow`). Pass PR/issue/release **bodies via HEREDOC** to preserve formatting. Visible writes (PR merge, release, cross-user comments, repo rename) require Adithya confirmation. If a verb 404s on a private repo, the cause is a missing scope  -  surface the ask, don't silently rotate. |
| "compress this video" / "shrink this mp4" / "convert to <format>" / "extract audio" / "trim this clip" / "make a gif" / "downscale to 720p / 1080p" / "make a thumbnail" / "concat these clips" / "normalize the audio" / "transcode for whatsapp / web" / "probe this file" | Use `ffmpeg` directly (no SKILL.md  -  Claude knows the CLI). Default mp4 preset: `-c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k`. Switch to `-c:v h264_videotoolbox` when speed beats size. Add `-movflags +faststart` for web/upload. Use `-c copy` for trim/container-only ops (no re-encode). Probe unfamiliar inputs with `ffprobe` first. **Never** use `-y` or write to the source path without explicit `CONFIRM`. |
| "higgsfield image" / "higgsfield video" / "nano banana" / "soul cinematic" / "seedance" / "kling 2.5" / "veo" / "wan" / "sora 2" / "marketing studio ad" / "cinema studio scene" / "make me an ad" / "generate a cinematic video" | Read `_core/skills/higgsfield/SKILL.md`. Drives higgsfield.ai (image / video / Marketing Studio / Cinema Studio) via patchright over a persistent Chrome profile at `~/.quantum/chrome-profiles/higgsfield/`. Outputs to `~/.quantum/skill-output/higgsfield/<run-id>/` (NEVER `raw/`). Cost-cap default 500 cr; cinema-video is 96 cr. Burner account recommended (ToS-sensitive). |
| paste a youtube.com/youtu.be URL with "summarize" / "tldr" / "recap" / "explain" / "takeaways" | Read `_core/skills/youtube-summary/SKILL.md`. Pulls the transcript via `youtube_transcript_api` and summarizes. Local-only, no auth. Save outputs to `raw/library/` if Adithya asks. |
| paste an instagram.com/p/ /reel/ /reels/ /tv/ URL with "summarize" / "tldr" / "explain" / "takeaways" | Read `_core/skills/instagram-summary/SKILL.md`. Posts get caption + visual analysis; reels also get a Whisper audio transcript. Multimodal synthesis is delegated to `_core/skills/local-llm/SKILL.md`. Save outputs to `raw/library/` if Adithya asks. |
| "ask gemma X" / "run this through gemma" / "describe this image with gemma" / "no cloud, use local" / "is gemma running" / "start gemma" / "stop gemma to free ram" / "restart gemma" | Read `_core/skills/local-llm/SKILL.md`. Persistent local Gemma 4 26B-A4B daemon at `127.0.0.1:8765` (managed by launchd `com.quantum.local-llm`, ~22GB resident). OpenAI-compatible chat/completions, vision-capable. Lifecycle scripts in `_core/skills/local-llm/scripts/`. |
| "search the web for X" / "look up X" / "google X" / "find sources on X" / "what's the latest on X" / "recent news about X" / "find the docs for X" | Read `_core/skills/brave-search/SKILL.md`. Brave Web Search via REST CLI (no MCP). Key in `.claude/settings.local.json` env (`BRAVE_API_KEY`). Pairs with the firecrawl skill for full research flows. |
| "scrape this URL" / "read this page" / "extract the contents of <url>" / "what does <url> say" / "save this article" / "pull the markdown from <url>" / "ingest this link" | Read `_core/skills/firecrawl/SKILL.md`. Firecrawl `/v1/scrape` via REST CLI (no MCP). Key in `.claude/settings.local.json` env (`FIRECRAWL_API_KEY`). Skip YouTube/Instagram URLs (use those skills instead). Full-site crawl is gated. |
| "find homes in <city>" / "houses for sale in <zip>" / "look up <address>" / "details on this listing" / "Zestimate for X" / "Redfin Estimate for X" / "price history for <address>" / "comps for <address>" / "tax history for <address>" / "school ratings for <address>" / paste a redfin.com or zillow.com URL with "look up" / "details" / "summarize" | Read `_core/skills/real-estate/SKILL.md`. Free CLI scraper for Redfin + Zillow via `curl_cffi` TLS impersonation (no Apify, no proxy). Region resolution piggybacks on the brave-search skill. Cap 20 req/task, throttle when looping. Personal use only. |
| "check my gmail" / "what's in my inbox" / "find <query> in my inbox" / "send email from <account>" / "reply to <sender>" / "what's on my calendar" / "schedule <event>" / "block <time>" / "search my drive for X" / "upload to drive" / "share <file>" / "what's in my drive folder <x>" | Read `_core/skills/google-workspace/SKILL.md`. Gmail/Calendar/Drive across 4 personal Gmail accounts via the `gog` CLI (steipete/gogcli, Homebrew). Every command requires `-a <email>`. Destructive ops (send, calendar create/modify/delete, drive delete, big upload, batch >5) require dry-run with `-n` and literal `CONFIRM` gate. |
| `/graphify raw/ --update` | Refresh the knowledge graph from new raw deposits |
| `/graphify query "..."` | Query the graph by question |
| `/graphify path "A" "B"` | Trace shortest path between two concepts |
| `/graphify explain "X"` | Show full neighborhood of one concept |

## Wiki Consultation Rules

Before answering any question about Adithya's life, projects, people, history, or recurring topics:

1. Run `/graphify query "<the question>"` first.
2. Read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure.
3. If the graph cites raw files, read those files directly to confirm.
4. If the graph has nothing useful, say so. Do not invent.

After a workspace deposits new files into `raw/<workspace>/`:

1. Files land at `raw/<workspace>/<slug>.<ext>` (per-entity workspaces like `tinder`, `people`) OR `raw/<workspace>/YYYY-MM-DD-<slug>.<ext>` (per-event workspaces like `journal`, `email`). The "Raw deposits MUST be graph-linkable" rules below apply to both shapes.
2. The next scheduled `/graphify raw/ --update` rebuilds the graph incrementally.
3. Workspaces never hand-edit `graphify-out/`. Graphify owns it.

## Memory vs Wiki vs Workspaces

Three separate stores. Do not conflate.

- **Memory** at `~/.claude/projects/-Users-shakstzy-QUANTUM/memory/`  -  Adithya's preferences, current state, ephemeral context. I (Claude) maintain it.
- **Graph** at `graphify-out/`  -  durable knowledge about Adithya's life: people, projects, decisions, history. Graphify maintains it from `raw/`.
- **Workspaces** at `workspaces/<name>/`  -  pipelines that produce outputs and feed `raw/`. Adithya and I co-edit them via ICM.

Memory tells you HOW to work with Adithya. The graph tells you WHAT Adithya is doing and has done. Workspaces are the machinery that keeps both fresh.

## Ground Rules

- Follow ICM conventions strictly. The source of truth is `_core/CONVENTIONS.md`. Do not invent new patterns; if a new pattern is needed, propose it and update `_core/CONVENTIONS.md` first.
- **Auto-run setup on workspace creation (Pattern 17).** Building a new workspace means: run `_core/templates/workspace/setup/questionnaire.md` interactively FIRST, collect answers, scaffold from template, substitute every `{{PLACEHOLDER}}`, verify zero `{{` remain, register in this Workspace Index, then run `python3 _core/playbooks/icm-audit/scripts/audit.py` to confirm clean. Never scaffold-then-ask.
- **Workspaces vs skills.** Workspaces are stateful and live under `workspaces/`. Skills are stateless callables and live under `_core/skills/<name>/SKILL.md`. If a "workspace" idea has no state, it is a skill.
- Never modify files in `raw/` after they land. Raw is immutable. (Exception: append-only entity files documented in their workspace CLAUDE.md, e.g. tinder per-person markdown.)
- Never hand-edit `graphify-out/`. Graphify owns it. Re-run `/graphify` instead.
- No em dashes anywhere in this repo.
- Folders and files: `lowercase-with-hyphens`. Stage folders use zero-padded numbers: `01-pull`, `02-summarize`, etc.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`.
- `raw/` content is gitignored (structure tracked via `.gitkeep`). `graphify-out/` is committed so phone/web sessions can read the graph.
- Treat all content as sensitive. This is a personal life-OS.

### Raw deposits MUST be graph-linkable

Anything written into `raw/<workspace>/` must be ingestible by Graphify as a node with discoverable edges. Random shards are not allowed.

Required for every raw file:

1. **Stable, semantic slug in the filename.** Examples: `caroline-tinder-austin.md`, `2026-04-28-investor-call.md`, `chase-checking.md`. Never UUIDs alone, never random hashes alone, never opaque IDs.
2. **Frontmatter with foreign keys.** YAML at top of every markdown raw file. Include the natural identifiers other workspaces could cross-reference: `phone` (links to `imessage`), `email` (links to `email`), `match_id` / `person_id` (system IDs), `slug`, `source`, `city`, etc.
3. **Edges form via shared identifier values, not explicit `links:` arrays.** Graphify auto-draws an edge whenever the same canonical-form identifier appears in frontmatter or body across two raw files. So if `tinder/caroline-tinder-austin.md` has `phone: "+15125551234"` and `contacts/caroline-smith.md` has `phones: ["+15125551234"]`, the edge is automatic. No explicit `links:` field, no separate linking pass. Use wikilinks `[[<slug>]]` in body only when you want a strong typed reference (e.g. "saw [[caroline-tinder-austin]] at coffee yesterday" in a journal entry).
4. **Identifiers MUST be in canonical form** so string-equality joins work across workspaces:
   - **Phones**: E.164 (`+15125551234`). No spaces, no parens, no dashes, country code mandatory.
   - **Emails**: lowercase, trimmed.
   - **Slugs**: kebab-case lowercase ascii. No unicode.
   - **System IDs** (Tinder match_id, Apple Contacts UID, Slack user ID, etc.): exactly as the source provides  -  never normalize.
   - **Dates**: ISO-8601 with timezone (`2026-04-28T14:32:11Z`).
5. **Renamings preserve provenance.** If a slug changes (e.g. city re-bucketing), add the old slug to `previous_slugs: [...]` in frontmatter so backlinks resolve.
6. **One entity per file when the data is per-entity.** Don't shard people across NDJSON months  -  one person, one file, append over time. Use NDJSON only for high-volume per-event logs that don't have a per-entity owner (e.g. swipe sweeps, page views).

If a raw deposit can't satisfy these, it doesn't belong in `raw/`. Stash it in the workspace's own state dir or in `~/.quantum/<workspace>/` instead.

### Bulk operations are local-only

Any operation that touches many raw files in sequence (re-tagging, slug renames, regex backfills, schema migrations) is **local disk only**. Network calls to the source platform  -  Tinder, Slack, Gmail, etc.  -  are forbidden during bulk passes, because that's the rate spike that flags accounts as bots.

If a workspace genuinely needs to re-fetch data from the source for many entities, it goes through the workspace's normal cron cadence, one entity at a time, paced by the existing rate limiter. No bulk re-pull, no "just run it once to get everything fresh."

Local-only bulk passes (reading markdown, regex extraction, frontmatter rewrites) are always safe regardless of size. They're indistinguishable from `grep` to any external system.

## Learnings (self-improvement loop)

Claude writes non-obvious observations to `raw/learnings/<YYYY-MM-DD>-<slug>.md`. One file per insight. Immutable after write. Format is simple markdown; no required frontmatter for v1.

What qualifies (default is SKIP):
- A failed expectation (something didn't work the way I assumed it would).
- A pattern observed 2+ times across sessions.
- An explicit "remember this" from Adithya.
- A generalized cross-project pattern (redact proprietary code details).

Auto-injection back into sessions is handled by two hooks wired in `.claude/settings.json`:
- `scripts/hooks/learnings-session-start.sh` runs at session open. Lists the inventory.
- `scripts/hooks/learnings-inject.sh` runs on every user prompt. If the store has 5 or fewer files, dumps all. Otherwise ripgreps for keywords from the prompt and injects up to 3 most-relevant files. Capped at 4000 bytes.

Graphify also picks up `raw/learnings/` on the next 2h lint pass, so learnings become queryable via `/graphify query` and get cross-linked to other entities automatically.

## When You Are Stuck

If a task does not cleanly map to an existing workspace, do not invent a new one in flight. Tell Adithya, propose the workspace, wait for greenlight, then scaffold it via the workspace-builder pattern in `_core/templates/`.

---

## Graphify Hook (auto-managed)

This project has a Graphify knowledge graph at `graphify-out/`.

- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure.
- If `graphify-out/wiki/index.md` exists, navigate it instead of reading raw files.
- For cross-domain "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep. These traverse the graph's EXTRACTED + INFERRED edges instead of scanning files.
- After modifying files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Auto-Stack

Three layers keep the graph fresh once it exists. All run via launchd or git.

| Layer | Trigger | What runs | Cost |
|-------|---------|-----------|------|
| 1. Auto-sync | launchd, every 60s (`scripts/sync.sh`, plist `com.shakstzy.quantum-sync`) | stage, secret-scan, commit, pull-rebase, push | free |
| 2. Git hooks | post-commit and post-checkout (installed by `graphify hook install`) | `graphify update` (AST refresh on code only) | free |
| 3. Lint timer | launchd, every 2h (`scripts/graphify-lint.sh`, plist `com.shakstzy.quantum-graphify`) | `cluster-only` + `update` against the bootstrapped scope; if `check-update` flags pending semantic work, drives `/graphify` via headless `claude -p` plus a wiki-lint pass writing to `graphify-out/lint-log.md` | bundled in Claude Max (capped at $5/run) |
| 4. ICM audit | launchd, every 15 min (`_core/playbooks/icm-audit/scripts/audit.py`, plist `com.shakstzy.quantum-icm-audit`) | read-only structural audit of workspaces and routing layers; diff-only writes to `~/.quantum/audit/runs/<ts>/`. Flags missing CLAUDE.md, missing `raw/<ws>/`, leftover `{{` placeholders (Pattern 17), em dashes, ceiling violations, registry drift. | free |

Logs land in `~/Library/Logs/quantum-graphify.{log,stdout,stderr}` and `~/Library/Logs/quantum-sync.log`.

Layer 2 hooks cover code refreshes triggered by every auto-sync commit. Layer 3 handles re-clustering, semantic re-extract on docs/PDFs/images/video, and the wiki lint pass. The lint timer reads `graphify-out/.scope` to learn which subfolder of `raw/` was originally bootstrapped, and reuses that for all later refreshes.

### First build is manual

`/graphify` stops to ask for a subfolder when the target exceeds 200 files or 2M words, so the whole `raw/` tree (currently ~11k files, ~1.3GB) cannot be auto-bootstrapped. Adithya picks a subfolder and runs the first build by hand:

```
cd /Users/shakstzy/QUANTUM
# in Claude:
/graphify raw/<subfolder> --wiki --obsidian --obsidian-dir graphify-out/obsidian
echo "raw/<subfolder>" > graphify-out/.scope
```

After that, the cron is hands-off for that scope. To bring more workspaces under the graph, repeat the `/graphify` step for each scope and merge with `graphify merge-graphs`.

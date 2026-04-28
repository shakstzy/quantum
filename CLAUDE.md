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
│   └── templates/
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
│   └── library/
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
│   └── library/
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
| people | Manual / contacts | Friends, family, colleagues, network |
| library | Manual / browser captures | Books, articles, papers, watchlists |

Each workspace is self-contained per ICM. Once you cd into a workspace, that workspace's CLAUDE.md takes operational precedence over this root file.

## Triggers

| Keyword | Action |
|---------|--------|
| `setup` | Run onboarding questionnaire in current workspace |
| `status` | Show pipeline state for current workspace |
| `pull` | Workspace fetches fresh data from its external source into `raw/<workspace>/` |
| `digest` | Roll up recent activity across all workspaces (default last 7 days) |
| "post to IG" / "publish this reel" / "drop this on TikTok" / "upload to YouTube" / "cross-post this" | Read `_core/skills/zernio-post/SKILL.md`. Cross-platform publish via Zernio direct REST. `PUBLISH` gate required. `ZERNIO_API_KEY` lives in `.claude/settings.local.json`. |
| "send slack" / "slack <name>" / "dm <name> on slack" / "post to #<channel>" / "read #<channel>" / "search slack for X" / "who is <name> on slack" | Read `_core/skills/slack/SKILL.md`. Send/read Slack as Adithya via xoxp user token. Token in macOS Keychain `service=quantum-slack`. |
| "text <name>" / "imessage <name>" / "send a text to <name>" / "look up <name> in my contacts" / "what did <name> last text me" / "pull my iMessage history with <name>" | Read `_core/skills/macos-contacts-imessage/SKILL.md`. Native macOS Contacts + iMessage/SMS/RCS via osascript and chat.db. No gate by default. |
| "search notion" / "find in notion" / "create notion page" / "append to notion page" / "query notion db" | Read `_core/skills/notion/SKILL.md`. Notion REST primitives (search, page-get, page-create, block-append, db-query). Token in macOS Keychain `service=quantum-notion`. |
| "dm <name> on discord" / "text <name> on discord" / "message <name> on discord" / "read my dms with <name>" / "search my discord for X" / "post in #<channel> on discord" / "read #<channel> on discord" / "who is <name> on discord" | Read `_core/skills/discord/SKILL.md`. Send/read Discord as Adithya via patchright-driven Chrome session. Cookies in `~/.quantum/chrome-profiles/discord/`. ToS-sensitive (self-bot surface); burner account recommended. |
| "ship this PR" / "open a PR" / "draft a PR" / "merge this PR" / "what PRs are open" / "comment on PR <N>" / "what's failing in CI" / "rerun the failed run" / "cut a release" / "create a gist" / "open an issue for X" | Read `_core/skills/gh/SKILL.md`. Already authenticated as `shakstzy` (keyring; scopes: gist, read:org, repo, workflow). Visible writes (PR merge, release, cross-user comments) require Adithya confirmation. |
| "compress this video" / "shrink this mp4" / "convert to <format>" / "extract audio" / "trim this clip" / "make a gif" / "downscale to 720p / 1080p" / "make a thumbnail" / "concat these clips" / "normalize the audio" / "transcode for whatsapp / web" / "probe this file" | Read `_core/skills/ffmpeg/SKILL.md`. Local-only, no auth. Defaults to `libx264 -crf 23` mp4; switch to `h264_videotoolbox` when speed beats size. Never overwrite source without explicit `CONFIRM`. |
| paste a youtube.com/youtu.be URL with "summarize" / "tldr" / "recap" / "explain" / "takeaways" | Read `_core/skills/youtube-summary/SKILL.md`. Pulls the transcript via `youtube_transcript_api` and summarizes. Local-only, no auth. Save outputs to `raw/library/` if Adithya asks. |
| paste an instagram.com/p/ /reel/ /reels/ /tv/ URL with "summarize" / "tldr" / "explain" / "takeaways" | Read `_core/skills/instagram-summary/SKILL.md`. Posts get caption + visual analysis; reels also get a Whisper audio transcript. Final synthesis via the local Gemma daemon at `127.0.0.1:8765`. Save outputs to `raw/library/` if Adithya asks. |
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

1. Files land at `raw/<workspace>/YYYY-MM-DD-<slug>.<ext>`.
2. The next scheduled `/graphify raw/ --update` rebuilds the graph incrementally.
3. Workspaces never hand-edit `graphify-out/`. Graphify owns it.

## Memory vs Wiki vs Workspaces

Three separate stores. Do not conflate.

- **Memory** at `~/.claude/projects/-Users-shakstzy-QUANTUM/memory/` — Adithya's preferences, current state, ephemeral context. I (Claude) maintain it.
- **Graph** at `graphify-out/` — durable knowledge about Adithya's life: people, projects, decisions, history. Graphify maintains it from `raw/`.
- **Workspaces** at `workspaces/<name>/` — pipelines that produce outputs and feed `raw/`. Adithya and I co-edit them via ICM.

Memory tells you HOW to work with Adithya. The graph tells you WHAT Adithya is doing and has done. Workspaces are the machinery that keeps both fresh.

## Ground Rules

- Follow ICM conventions strictly. The source of truth is `_core/CONVENTIONS.md`. Do not invent new patterns; if a new pattern is needed, propose it and update `_core/CONVENTIONS.md` first.
- Never modify files in `raw/` after they land. Raw is immutable.
- Never hand-edit `graphify-out/`. Graphify owns it. Re-run `/graphify` instead.
- No em dashes anywhere in this repo.
- Folders and files: `lowercase-with-hyphens`. Stage folders use zero-padded numbers: `01-pull`, `02-summarize`, etc.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`.
- `raw/` content is gitignored (structure tracked via `.gitkeep`). `graphify-out/` is committed so phone/web sessions can read the graph.
- Treat all content as sensitive. This is a personal life-OS.

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

Three layers keep the graph fresh with zero manual effort. All run via launchd or git, no human in the loop.

| Layer | Trigger | What runs | Cost |
|-------|---------|-----------|------|
| 1. Auto-sync | launchd, every 60s (`scripts/sync.sh`, plist `com.shakstzy.quantum-sync`) | stage, secret-scan, commit, pull-rebase, push | free |
| 2. Git hooks | post-commit and post-checkout (installed by `graphify hook install`) | `graphify update .` (AST refresh on code only) | free |
| 3. Lint timer | launchd, every 2h (`scripts/graphify-lint.sh`, plist `com.shakstzy.quantum-graphify`) | `cluster-only`; if `check-update` flags pending semantic work, full `graphify .` plus `claude -p` lint writing to `graphify-out/lint-log.md` | bundled in Claude Max |

Logs land in `~/Library/Logs/quantum-graphify.{log,stdout,stderr}` and `~/Library/Logs/quantum-sync.log`.

The Layer 2 hooks cover code refreshes triggered by every auto-sync commit, so `graphify update` runs many times an hour. The Layer 3 timer skips `update` to avoid duplication and only does work git hooks cannot: re-clustering, semantic re-extract on docs/PDFs/images/video, and the Claude wiki lint pass.

Multi-workspace routing into `raw/`: each workspace gets its own subfolder. Symlink real repos in if you want one source of truth, or let `workspaces/<name>/` pipelines deposit fresh files. Either way, Graphify ingests the whole `raw/` tree as one corpus, so cross-workspace edges form automatically and concept-level dedup happens in the semantic pass.

The very first `graphify .` build must be triggered manually once `raw/` has real content. After that, the stack is hands-off.

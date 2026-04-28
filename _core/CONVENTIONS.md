# QUANTUM Conventions (ICM)

Source of truth for the Inverted Context Model used across QUANTUM. Other files reference this. Do not invent new patterns; if something is missing, propose a change here first.

## Layering

Three distinct stores. They do not share data, only references.

- **Memory** (`~/.claude/projects/-Users-shakstzy-QUANTUM/memory/`) — Adithya's preferences and current state. Claude maintains it.
- **Graph** (`graphify-out/`) — durable knowledge derived from `raw/`. Graphify owns it. Never hand-edit.
- **Workspaces** (`workspaces/<name>/`) — pipelines that pull external data and deposit into `raw/<name>/`. Co-edited.

Memory tells you HOW to work with Adithya. Graph tells you WHAT Adithya is doing or has done. Workspaces are the machinery that keeps both fresh.

## Folder + file naming

- `lowercase-with-hyphens` for files and folders.
- Pipeline stage folders are zero-padded: `01-pull`, `02-summarize`, `03-classify`.
- No spaces. No underscores in user-facing paths (Python module files exempt).
- No em dashes anywhere in this repo.

## Workspace structure

Each workspace at `workspaces/<name>/` has:

```
workspaces/<name>/
├── CLAUDE.md           operating doc for this workspace
├── scripts/            pull, transform, classify, post-process
└── (optional stages)   01-pull/, 02-summarize/, etc. when the pipeline is multi-stage
```

`CLAUDE.md` for a workspace MUST cover:
1. **Purpose** — one paragraph: source, what lands in `raw/`, why.
2. **Triggers** — what `pull`, `digest`, `setup`, etc. map to in this workspace.
3. **Layout** — quick map of `scripts/` and any stage folders.
4. **Conventions** — file naming for raw deposits, watermark/cache locations, dedupe keys.
5. **Cadence** — launchd plist path and frequency, log paths.

## Raw deposits

- Files land at `raw/<workspace>/YYYY-MM-DD-<slug>.<ext>` OR a documented sharded scheme (e.g. iMessage uses `YYYY-MM.ndjson`).
- `raw/` is **immutable** after deposit. Workspaces never rewrite a file once written.
- `raw/` content is gitignored (`raw/*/*` plus `!raw/*/.gitkeep`). Folder structure is committed.
- Operational state (watermarks, classification caches, error logs) goes under `raw/.ingest-log/`. That path is listed in `.graphifyignore`, so the contents stay out of the graph.

## Graphify integration

- The first full graph build is **manual**. Adithya runs `/graphify <subfolder> --wiki --obsidian --obsidian-dir graphify-out/obsidian` against a chosen subfolder of `raw/` in an interactive Claude window. The cron does not auto-bootstrap — `raw/` is over `/graphify`'s 200-files / 2M-words confirmation threshold, so it cannot run unattended on the whole corpus.
- After the bootstrap, `scripts/graphify-lint.sh` (launchd, every 2h) handles steady-state: free `cluster-only` and `update` against the existing graph, and only triggers a semantic re-extract via headless `claude -p` when `graphify check-update` flags pending work.
- The bootstrapped scope is recorded in `graphify-out/.scope` (one line, e.g. `raw/journal`); the cron reuses that scope for all later refreshes.
- Workspaces never write to `graphify-out/`. Run `/graphify` (or wait for the cron) instead.
- AST-only refreshes for code happen via the `post-commit` git hook (idempotent, no LLM cost).

## Wiki consultation (for agents)

Before answering any question about Adithya's life, projects, people, decisions, or recurring topics:

1. Run `/graphify query "<question>"`.
2. Read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure.
3. If `graphify-out/wiki/index.md` exists, navigate it instead of grepping `raw/`.
4. If the graph cites raw files, read them to confirm.
5. If the graph has nothing useful, say so. Do not invent.

## Skills

- Project-specific skills live at `_core/skills/<name>/SKILL.md`. Adithya invokes them per workspace.
- Global skills (`obsidian-markdown`, `obsidian-bases`, `obsidian-cli`, `json-canvas`, `defuddle`, `graphify`) live under `~/.claude/skills/`. They auto-trigger on filetypes and keywords.
- Editing files inside `graphify-out/obsidian/` triggers the kepano Obsidian skills automatically. Editing `raw/` does not — `raw/` is immutable.

## Commits

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Auto-sync (`scripts/sync.sh`) commits every ~60s with `chore(auto-sync): <timestamp>`. Anything you stage manually before the next tick will be folded in under that auto-sync message — make a manual commit first if you want a meaningful subject.
- Never commit secrets. The auto-sync committer scans for known key patterns and aborts if it sees one.

## Hard rules

- Never modify files in `raw/` after they land.
- Never hand-edit `graphify-out/`. Re-run `/graphify`.
- Never invent a new top-level directory or workspace mid-task. Propose it, wait for greenlight, then scaffold from `_core/templates/` (when populated).
- Never commit content under `raw/`, `graphify-out/`, `workspaces/tinder/.profile/`, or any `04-outbound/{drafts,pending,approved,sent,expired,auto-sent}/` folder.
- Treat all repo content as sensitive. This is a personal life-OS.

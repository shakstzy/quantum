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
├── graphify-out/                (gitignored; Graphify owns this)
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
- `raw/` content is gitignored (structure tracked via `.gitkeep`). `graphify-out/` is gitignored.
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

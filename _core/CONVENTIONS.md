# QUANTUM Conventions (ICM)

Source of truth for the **Inverted Context Model** used across QUANTUM. Every workspace follows these patterns. Other files reference this file. Do not invent new patterns; if something is missing, propose a change here first.

Re-read this file fresh before any operation that touches `workspaces/`, `_core/`, or root `CLAUDE.md`. Pattern recall is unreliable. The file is authoritative. Patterns 1 through 15 are adapted from the Interpreted-Context-Methodology reference at `references/Interpreted-Context-Methdology-main 3/_core/CONVENTIONS.md`. Patterns 16 and 17 are QUANTUM-specific.

---

## Three-Store Model

Three distinct stores. They do not share data, only references.

- **Memory** (`~/.claude/projects/-Users-shakstzy-QUANTUM/memory/`): Adithya's preferences and current state. Claude maintains it.
- **Graph** (`graphify-out/`): durable knowledge derived from `raw/`. Graphify owns it. Never hand-edit.
- **Workspaces** (`workspaces/<name>/`): pipelines that produce outputs and feed `raw/`. Adithya and Claude co-edit via ICM.

Memory tells Claude HOW to work with Adithya. The graph tells Claude WHAT Adithya is doing or has done. Workspaces are the machinery that keeps both fresh.

---

## Two Workspace Types

A workspace is a *stateful* container. There are exactly two flavors.

| Type | Purpose | Direction | `raw/<ws>/` folder | Stages | Examples |
|------|---------|-----------|---------------------|--------|----------|
| **Ingest** | Pull data from an external system into `raw/<ws>/` for graphify | external -> repo | required | optional (usually none) | slack, email, calendar, gdrive, imessage, journal, finance, health, people, library |
| **Workflow** | Multi-stage pipeline that operates on existing data and produces durable artifacts | internal | optional | typically yes | digest, weekly-review (none built yet) |

There is no third type. **Action-only callables are skills, not workspaces.** Sending Slack DMs, posting Gmail, generating Higgsfield media all live in `_core/skills/<name>/SKILL.md`. A workspace may invoke a skill from inside its workflow, but the skill itself is never a workspace.

The promotion rule: only promote something to a workspace when it has stateful operations. If it is a one-shot stateless callable, it is a skill.

---

## Five-Layer Routing Architecture

Agents read down the layers. They stop as soon as they have what they need.

```
Layer 0: root CLAUDE.md          -> "Where am I in QUANTUM?"   (always loaded)
Layer 1: workspace CLAUDE.md     -> "Where do I go in this workspace?" (loaded on cd)
Layer 2: stage CONTEXT.md        -> "What do I do?"            (read per-task; workflow workspaces only)
Layer 3: reference material      -> "What rules apply?"        (loaded selectively)
Layer 4: working artifacts       -> "What am I working with?"  (raw/, output/, loaded selectively)
```

For ingest workspaces, Layer 2 is usually skipped. The workspace CLAUDE.md routes directly to a single `pull` script and the ingest schema. Layers 3 and 4 are usually empty or minimal.

For workflow workspaces, all five layers are in play.

Every token of irrelevant context is a token of diluted attention. Workspace CLAUDE.md files map each task to its minimal required files. Loading more does not make output better. It makes it worse.

---

## Workspace Structure

### Ingest workspace (mandatory layout)

```
workspaces/<name>/
├── CLAUDE.md              (Layer 1: required)
├── setup/
│   └── questionnaire.md   (filled on first build; placeholders resolved)
├── scripts/
│   └── pull.sh            (or pull.py / pull.mjs; one canonical entry)
└── (rules/, references/ optional)
```

Plus the corresponding `raw/<name>/` directory at the repo root, gitignored except for `.gitkeep`.

### Workflow workspace (mandatory layout)

```
workspaces/<name>/
├── CLAUDE.md              (Layer 1: required)
├── CONTEXT.md             (Layer 1: top-level task routing)
├── setup/
│   └── questionnaire.md
├── stages/
│   ├── 01-<name>/
│   │   ├── CONTEXT.md     (Layer 2)
│   │   ├── references/    (Layer 3)
│   │   └── output/        (Layer 4)
│   ├── 02-<name>/
│   └── 03-<name>/
├── shared/                (cross-stage Layer 3)
└── skills/                (bundled skills, optional, see Pattern 9)
```

### Workspace CLAUDE.md required sections

Every workspace's `CLAUDE.md` MUST include:

1. **Purpose**: one paragraph. Source, what lands in `raw/<ws>/` (ingest) or what artifact the pipeline produces (workflow), why.
2. **Triggers**: table mapping `setup`, `status`, `pull` (and any extras) to concrete commands.
3. **Layout**: tree of `scripts/`, `stages/`, etc.
4. **Ingest schema** (ingest workspaces only): see Ingest Schema section below.
5. **Conventions**: dedupe keys, watermark file path, error-log path, anything workspace-specific.
6. **Cadence** (if automated): launchd plist label, frequency, log paths.
7. **Skill pointer** (if applicable): link to `_core/skills/<name>/SKILL.md` for any external mutations the operator may want to perform on this domain.

---

## Pattern 1: Stage Contracts (workflow workspaces)

Every stage CONTEXT.md follows the same three-section shape:

```markdown
## Inputs

| Source | File/Location | Section/Scope | Why |

## Process

1. Step one
2. Step two

## Outputs

| Artifact | Location | Format |
```

Simple enough that a non-technical user can read it. Structured enough that an agent can follow it. No exceptions.

---

## Pattern 2: Stage Handoffs via Output Folders

Stage N produces `stages/0N-name/output/<slug>-<artifact>.md`. Stage N+1's CONTEXT.md says "read `../0N-name/output/<slug>-<artifact>.md` as your input." A human can edit the output file between stages and the next stage picks up the edit.

---

## Pattern 3: One-Way Cross-References

Every folder points outward to what it needs. No folder points back. This prevents reference growth from going N-squared.

---

## Pattern 4: Selective Section Routing

CONTEXT.md Inputs tables specify which section of a file to load, not the whole file. When the full file is needed, write "Full file" in the Section/Scope column.

---

## Pattern 5: Canonical Sources

Every piece of information has ONE home. Other files point there. They do not duplicate it. If you find the same information in two files, one of them should be a pointer.

---

## Pattern 6: CONTEXT.md = Routing, Not Content

CONTEXT.md files answer three questions: what is this folder, what do I load, what is the process. No definitions. No rules. No extended examples. If you find yourself writing more than a one-sentence description, that content belongs in a separate file.

---

## Pattern 7: Tool Prerequisites

Stages that require external tools (Node, Python, ffmpeg) get setup guides in `references/<tool>-setup.md`. If the tool is needed by multiple stages, it lives in `shared/`.

---

## Pattern 8: Questionnaire Design

Onboarding questionnaires configure the production system, not a specific run.

1. Flat structure. No category groupings.
2. All at once. Every question appears in one pass.
3. System-level only. Per-run details are collected at the start of each run.
4. Derive, do not ask. If a field can be inferred, the agent fills it.
5. Sensible defaults so the user can skip what they do not care about.
6. Ask once, never again. Answers are baked into workspace files permanently.
7. Examples over descriptions for voice/style questions.

The template lives at `_core/templates/workspace/setup/questionnaire.md`.

---

## Pattern 9: Bundled Skills

Workflow workspaces can bundle skills from `_core/skills/` into a local `skills/` folder. Stage CONTEXT.md files reference them in their Inputs table. Ingest workspaces should NOT bundle; they reference `_core/skills/<name>/SKILL.md` directly from their CLAUDE.md if they invoke any.

---

## Pattern 10: Specs Are Contracts (workflow workspaces only)

Specification stages define WHAT and WHEN, not HOW. The build stage has creative freedom within the quality floor.

---

## Pattern 11: Checkpoints (workflow workspaces only)

Creative stages should include at least one checkpoint where the agent pauses and the human steers. Linear stages (extract, render, validate) often run straight through.

---

## Pattern 12: Stage Audits (workflow workspaces only)

Creative and build stages should include an Audit section: a checklist the agent runs after the process but before writing to output/.

---

## Pattern 13: Value Validation (workflow workspaces only)

Content-producing stages should define what types of value their output can deliver and agree on the target value type at a checkpoint before the main work begins.

---

## Pattern 14: Docs Over Outputs

Reference docs are the authoritative source for how to build. Previous stage outputs are artifacts, not templates. Agents should not read other outputs to learn patterns.

---

## Pattern 15: Shared Constants (workflow workspaces that produce code)

Configurable values (colors, fonts, timing) live in shared files that all build outputs import from. The questionnaire populates these once during onboarding.

---

## Pattern 16: Skills Are Skills, Workspaces Are Workspaces

Skills live in `_core/skills/<name>/SKILL.md`. They are stateless callables. Read via the Read tool when their triggers fire; invoke via the Skill tool when listed in the user-invocable skills list.

Workspaces are stateful. They live in `workspaces/<name>/` and follow this CONVENTIONS.md.

Forbidden moves:
- Putting domain procedures (SKILL.md) in `.claude/skills/`. That path is for Claude Code's harness-level skills only.
- Creating a "workspace" for something that has no state. If it is a one-shot callable, write it as a skill.
- Symlinking workspace files into `_core/skills/` to wire them up. Skills and workspaces have different lifecycles.

---

## Pattern 17: Auto-Run Setup on Workspace Creation

When building a new workspace, the agent MUST run the setup questionnaire interactively BEFORE scaffolding from template. The order is:

1. Ask questionnaire questions (from `_core/templates/workspace/setup/questionnaire.md`).
2. Collect answers.
3. Copy template into `workspaces/<name>/`.
4. String-substitute every `{{PLACEHOLDER}}` with the collected answer.
5. Verify zero `{{` patterns remain.
6. Add row to root `CLAUDE.md` Workspace Index and Routing tables.
7. Create `raw/<name>/.gitkeep` if ingest workspace.
8. Run `_core/skills/icm-audit/scripts/audit.py` to confirm clean.

Do NOT scaffold first and then ask. Do NOT skip the questionnaire because the operator is "obvious." The questionnaire output is the workspace's permanent configuration; treat it like a contract.

The icm-audit skill flags any workspace with leftover `{{` placeholders as a critical finding.

---

## Trigger Keywords

Every workspace recognizes:

- `setup`: run onboarding questionnaire (also auto-runs on workspace creation per Pattern 17).
- `status`: show pipeline state. For ingest workspaces: latest deposit timestamp + file count in `raw/<ws>/`. For workflow workspaces: ASCII pipeline diagram of stage completion.
- `pull`: ingest workspaces only. Fetch fresh data from the external source into `raw/<ws>/`.

Workflow workspaces may define additional triggers. Ingest workspaces should not.

Root QUANTUM CLAUDE.md additionally recognizes:
- `digest`: cross-workspace activity rollup.
- `icm audit`: run the icm-audit skill on demand (also runs every 15 minutes via launchd).

---

## Ingest Schema

Every ingest workspace declares its file nomenclature in a `## Ingest` section in its CLAUDE.md:

```markdown
## Ingest

- **Source:** [Gmail / Slack / Apple Health / manual / ...]
- **Trigger:** `pull` -> `bash scripts/pull.sh [args]`
- **Automation:** [launchd plist label / cron line / "manual only"]
- **Shape:** [item-stream / daily-snapshot] (see "Ingest Dedup Standard" below)
- **Output path:** see chosen shape
- **Format:** [JSON / NDJSON / Markdown / ...]
- **Dedup key:** [native source ID, e.g. gmail threadId / calendar eventId / drive fileId / slack channel+ts / imessage ROWID]
- **Watermark:** `raw/.ingest-log/<ws>-<scope>.<ext>` (resume state)
- **Mutations:** [skill at `_core/skills/<name>/SKILL.md` / "none, read-only"]
```

`raw/` is immutable. Re-run `pull` to refresh; never hand-edit. Operational state (watermarks, classification caches, error logs) goes under `raw/.ingest-log/`. That path is in `.graphifyignore`, so contents stay out of the graph.

### Ingest Dedup Standard

Every ingest pipeline picks ONE of two shapes and documents the choice in its workspace `CLAUDE.md`. Re-runs of `pull` MUST be idempotent: pulling the same time window twice produces the same `raw/<ws>/` content. This guarantee is what lets the launchd cron run with overlapping windows safely and lets graphify ingest without duplicate concepts.

**Shape A: item-stream (default for high-volume sources)**

```
raw/<ws>/<scope>/YYYY-MM.ndjson
```

- One JSON object per line. Each line is one source item (gmail thread, calendar event, drive file, slack message, imessage row).
- Line is keyed by the source's stable native ID. The ingest writer dedupes within the file before write: read existing IDs, skip if present, append if new.
- `<scope>` = a partitioning dimension that keeps any single shard small enough to scan: account slug for Google (one Gmail account fits in per-month shards), workspace slug for Slack, omitted entirely for iMessage (single-source).
- Resume state lives at `raw/.ingest-log/<ws>-<scope>.<ext>` (a watermark timestamp, a processed-IDs file, or a per-channel cursor map). Pull reads it, fetches only what's new, updates it on success.
- Examples: `raw/email/adithya-eclipse-builders/2026-04.ndjson`, `raw/imessage/2026-04.ndjson`, `raw/slack/eclipse-labs/2026-04.ndjson`.

**Shape B: daily-snapshot (for sources without a stable item ID)**

```
raw/<ws>/YYYY-MM-DD-<slug>.<ext>
```

- One file per pull. Each pull overwrites the same path on the same day, so re-runs within a day are idempotent.
- Use this only when the source has no stable native ID (e.g. an Apple Health export, a manual journal entry, a captured browser screenshot).

**Hard rules**

1. Pick A or B at workspace creation. Document the choice in the workspace `CLAUDE.md` "Ingest" section.
2. Item-stream writers MUST dedupe by native source ID before append. Never trust the source to send each item once.
3. Watermarks live under `raw/.ingest-log/`. That path is in `.graphifyignore`, so it never enters the graph.
4. New ingest workspaces MUST default to Shape A unless the source genuinely lacks stable IDs. Update this section if a third shape is ever needed; do not invent in flight.
5. Old daily-snapshot files left over from a Shape B -> Shape A migration MUST be deleted in the same change that flips the shape, so graphify never sees both.

---

## Naming Conventions

- Folders and files: `lowercase-with-hyphens`
- Stage folders: zero-padded numbers prefix: `01-`, `02-`, `03-`
- Placeholders: `{{SCREAMING_SNAKE_CASE}}` (see `_core/placeholder-syntax.md`)
- Output artifacts: `<topic-slug>-<artifact-type>.md`
- Raw deposits: see "Ingest Dedup Standard". Shape A (default): `raw/<ws>/<scope>/YYYY-MM.ndjson`. Shape B: `raw/<ws>/YYYY-MM-DD-<slug>.<ext>`.
- No spaces in file or folder names
- No em dashes anywhere

---

## Quality Guardrails

- CONTEXT.md files: under 80 lines
- Reference files: under 200 lines (split if longer)
- Workspace CLAUDE.md: under 120 lines (target)
- Plain English. Avoid jargon. If a term needs explaining, it is too specialized.
- No em dashes anywhere in the repo
- Every folder that should persist but starts empty gets a `.gitkeep`
- Every markdown file should be readable by someone with markdown + git basics, not deep engineering background

---

## Graphify Integration

The first full graph build is **manual**. Adithya runs `/graphify <subfolder> --wiki --obsidian --obsidian-dir graphify-out/obsidian` against a chosen subfolder of `raw/` in an interactive Claude window. The cron does not auto-bootstrap because `raw/` is over `/graphify`'s 200-files / 2M-words confirmation threshold and cannot run unattended on the whole corpus.

After the bootstrap, `scripts/graphify-lint.sh` (launchd, every 2h) handles steady-state: free `cluster-only` and `update` against the existing graph, and only triggers a semantic re-extract via headless `claude -p` when `graphify check-update` flags pending work. The bootstrapped scope is recorded in `graphify-out/.scope` (one line, e.g. `raw/journal`); the cron reuses that scope for all later refreshes.

Workspaces never write to `graphify-out/`. AST-only refreshes for code happen via the `post-commit` git hook.

---

## Wiki Consultation (for agents)

Before answering any question about Adithya's life, projects, people, decisions, or recurring topics:

1. Run `/graphify query "<question>"`.
2. Read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure.
3. If `graphify-out/wiki/index.md` exists, navigate it instead of grepping `raw/`.
4. If the graph cites raw files, read them to confirm.
5. If the graph has nothing useful, say so. Do not invent.

---

## Commits

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Auto-sync (`scripts/sync.sh`) commits every ~60s with `chore(auto-sync): <timestamp>`. Stage manually before the next tick to fold in a meaningful subject; otherwise it gets the auto-sync message.
- Never commit secrets. The auto-sync committer scans for known key patterns and aborts if it sees one.

---

## Enforcement: icm-audit

`_core/skills/icm-audit/scripts/audit.py` runs every 15 minutes via launchd (`com.shakstzy.quantum-icm-audit.plist`). Read-only against the QUANTUM repo; writes only to `~/.quantum/audit/`. Diff-only writes mean idle periods do not create churn.

It checks:
- Every `workspaces/*/` has a `CLAUDE.md`.
- Every workspace declared as ingest has a corresponding `raw/<name>/` folder.
- Every workspace on disk is registered in root `CLAUDE.md` Workspace Index and Routing tables.
- No `{{` placeholders remain in any workspace file (Pattern 17).
- No em dashes anywhere.
- CONTEXT.md ceiling (80 lines), reference ceiling (200 lines).
- Byte-identical 20-line spans across CLAUDE.md files (canonical-source enforcement).
- Filenames are lowercase-with-hyphens.

Findings hash to a deterministic JSON; only writes a new run dir when findings change. Last 30 distinct-findings runs retained at `~/.quantum/audit/runs/`.

Run on demand: `python3 _core/skills/icm-audit/scripts/audit.py`.

---

## Hard Rules

- Never modify files in `raw/` after they land.
- Never hand-edit `graphify-out/`. Re-run `/graphify`.
- Never invent a new top-level directory or workspace mid-task. Propose it, wait for greenlight, then run the questionnaire (Pattern 17), then scaffold from `_core/templates/workspace/`.
- Never commit content under `raw/`, `graphify-out/`, or any per-run output folder.
- If a "workspace" idea has no state, it is a skill. Write it under `_core/skills/<name>/SKILL.md` instead.
- Treat all repo content as sensitive. This is a personal life-OS.

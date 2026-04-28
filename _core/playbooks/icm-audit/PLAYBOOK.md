---
name: icm-audit
description: Read-only structural audit of QUANTUM workspaces and routing layers against ICM invariants from `_core/CONVENTIONS.md`. Reports missing CLAUDE.md per workspace, missing raw/<ws>/ for ingest workspaces, registry drift between disk and root CLAUDE.md tables, leftover `{{` placeholders (Pattern 17 violations), em-dash usage, ceiling violations (CONTEXT.md > 80 lines, refs > 200 lines), byte-identical duplicate spans across CLAUDE.md files. Diff-only writes; retains last 30 distinct-findings runs out-of-tree at ~/.quantum/audit/runs/. Used as the periodic ICM compliance canary.
---

# ICM Audit

Read-only structural audit of QUANTUM routing layers against ICM invariants from `_core/CONVENTIONS.md`. Walks every L0/L1/L2/L3 markdown file, ranks by weighted context cost (`tier_weight x bytes`), and flags real invariant breaches. Does not fix, only reports.

## When this fires

Trigger phrases: "icm audit", "context bloat check", "quantum audit", "run the icm audit", "scan quantum for drift".

Also fires automatically every 15 minutes via launchd at `~/Library/LaunchAgents/com.shakstzy.quantum-icm-audit.plist`. Diff-only writes mean idle periods do not create churn.

Do NOT fire for:
- Single-file lint (just edit the file).
- Workspace pipeline state (use the workspace's own `status` trigger).
- Graph health (graphify owns that via `graphify-out/`).

## Procedure

1. **Discover routing-layer files.** Filesystem scan for `*.md` under `/Users/shakstzy/QUANTUM/`, excluding `node_modules/`, `.venv/`, `target/`, `__pycache__/`, `.git/`, `raw/`, `graphify-out/`, `references/Interpreted-Context-Methdology-main 3/` (the read-only ICM ref repo), `stages/*/output/` (per-run artifacts).

2. **Classify each file by tier.** L0 = root `CLAUDE.md`. L1 = workspace `CLAUDE.md` / `CONTEXT.md`. L2 = stage `CONTEXT.md`. L3 = `PLAYBOOK.md`, files under `references/` / `shared/` / `setup/` / `rules/`. Tier weights: `L0=10, L1=3, L2=1, L3=0.3`.

3. **Ceiling check.** Flag CONTEXT.md > 80 lines and reference files > 200 lines (Quality Guardrails in CONVENTIONS.md). Sort by `weighted_cost = tier_weight x bytes`.

4. **Workspace integrity check.** For each `workspaces/*/`:
   - Has a `CLAUDE.md`? (critical if missing)
   - If declares an `## Ingest` section: does `raw/<name>/` exist on disk? (critical if missing)
   - Any leftover `{{` placeholders in any workspace file? (critical: Pattern 17 violation)

5. **Em-dash sweep.** Any em dash (U+2014) anywhere in `workspaces/`, `_core/`, root `CLAUDE.md`. Flag each occurrence.

6. **Registry drift.** Compare `ls workspaces/*` against the root `CLAUDE.md` Workspace Index and Routing tables. Three drift classes: missing-from-index (critical), missing-from-routing (warning), phantom-in-index (critical: workspace listed but not on disk).

7. **Byte-identical duplicate spans.** Across the root `CLAUDE.md` plus every `workspaces/*/CLAUDE.md`, fingerprint normalized 20-line spans (whitespace collapsed, lowercased) and report only byte-identical matches. Paraphrase-tolerant matches are excluded.

8. **Diff-only write.** Hash the findings list (sorted JSON, generated-timestamp excluded). If unchanged from `~/.quantum/audit/latest/report.json`, log "no change" and skip writing a new run dir. If changed, atomically promote the scratch dir to `~/.quantum/audit/runs/<ISO-ts>/` and update `~/.quantum/audit/latest` symlink.

9. **Retention.** Keep the last 30 distinct-findings runs under `~/.quantum/audit/runs/`. Older runs get pruned automatically.

## Runtime

```bash
python3 /Users/shakstzy/QUANTUM/_core/playbooks/icm-audit/scripts/audit.py
```

No dependencies beyond Python 3 stdlib. Read-only against the QUANTUM repo. Writes only to `~/.quantum/audit/`.

Manual invocation produces the same output as the scheduled run. Idempotent; safe to run anytime.

## Output shape

Each run dir at `~/.quantum/audit/runs/<ISO-ts>/` contains:

```
ledger.csv               every scanned md file: path, kind, bytes, lines, tier_weight, weighted_cost
ceiling-violations.md    invariant breaches, ranked by weighted_cost
workspace-integrity.md   missing CLAUDE.md, missing raw/<ws>/, leftover placeholders
em-dash-sweep.md         every em-dash occurrence with file + line
registry-drift.md        workspaces on disk vs root CLAUDE.md tables
duplicate-candidates.md  byte-identical 20-line spans across CLAUDE.md files
report.md                ranked findings, human-readable
report.json              structured findings; canonical for diff comparison
```

`~/.quantum/audit/latest` symlinks to the most recent distinct-findings run. launchd stdout/stderr go to `~/.quantum/logs/icm-audit.launchd.log`.

## Design notes

- **Read-only against QUANTUM.** The script never modifies `/Users/shakstzy/QUANTUM/`. All writes land under `~/.quantum/audit/`. Avoids auto-sync collision.
- **Diff-only writes.** Every 15 min x 24 h x 365 d = 35,040 runs; writing every run would be noise. The script promotes scratch to `runs/<ts>/` only when findings change.
- **Retention bounded.** Last 30 runs. Older pruned.
- **Tier weights are explicit constants.** L0 always weighted 10x, L1 3x, L2 1x, L3 0.3x.
- **Trigger is idempotent.** Manual invocation while the launchd job is queued for the next 15-min tick is safe; both runs see the same state and either both write the same findings or one is a no-op.

## What this does NOT cover

- Per-stage CONTEXT.md content-vs-routing leakage (only checks the 80-line ceiling).
- Graph health (graphify owns that).
- Semantic duplicate detection (v1 is byte-identical only).
- Tag taxonomy / frontmatter / link-rot inside reference files.
- macOS notifications on new critical findings (deferred until cadence proves stable).

## Pattern 16 + 17 registration

- Home: `_core/playbooks/icm-audit/`. This is a playbook (file-based procedure), not a callable Skill.
- Trigger: row in root `CLAUDE.md` Triggers table for "icm audit".
- Stage wiring: N/A (trigger-invoked + scheduled).
- Canonical sources: script lives only at `_core/playbooks/icm-audit/scripts/audit.py`.
- Smoke test: `PLAYBOOK.md` under 200 lines; lowercase-with-hyphens names; no em dashes; `python3 -m py_compile scripts/audit.py` clean; manual run produces all artifacts when findings change, prints "no change" when they do not.

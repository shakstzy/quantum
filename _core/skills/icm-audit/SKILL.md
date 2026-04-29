---
name: icm-audit
description: Heal-loop for QUANTUM ICM compliance. Audits structural invariants from `_core/CONVENTIONS.md`, triages findings into auto-fixable / external-review / human-only buckets, deterministically auto-fixes em-dashes (region-aware: skips fenced code + frontmatter), sends ambiguous findings to Codex + Gemini for parallel review (recommendation-only in v1), and writes a human digest of overflow items. Coordinates with `scripts/sync.sh` via shared `flock` so neither races the other. Diff-only writes; 30-run retention at `~/.quantum/audit/runs/`. Runs every 15 minutes via launchd.
---

# ICM Heal-Loop

Closed-loop ICM compliance for QUANTUM. Audit -> triage -> auto-fix safe -> external review -> human digest. Deterministic auto-fix is limited to em-dash sweeps in markdown prose. External review is recommendation-only in v1.

## When this fires

Trigger phrases: "icm audit", "run the icm audit", "scan quantum for drift", "heal loop".

Auto-fires every 15 minutes via launchd `com.shakstzy.quantum-icm-audit.plist`. Entrypoint: `scripts/heal-loop.sh`.

Do NOT fire for:
- Single-file lint (just edit the file).
- Workspace pipeline state (use the workspace's own `status` trigger).
- Graph health (graphify owns that via `graphify-out/`).

## Phases (heal-loop.sh)

1. **Coord lock.** Acquire `/tmp/quantum-heal-coord.lock` via `flock -w 60`. `scripts/sync.sh` acquires the same lock with `-w 30` before any git mutation. Either side waits or skips its tick; neither races.

2. **Audit (`audit.py --print-run-dir`).** Walks every L0/L1/L2/L3 `.md` file (gitignored paths excluded; submodules and `.claude/worktrees/` excluded). Classifies by tier (L0=10x, L1=3x, L2=1x, L3=0.3x weighted cost). Emits per-finding `key` for the decisions cache (path normalized, line numbers stripped, includes `rule_version`). Diff-only: writes a new run dir only if findings hash changed; returns the existing `latest` path otherwise.

3. **Triage (`triage.py`).** Classifies each finding by rule:
   - `auto_fix_em_dash` -> Layer 3
   - `external_review` -> Layer 5 (ceiling violations, duplicate spans, registry-drift index)
   - `human_only` -> human digest (missing CLAUDE.md, missing raw/, leftover `{{}}`, registry-drift phantom)
   - Findings already in `~/.quantum/audit/decisions/<key>.json` are skipped unless `rule_version` advanced.

4. **Auto-fix safe (`autofix_safe.py`).** Em-dash only, region-aware:
   - Creates a temp git worktree from current main HEAD.
   - For each finding's file: `fix_em_dash_in_text` walks lines and replaces U+2014 with ` - ` ONLY on prose lines. Skips fenced code blocks (\`\`\` / ~~~), indented code (>=4 leading spaces), YAML frontmatter (between two `---` lines at top), inline code spans.
   - Diff allowlist: every changed file in worktree must appear in the audit's em-dash findings.
   - Base-HEAD verification: main must still equal the worktree's base. Working tree must be clean (graphify-out untracked tolerated).
   - On success: commit on a `icm-heal/em-dash-<ts>` branch, fast-forward main, write per-finding `applied` decisions.
   - On rejection: revert worktree. Permanent rejection types (protected-path, no-replaceable-region, symlink) get cached as decisions; transient rejections (main-dirty, base-shifted, file-missing, read-error) DO NOT write decisions and re-attempt next tick.

5. **External review (`external_review.py`).** RECOMMENDATION-ONLY in v1. For each `external_review` finding (cap 5/tick):
   - Builds a structured prompt demanding JSON output (`decision`, `paths`, `rationale`, `unified_diff`, `confidence`, `requires_human`).
   - Runs `codex exec` and `gemini -p` in parallel with hard 60s timeouts.
   - Captures both responses to `~/.quantum/audit/external-review/<run-ts>/<finding-id>/{prompt.txt,codex.txt,gemini.txt,codex.json,gemini.json,synthesis.json}`.
   - Writes `external-reviewed-not-applied` decision so the same finding does not re-query next tick.
   - Cost ledger: `~/.quantum/audit/cost-ledger.csv`.
   - v2 will add auto-apply when both reviewers structurally agree on a `fix` decision; v1 only writes recommendations.

6. **Human digest (`human_digest.py`).** Always written to `~/.quantum/audit/human-digest.md`. Lists `human_only` findings grouped by rule, latest external-review recommendations, and skipped-already-decided counts. Idempotent (overwritten each tick).

## Decisions log

`~/.quantum/audit/decisions/<key>.json`:

```json
{
  "key": "sha256(rule + normalized_path + observed + rule_version)",
  "rule_version": 1,
  "type": "em_dash",
  "path": "...",
  "decision": "applied" | "rejected-no-replaceable-region" | "rejected-protected-path" | "rejected-symlink" | "external-reviewed-not-applied",
  "first_seen_ts": "...",
  "last_decided_ts": "...",
  ...
}
```

Triage skips entries whose key is already decided unless `rule_version` advances. This bounds external-review cost to once per finding per rule version.

## Runtime

Manual invocation:

```bash
bash /Users/shakstzy/QUANTUM/_core/skills/icm-audit/scripts/heal-loop.sh
```

Audit-only (no fixes):

```bash
python3 /Users/shakstzy/QUANTUM/_core/skills/icm-audit/scripts/audit.py
```

Both are idempotent. The heal-loop is safe to run while launchd is queued for the next tick (the coord lock serializes).

## Output paths

| Path | Purpose |
|------|---------|
| `~/.quantum/audit/runs/<ts>/` | per-run audit artifacts (diff-only) |
| `~/.quantum/audit/latest` | symlink to most recent distinct-findings run |
| `~/.quantum/audit/decisions/<key>.json` | per-finding decisions cache |
| `~/.quantum/audit/external-review/<ts>/<finding-id>/` | Codex + Gemini responses + synthesis |
| `~/.quantum/audit/human-digest.md` | overflow items requiring human action |
| `~/.quantum/audit/cost-ledger.csv` | external-review CLI invocations + statuses |
| `~/Library/Logs/quantum-heal-loop.log` | heal-loop tick log |
| `~/.quantum/logs/icm-audit.launchd.log` | launchd stdout/stderr |

## Safety guardrails

- **Worktree isolation.** Every auto-fix happens in `/tmp/icm-heal-wt-*`; only fast-forwarded into main when re-checks pass.
- **Diff allowlist.** A fix may only modify files that the audit declared in its findings.
- **Base-HEAD verification.** Main HEAD must equal the worktree's base before fast-forward; otherwise abort (transient).
- **Working tree clean (mostly).** Untracked `graphify-out/` files are tolerated; everything else aborts as transient.
- **No-touch paths.** `raw/`, `graphify-out/`, `_core/CONVENTIONS.md`, root `CLAUDE.md`, `.claude/`, `references/`, `node_modules/`, `.git/` are never written by auto-fix.
- **Hard timeout per CLI.** `codex exec` and `gemini -p` get 60s; on timeout the finding routes to human digest.
- **Coord lock.** Shared `flock` between `sync.sh` and `heal-loop.sh`. Auto-sync waits 30s; heal-loop waits 60s. Whoever gets it runs; the other skips its tick.
- **Gitignore aware.** Audit excludes paths that git ignores (skill-internal `references/` folders, etc).

## What this does NOT cover (yet)

- Auto-apply for external-review findings. v1 is recommendation-only; v2 unlocks auto-apply on unanimous structured agreement.
- Auto-fix for `missing_raw_folder`. Pattern 17 + no-touch policy require human intervention.
- Per-stage CONTEXT.md content-vs-routing leakage (only line-count ceiling).
- Semantic duplicate detection (byte-identical 20-line spans only).
- macOS notifications on new critical findings (deferred until cadence proves stable).

## Files

```
_core/skills/icm-audit/
├── SKILL.md              (this file)
└── scripts/
    ├── heal-loop.sh      (orchestrator; entrypoint for launchd)
    ├── audit.py          (Phase 1: structural audit; --print-run-dir)
    ├── triage.py         (Phase 2: classify findings + decisions cache filter)
    ├── autofix_safe.py   (Phase 3: em-dash auto-fix, region-aware, worktree-isolated)
    ├── external_review.py(Phase 5: parallel Codex + Gemini review, recommendation-only)
    └── human_digest.py   (Phase 6: writes human-digest.md)
```

## Smoke test

```bash
python3 -m py_compile /Users/shakstzy/QUANTUM/_core/skills/icm-audit/scripts/*.py
bash -n /Users/shakstzy/QUANTUM/_core/skills/icm-audit/scripts/heal-loop.sh
launchctl list | grep quantum-icm-audit
```

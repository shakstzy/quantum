#!/usr/bin/env python3
"""
QUANTUM ICM audit. READ-ONLY against /Users/shakstzy/QUANTUM.
Diff-only writes under ~/.quantum/audit/runs/<ISO-ts>/ + ~/.quantum/audit/latest symlink.
Retains last 30 distinct-findings runs.

Per-run artifacts:
  ledger.csv                 every L0/L1/L2/L3 .md with bytes, lines, weighted cost
  ceiling-violations.md      CONTEXT.md > 80 lines, references > 200 lines
  workspace-integrity.md     missing CLAUDE.md, missing raw/<ws>/, leftover {{ placeholders
  em-dash-sweep.md           every em-dash occurrence with file + line
  registry-drift.md          workspaces/ on disk vs root CLAUDE.md tables
  duplicate-candidates.md    byte-identical (whitespace-normalized) 20-line spans across CLAUDE.md
  report.md + report.json    ranked findings (report.json is canonical for diff)

Full doctrine: _core/playbooks/icm-audit/PLAYBOOK.md
"""

import csv
import hashlib
import json
import re
import shutil
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO = Path("/Users/shakstzy/QUANTUM")
OUT_ROOT = Path.home() / ".quantum" / "audit"
LOG_DIR = Path.home() / ".quantum" / "logs"
RETENTION = 30
EM_DASH = "—"


def is_excluded(path: Path) -> bool:
    s = str(path)
    if any(seg in s for seg in (
        "/node_modules/", "/.venv/", "/target/", "/__pycache__/",
        "/.git/", "/raw/", "/graphify-out/",
    )):
        return True
    if "/references/Interpreted-Context-Methdology-main" in s:
        return True
    if re.search(r"/stages/[^/]+/output/", s):
        return True
    return False


def classify(path: Path) -> str:
    rel = path.relative_to(REPO).as_posix()
    if rel == "CLAUDE.md":
        return "L0"
    if re.match(r"^workspaces/[^/]+/CLAUDE\.md$", rel):
        return "L1_workspace_claude"
    if re.match(r"^workspaces/[^/]+/CONTEXT\.md$", rel):
        return "L1_workspace_context"
    if re.match(r"^workspaces/[^/]+/stages/[^/]+/CONTEXT\.md$", rel):
        return "L2_stage_context"
    if path.name == "PLAYBOOK.md":
        return "L3_playbook"
    if path.name == "CONTEXT.md":
        return "L2_other_context"
    if path.name == "CLAUDE.md":
        return "L1_other_claude"
    if any(seg in rel for seg in ("/references/", "/shared/", "/setup/", "/rules/")):
        return "L3_ref"
    return "L3_other"


WEIGHTS = {
    "L0": 10.0,
    "L1_workspace_claude": 3.0,
    "L1_workspace_context": 3.0,
    "L1_other_claude": 1.0,
    "L2_stage_context": 1.0,
    "L2_other_context": 1.0,
    "L3_ref": 0.3,
    "L3_playbook": 0.3,
    "L3_other": 0.1,
}

CEILING = {
    "L1_workspace_context": 80,
    "L2_stage_context": 80,
    "L2_other_context": 80,
    "L3_ref": 200,
}


def collect_md_files() -> list[Path]:
    return [p for p in REPO.rglob("*.md") if not is_excluded(p)]


def step1_ledger(files, out_dir):
    rows = []
    for f in files:
        kind = classify(f)
        try:
            stat = f.stat()
            with open(f, "rb") as fp:
                lines = sum(1 for _ in fp)
        except OSError:
            continue
        weight = WEIGHTS.get(kind, 0)
        rows.append({
            "path": f.relative_to(REPO).as_posix(),
            "kind": kind,
            "bytes": stat.st_size,
            "lines": lines,
            "tier": kind.split("_")[0],
            "tier_weight": weight,
            "weighted_cost": round(weight * stat.st_size, 1),
        })
    rows.sort(key=lambda r: r["weighted_cost"], reverse=True)
    if rows:
        with open(out_dir / "ledger.csv", "w", newline="") as fp:
            w = csv.DictWriter(fp, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    return rows


def step2_ceilings(rows, out_dir):
    violations = []
    for r in rows:
        ceil = CEILING.get(r["kind"])
        if ceil and r["lines"] > ceil:
            violations.append({**r, "ceiling": ceil, "over_by": r["lines"] - ceil})
    violations.sort(key=lambda r: r["weighted_cost"], reverse=True)
    md = ["# Invariant-ceiling violations\n",
          f"\nGenerated: {datetime.now(timezone.utc).isoformat()}\n",
          f"\n{len(violations)} files breach their declared ceiling.\n",
          "\n| Path | Kind | Lines | Ceiling | Over by | Bytes | Weighted cost |\n",
          "|------|------|-------|---------|---------|-------|---------------|\n"]
    for v in violations:
        md.append(
            f"| `{v['path']}` | {v['kind']} | {v['lines']} | {v['ceiling']} | +{v['over_by']} | {v['bytes']} | {v['weighted_cost']:.0f} |\n"
        )
    (out_dir / "ceiling-violations.md").write_text("".join(md))
    return violations


def step3_workspace_integrity(out_dir):
    """For each workspaces/*/: CLAUDE.md present? Ingest? raw/<ws>/ exists? Leftover {{ placeholders?"""
    ws_root = REPO / "workspaces"
    raw_root = REPO / "raw"
    missing_claudemd = []
    missing_raw = []
    placeholder_files = []  # list of (workspace, file_rel, line_no, span)

    if not ws_root.exists():
        (out_dir / "workspace-integrity.md").write_text(
            "# Workspace integrity\n\nNo workspaces/ directory found.\n"
        )
        return [], [], []

    for ws in sorted(p for p in ws_root.iterdir() if p.is_dir()):
        claudemd = ws / "CLAUDE.md"
        if not claudemd.exists():
            missing_claudemd.append(ws.name)
            continue
        try:
            text = claudemd.read_text()
        except OSError:
            missing_claudemd.append(ws.name)
            continue

        is_ingest = bool(re.search(r"^##\s+Ingest\b", text, re.MULTILINE))
        if is_ingest and not (raw_root / ws.name).is_dir():
            missing_raw.append(ws.name)

        for f in ws.rglob("*"):
            if not f.is_file():
                continue
            if is_excluded(f):
                continue
            if f.suffix.lower() not in {".md"}:
                continue
            rel = f.relative_to(REPO).as_posix()
            if rel.endswith("setup/questionnaire.md"):
                continue
            try:
                content = f.read_text(errors="ignore")
            except OSError:
                continue
            for i, line in enumerate(content.splitlines(), 1):
                for m in re.finditer(r"\{\{[A-Z][A-Z0-9_?/]*\}\}", line):
                    placeholder_files.append({
                        "workspace": ws.name,
                        "path": rel,
                        "line": i,
                        "span": m.group(0),
                    })

    md = ["# Workspace integrity\n",
          f"\nGenerated: {datetime.now(timezone.utc).isoformat()}\n\n"]

    md.append("## Missing CLAUDE.md\n\n")
    if missing_claudemd:
        for w in missing_claudemd:
            md.append(f"- `workspaces/{w}/`\n")
    else:
        md.append("None.\n")

    md.append("\n## Ingest workspaces missing `raw/<ws>/` directory\n\n")
    if missing_raw:
        for w in missing_raw:
            md.append(f"- `workspaces/{w}/` declares `## Ingest` but `raw/{w}/` does not exist\n")
    else:
        md.append("None.\n")

    md.append("\n## Leftover `{{...}}` placeholders (Pattern 17 violations)\n\n")
    if placeholder_files:
        for hit in placeholder_files:
            md.append(f"- `{hit['path']}` L{hit['line']}: `{hit['span']}` (workspace: `{hit['workspace']}`)\n")
    else:
        md.append("None.\n")

    (out_dir / "workspace-integrity.md").write_text("".join(md))
    return missing_claudemd, missing_raw, placeholder_files


def step4_em_dash_sweep(out_dir):
    """Em-dash anywhere in workspaces/, _core/, root CLAUDE.md."""
    targets_dirs = [REPO / "workspaces", REPO / "_core"]
    targets_files = [REPO / "CLAUDE.md"]
    hits = []

    candidates = list(targets_files)
    for d in targets_dirs:
        if not d.is_dir():
            continue
        for f in d.rglob("*"):
            if not f.is_file():
                continue
            if is_excluded(f):
                continue
            if f.suffix.lower() not in {".md"}:
                continue
            candidates.append(f)

    for f in candidates:
        try:
            text = f.read_text(errors="ignore")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if EM_DASH in line:
                hits.append({
                    "path": f.relative_to(REPO).as_posix(),
                    "line": i,
                    "snippet": line.strip()[:120],
                })

    md = ["# Em-dash sweep\n",
          f"\nGenerated: {datetime.now(timezone.utc).isoformat()}\n",
          f"\n{len(hits)} occurrences (em dashes are forbidden per CONVENTIONS.md).\n\n"]
    for h in hits:
        md.append(f"- `{h['path']}` L{h['line']}: `{h['snippet']}`\n")
    if not hits:
        md.append("None.\n")
    (out_dir / "em-dash-sweep.md").write_text("".join(md))
    return hits


def step5_registry_drift(out_dir):
    ws_root = REPO / "workspaces"
    real_workspaces = sorted(p.name for p in ws_root.iterdir() if p.is_dir()) if ws_root.exists() else []
    root_claude = REPO / "CLAUDE.md"
    root_text = root_claude.read_text() if root_claude.exists() else ""

    in_index = False
    listed = []
    for line in root_text.splitlines():
        if re.match(r"^##\s+Workspace\s+Index", line.strip()):
            in_index = True
            continue
        if in_index and line.strip().startswith("## "):
            break
        if in_index and "|" in line:
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if cells and re.match(r"^[a-z][a-z0-9-]*$", cells[0]):
                listed.append(cells[0])

    routing_set = set()

    md = ["# Registry drift\n",
          f"\nGenerated: {datetime.now(timezone.utc).isoformat()}\n\n",
          "## Real workspaces on disk\n\n"]
    for w in real_workspaces:
        md.append(f"- `{w}`\n")
    md.append("\n## Workspaces in root CLAUDE.md Workspace Index\n\n")
    for w in listed:
        md.append(f"- `{w}`\n")
    on_disk = set(real_workspaces)
    in_index_set = set(listed)
    missing_from_index = on_disk - in_index_set
    extra_in_index = in_index_set - on_disk
    missing_from_routing = set()

    md.append("\n## Drift\n\n")
    if missing_from_index:
        md.append(f"**On disk but NOT in Workspace Index:** {sorted(missing_from_index)}\n\n")
    if extra_in_index:
        md.append(f"**In Workspace Index but NOT on disk:** {sorted(extra_in_index)}\n\n")
    if not (missing_from_index or extra_in_index):
        md.append("No drift.\n")

    (out_dir / "registry-drift.md").write_text("".join(md))
    return missing_from_index, missing_from_routing, extra_in_index


def normalize_lines(raw_lines):
    out = []
    for ln in raw_lines:
        s = re.sub(r"\s+", " ", ln.strip().lower())
        if s:
            out.append(s)
    return out


def step6_duplicates(out_dir):
    targets = [REPO / "CLAUDE.md"] if (REPO / "CLAUDE.md").exists() else []
    ws_root = REPO / "workspaces"
    if ws_root.exists():
        for w in ws_root.iterdir():
            c = w / "CLAUDE.md"
            if c.exists():
                targets.append(c)

    SPAN = 20
    spans = defaultdict(list)
    for t in targets:
        try:
            raw = t.read_text().splitlines()
        except OSError:
            continue
        norm = normalize_lines(raw)
        for i in range(len(norm) - SPAN + 1):
            block = "\n".join(norm[i: i + SPAN])
            h = hashlib.sha256(block.encode()).hexdigest()[:16]
            spans[h].append((t.relative_to(REPO).as_posix(), i + 1))

    multi = {h: locs for h, locs in spans.items() if len({l[0] for l in locs}) >= 2}

    md = ["# Byte-identical duplicate candidates (informational)\n",
          f"\nGenerated: {datetime.now(timezone.utc).isoformat()}\n",
          f"\nWindow: {SPAN}-line normalized spans across CLAUDE.md files only.\n",
          f"\n{len(targets)} CLAUDE.md files scanned. {len(multi)} cross-file duplicate spans found.\n"]

    if multi:
        groups = sorted(multi.items(), key=lambda kv: len({l[0] for l in kv[1]}), reverse=True)
        md.append("\n## Spans appearing in 3+ files\n\n")
        any_3plus = False
        for h, locs in groups:
            unique_files = sorted({l[0] for l in locs})
            if len(unique_files) < 3:
                continue
            any_3plus = True
            md.append(f"\n### Span `{h}` ({len(unique_files)} files)\n\n")
            for f in unique_files:
                starts = sorted([l[1] for l in locs if l[0] == f])
                md.append(f"- `{f}` at lines {starts}\n")
        if not any_3plus:
            md.append("None.\n")

        md.append("\n## Spans appearing in exactly 2 files\n\n")
        for h, locs in groups:
            unique_files = sorted({l[0] for l in locs})
            if len(unique_files) != 2:
                continue
            md.append(f"\n### Span `{h}`\n\n")
            for f in unique_files:
                starts = sorted([l[1] for l in locs if l[0] == f])
                md.append(f"- `{f}` at lines {starts}\n")
    else:
        md.append("\nNo cross-file duplicates at this window size.\n")

    (out_dir / "duplicate-candidates.md").write_text("".join(md))
    return multi


def step7_report(rows, ceiling, integrity, em_dashes, drift, dups, out_dir):
    missing_claudemd, missing_raw, placeholders = integrity
    missing_index, missing_routing, extra_index = drift
    findings = []
    fid = 0

    for w in sorted(missing_claudemd):
        fid += 1
        findings.append({
            "id": f"F{fid:03d}", "severity": "critical", "rule": "missing_workspace_claudemd",
            "path": f"workspaces/{w}/", "observed": "no CLAUDE.md",
            "expected": "workspaces/<name>/CLAUDE.md (Layer 1)",
            "weighted_cost": 0,
        })
    for w in sorted(missing_raw):
        fid += 1
        findings.append({
            "id": f"F{fid:03d}", "severity": "critical", "rule": "missing_raw_folder",
            "path": f"raw/{w}/", "observed": "ingest workspace declared, raw/ folder absent",
            "expected": f"raw/{w}/ directory exists",
            "weighted_cost": 0,
        })
    for hit in placeholders:
        fid += 1
        findings.append({
            "id": f"F{fid:03d}", "severity": "critical", "rule": "leftover_placeholder",
            "path": f"{hit['path']}:L{hit['line']}",
            "observed": hit["span"],
            "expected": "0 placeholders (Pattern 17: setup must complete before scaffold persists)",
            "weighted_cost": 0,
        })

    for w in sorted(missing_index):
        fid += 1
        findings.append({
            "id": f"F{fid:03d}", "severity": "critical", "rule": "registry_drift_index",
            "path": f"workspaces/{w}/", "observed": "on disk",
            "expected": "row in root CLAUDE.md Workspace Index",
            "weighted_cost": 0,
        })
    for w in sorted(missing_routing):
        fid += 1
        findings.append({
            "id": f"F{fid:03d}", "severity": "warning", "rule": "registry_drift_routing",
            "path": f"workspaces/{w}/", "observed": "on disk",
            "expected": "row in root CLAUDE.md Routing table",
            "weighted_cost": 0,
        })
    for w in sorted(extra_index):
        fid += 1
        findings.append({
            "id": f"F{fid:03d}", "severity": "critical", "rule": "registry_drift_phantom",
            "path": f"(index entry: {w})", "observed": "in root CLAUDE.md Workspace Index",
            "expected": "directory under workspaces/",
            "weighted_cost": 0,
        })

    for v in ceiling:
        fid += 1
        findings.append({
            "id": f"F{fid:03d}", "severity": "warning",
            "rule": f"ceiling_{v['kind']}",
            "path": v["path"], "observed": f"{v['lines']} lines",
            "expected": f"<= {v['ceiling']} lines",
            "weighted_cost": v["weighted_cost"],
        })

    for h in em_dashes:
        fid += 1
        findings.append({
            "id": f"F{fid:03d}", "severity": "warning", "rule": "em_dash",
            "path": f"{h['path']}:L{h['line']}", "observed": "em dash present",
            "expected": "no em dashes (CONVENTIONS.md Naming)",
            "weighted_cost": 0,
        })

    triplet_dups = sum(1 for h, locs in dups.items() if len({l[0] for l in locs}) >= 3)
    if triplet_dups:
        fid += 1
        findings.append({
            "id": f"F{fid:03d}", "severity": "info", "rule": "duplicate_spans_3plus",
            "path": "(see duplicate-candidates.md)",
            "observed": f"{triplet_dups} 20-line spans in 3+ CLAUDE.md files",
            "expected": "0 (canonical sources)",
            "weighted_cost": 0,
        })

    with open(out_dir / "report.json", "w") as fp:
        json.dump({"generated": datetime.now(timezone.utc).isoformat(), "findings": findings}, fp, indent=2)

    crit = [f for f in findings if f["severity"] == "critical"]
    warn = [f for f in findings if f["severity"] == "warning"]
    info = [f for f in findings if f["severity"] == "info"]

    md = ["# QUANTUM ICM Audit Report\n",
          f"\nGenerated: {datetime.now(timezone.utc).isoformat()}\n",
          f"\nTotal markdown files scanned: {len(rows)}\n",
          f"\nFindings: {len(findings)} ({len(crit)} critical, {len(warn)} warning, {len(info)} info)\n\n",
          f"## Critical: {len(crit)}\n\n"]
    if crit:
        for f in crit:
            md.append(f"- **{f['id']}** `{f['rule']}`: `{f['path']}` (observed: {f['observed']}; expected: {f['expected']})\n")
    else:
        md.append("None.\n")

    md.append(f"\n## Warning: {len(warn)}\n\n")
    if warn:
        md.append("Sorted by weighted_cost.\n\n")
        md.append("| ID | Rule | Path | Observed | Expected | Cost |\n")
        md.append("|----|------|------|----------|----------|------|\n")
        for f in sorted(warn, key=lambda x: x.get("weighted_cost", 0), reverse=True):
            md.append(f"| {f['id']} | {f['rule']} | `{f['path']}` | {f['observed']} | {f['expected']} | {f.get('weighted_cost', 0):.0f} |\n")
    else:
        md.append("None.\n")

    md.append(f"\n## Info: {len(info)}\n\n")
    if info:
        for f in info:
            md.append(f"- **{f['id']}** `{f['rule']}`: {f['observed']}\n")
    else:
        md.append("None.\n")

    md.append("\n## Top 15 by total context cost (informational)\n\n")
    md.append("| Path | Kind | Lines | Bytes | Cost |\n|------|------|-------|-------|------|\n")
    for r in rows[:15]:
        md.append(f"| `{r['path']}` | {r['kind']} | {r['lines']} | {r['bytes']} | {r['weighted_cost']:.0f} |\n")

    (out_dir / "report.md").write_text("".join(md))
    return findings


def findings_hash(findings):
    """Deterministic hash of findings, generated-timestamp excluded."""
    blob = json.dumps(findings, sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()


def prune_old_runs():
    runs_dir = OUT_ROOT / "runs"
    if not runs_dir.exists():
        return
    all_runs = sorted([p for p in runs_dir.iterdir() if p.is_dir()], reverse=True)
    for old in all_runs[RETENTION:]:
        try:
            shutil.rmtree(old)
            print(f"  pruned old run: {old.name}")
        except OSError as e:
            print(f"  prune failed for {old.name}: {e}", file=sys.stderr)


def main():
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    tmp = Path(tempfile.mkdtemp(prefix="quantum-icm-audit-"))

    try:
        files = collect_md_files()
        rows = step1_ledger(files, tmp)
        ceiling = step2_ceilings(rows, tmp)
        integrity = step3_workspace_integrity(tmp)
        em_dashes = step4_em_dash_sweep(tmp)
        drift = step5_registry_drift(tmp)
        dups = step6_duplicates(tmp)
        findings = step7_report(rows, ceiling, integrity, em_dashes, drift, dups, tmp)

        new_hash = findings_hash(findings)
        latest = OUT_ROOT / "latest"
        old_hash = None
        if latest.exists():
            try:
                prev = json.loads((latest / "report.json").read_text())
                old_hash = findings_hash(prev["findings"])
            except (OSError, json.JSONDecodeError, KeyError):
                old_hash = None

        if old_hash == new_hash:
            target = latest.resolve().name if latest.exists() else "(none)"
            print(f"[{ts}] no findings change (hash={new_hash[:12]}, last={target}); skipping write")
            shutil.rmtree(tmp)
            return 0

        out_dir = OUT_ROOT / "runs" / ts
        out_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(tmp), str(out_dir))

        if latest.exists() or latest.is_symlink():
            latest.unlink()
        latest.symlink_to(out_dir)

        crit = sum(1 for f in findings if f["severity"] == "critical")
        warn = sum(1 for f in findings if f["severity"] == "warning")
        print(f"[{ts}] findings changed (hash={new_hash[:12]}); wrote {out_dir}")
        print(f"  {len(files)} md scanned; {crit} critical, {warn} warning")
        prune_old_runs()
        return 0
    except Exception as e:
        print(f"[{ts}] audit failed: {e}", file=sys.stderr)
        try:
            shutil.rmtree(tmp)
        except OSError:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())

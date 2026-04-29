#!/usr/bin/env python3
"""
QUANTUM ICM heal-loop triage.

Reads an audit run's report.json and classifies each finding into one of:
  - auto_fix_em_dash    (deterministic, region-aware: skip code+frontmatter)
  - external_review     (ceiling, duplicate spans, registry-drift index)
  - human_only          (missing CLAUDE.md, missing raw, leftover placeholder, registry-drift phantom)

Findings already decided in ~/.quantum/audit/decisions/<key>.json are skipped
unless rule_version advanced.

Output: JSON to --out (or stdout) with the buckets:
{
  "rule_version": 1,
  "report_path": "...",
  "auto_fix_em_dash": [findings],
  "external_review": [findings],
  "human_only": [findings],
  "skipped_already_decided": [findings]
}
"""

import argparse
import json
import sys
from pathlib import Path

DECISIONS_DIR_DEFAULT = Path.home() / ".quantum" / "audit" / "decisions"

CLASSIFY = {
    # auto_fix_em_dash
    "em_dash": "auto_fix_em_dash",
    # external_review (LLMs decide; v1 is recommendation-only)
    "ceiling_L1_workspace_context": "external_review",
    "ceiling_L2_stage_context": "external_review",
    "ceiling_L2_other_context": "external_review",
    "ceiling_L3_ref": "external_review",
    "duplicate_spans_3plus": "external_review",
    "registry_drift_index": "external_review",
    # human_only (require interactive input or new file authoring)
    "missing_workspace_claudemd": "human_only",
    "missing_raw_folder": "human_only",
    "leftover_placeholder": "human_only",
    "registry_drift_phantom": "human_only",
}


def load_decision(decisions_dir: Path, key: str, rule_version: int):
    p = decisions_dir / f"{key}.json"
    if not p.exists():
        return None
    try:
        d = json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if d.get("rule_version") != rule_version:
        return None  # stale; re-evaluate
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True, help="path to audit report.json")
    ap.add_argument("--decisions", default=str(DECISIONS_DIR_DEFAULT))
    ap.add_argument("--out", default="-", help="output JSON path or '-' for stdout")
    args = ap.parse_args()

    report_path = Path(args.report)
    if not report_path.exists():
        print(f"report.json not found: {report_path}", file=sys.stderr)
        return 1

    report = json.loads(report_path.read_text())
    rule_version = report.get("rule_version", 1)
    findings = report.get("findings", [])

    decisions_dir = Path(args.decisions)
    decisions_dir.mkdir(parents=True, exist_ok=True)

    buckets = {
        "auto_fix_em_dash": [],
        "external_review": [],
        "human_only": [],
        "skipped_already_decided": [],
    }

    for f in findings:
        key = f.get("key")
        if key:
            decided = load_decision(decisions_dir, key, rule_version)
            if decided is not None:
                buckets["skipped_already_decided"].append({**f, "decision": decided})
                continue

        rule = f.get("rule", "")
        bucket = CLASSIFY.get(rule, "human_only")  # unknown rules default to human
        buckets[bucket].append(f)

    out = {
        "rule_version": rule_version,
        "report_path": str(report_path),
        "report_run_dir": str(report_path.parent),
        **buckets,
        "summary": {k: len(v) for k, v in buckets.items()},
    }

    text = json.dumps(out, indent=2)
    if args.out == "-":
        print(text)
    else:
        Path(args.out).write_text(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
QUANTUM ICM heal-loop human digest.

Writes a single markdown file to ~/.quantum/audit/human-digest.md summarizing
findings that require human action: missing CLAUDE.mds, missing raw folders,
leftover placeholders, registry-drift phantoms, plus external-review
recommendations from the latest tick.

Idempotent. Overwrites the digest each run with the current snapshot.
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

OUT = Path.home() / ".quantum" / "audit" / "human-digest.md"
EXTERNAL_REVIEW_ROOT = Path.home() / ".quantum" / "audit" / "external-review"


def latest_external_review_dir() -> Path | None:
    if not EXTERNAL_REVIEW_ROOT.exists():
        return None
    runs = [p for p in EXTERNAL_REVIEW_ROOT.iterdir() if p.is_dir()]
    if not runs:
        return None
    return max(runs, key=lambda p: p.name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--triage", required=True)
    args = ap.parse_args()

    triage = json.loads(Path(args.triage).read_text())
    human = triage.get("human_only", [])
    external = triage.get("external_review", [])
    skipped = triage.get("skipped_already_decided", [])

    md = ["# ICM Human Digest\n",
          f"\nGenerated: {datetime.now(timezone.utc).isoformat()}\n",
          f"\nThis is the heal-loop's overflow: items it cannot fix automatically. Read top-down.\n\n"]

    md.append(f"## Human-only findings: {len(human)}\n\n")
    md.append("These need you (Adithya) to act. Heal-loop will never auto-fix them.\n\n")
    if human:
        by_rule: dict[str, list[dict]] = {}
        for f in human:
            by_rule.setdefault(f.get("rule", "unknown"), []).append(f)
        for rule, fs in sorted(by_rule.items()):
            md.append(f"### {rule} ({len(fs)})\n\n")
            for f in fs[:25]:
                md.append(f"- `{f.get('path')}` (observed: {f.get('observed')})\n")
            if len(fs) > 25:
                md.append(f"- ...and {len(fs) - 25} more\n")
            md.append("\n")
    else:
        md.append("None.\n\n")

    md.append(f"## External-review (recommendations only, NOT applied): {len(external)}\n\n")
    er_dir = latest_external_review_dir()
    if er_dir is not None:
        md.append(f"Latest review run: `{er_dir.relative_to(Path.home())}`\n\n")
        for finding_dir in sorted(er_dir.iterdir()):
            if not finding_dir.is_dir():
                continue
            synth_path = finding_dir / "synthesis.json"
            if not synth_path.exists():
                continue
            try:
                synth = json.loads(synth_path.read_text())
            except json.JSONDecodeError:
                continue
            f = synth.get("finding", {})
            md.append(
                f"- **{finding_dir.name}** `{f.get('rule')}` `{f.get('path')}` "
                f"-- agreement: {synth.get('agreement')}; {synth.get('summary')}\n"
            )
        md.append("\n")
    else:
        md.append("No external review run yet.\n\n")

    md.append(f"## Skipped (already decided in prior tick): {len(skipped)}\n\n")
    if skipped:
        md.append(f"{len(skipped)} findings short-circuited. See `~/.quantum/audit/decisions/`.\n\n")
    else:
        md.append("None.\n\n")

    md.append("---\n\nRun `python3 _core/skills/icm-audit/scripts/audit.py` for the latest raw report.\n")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("".join(md))
    print(f"human-digest: wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

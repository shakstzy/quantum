#!/usr/bin/env python3
"""
QUANTUM ICM heal-loop external review (RECOMMENDATION-ONLY in v1).

For each external_review finding from triage, query Codex and Gemini in parallel
with a structured-JSON prompt. Capture both responses. Write per-finding
synthesis to ~/.quantum/audit/external-review/<run-ts>/<finding-id>/.

v1 does NOT auto-apply. Recommendations land in the human digest.

Per-finding cost cap: hard 60s timeout per CLI. Per-tick: max 5 findings.
"""

import argparse
import concurrent.futures
import csv
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path("/Users/shakstzy/QUANTUM")
OUT_ROOT = Path.home() / ".quantum" / "audit" / "external-review"
COST_LEDGER = Path.home() / ".quantum" / "audit" / "cost-ledger.csv"
DECISIONS_DIR = Path.home() / ".quantum" / "audit" / "decisions"

CLI_TIMEOUT_SEC = 60
PER_TICK_CAP = 5

JSON_SCHEMA_HINT = """
Reply with ONLY a single JSON object on stdout, no prose, matching this schema:

{
  "decision": "fix" | "human" | "wontfix",
  "paths": ["string"],          // files the fix touches; relative to repo root
  "rationale": "string",        // one paragraph
  "unified_diff": "string",     // git unified diff or "" if decision != "fix"
  "confidence": 0.0..1.0,
  "requires_human": true | false
}
"""


def repo_slice(rel_path: str, around_line: int | None = None, max_lines: int = 200) -> str:
    p = REPO / rel_path
    if not p.exists() or p.is_symlink():
        return f"(file missing or symlink: {rel_path})"
    try:
        lines = p.read_text(errors="ignore").splitlines()
    except OSError:
        return f"(unreadable: {rel_path})"
    if around_line is None:
        return "\n".join(lines[:max_lines])
    start = max(0, around_line - max_lines // 2)
    end = min(len(lines), start + max_lines)
    return "\n".join(lines[start:end])


def parse_finding_path(p: str) -> tuple[str, int | None]:
    m = re.match(r"^(.+?):L(\d+)$", p)
    if m:
        return m.group(1), int(m.group(2))
    return p, None


def build_prompt(finding: dict, conventions_excerpt: str) -> str:
    rel, lineno = parse_finding_path(finding.get("path", ""))
    file_slice = repo_slice(rel, lineno)
    return (
        "You are reviewing a single ICM audit finding from QUANTUM, a personal life-OS.\n"
        f"Audit rule: {finding.get('rule')}\n"
        f"Severity: {finding.get('severity')}\n"
        f"Path: {finding.get('path')}\n"
        f"Observed: {finding.get('observed')}\n"
        f"Expected: {finding.get('expected')}\n\n"
        "Excerpt of the file (may be truncated):\n"
        "```\n"
        f"{file_slice}\n"
        "```\n\n"
        "Applicable conventions excerpt:\n"
        "```\n"
        f"{conventions_excerpt[:4000]}\n"
        "```\n\n"
        "Make a determination: fix it, mark for human, or wontfix.\n"
        f"{JSON_SCHEMA_HINT}\n"
    )


def run_codex(prompt: str) -> tuple[str, str]:
    """Returns (status, raw_text)."""
    try:
        res = subprocess.run(
            ["codex", "exec", "--skip-git-repo-check", "-"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=CLI_TIMEOUT_SEC,
        )
        return ("ok", res.stdout) if res.returncode == 0 else ("nonzero", res.stdout + res.stderr)
    except subprocess.TimeoutExpired:
        return ("timeout", "")
    except FileNotFoundError:
        return ("missing", "codex CLI not found")


def run_gemini(prompt: str) -> tuple[str, str]:
    try:
        res = subprocess.run(
            ["gemini", "-p", prompt, "--approval-mode", "plan"],
            capture_output=True,
            text=True,
            timeout=CLI_TIMEOUT_SEC,
        )
        return ("ok", res.stdout) if res.returncode == 0 else ("nonzero", res.stdout + res.stderr)
    except subprocess.TimeoutExpired:
        return ("timeout", "")
    except FileNotFoundError:
        return ("missing", "gemini CLI not found")


def extract_json(text: str) -> dict | None:
    if not text:
        return None
    # try full parse first
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        pass
    # find a JSON object in the text
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    return None


def synthesize(codex_obj: dict | None, gemini_obj: dict | None) -> dict:
    """v1: descriptive, not prescriptive. We do NOT auto-apply."""
    s = {
        "v1_auto_apply": False,
        "agreement": "unknown",
        "summary": "",
    }
    if codex_obj is None and gemini_obj is None:
        s["agreement"] = "neither_responded"
        s["summary"] = "Both reviewers failed to produce JSON. Defer to human."
        return s
    if codex_obj is None:
        s["agreement"] = "codex_failed"
        s["summary"] = f"Only Gemini responded (decision={gemini_obj.get('decision')}, conf={gemini_obj.get('confidence')})"
        return s
    if gemini_obj is None:
        s["agreement"] = "gemini_failed"
        s["summary"] = f"Only Codex responded (decision={codex_obj.get('decision')}, conf={codex_obj.get('confidence')})"
        return s
    same_decision = codex_obj.get("decision") == gemini_obj.get("decision")
    s["agreement"] = "unanimous" if same_decision else "split"
    s["summary"] = (
        f"Codex: {codex_obj.get('decision')} (conf={codex_obj.get('confidence')}). "
        f"Gemini: {gemini_obj.get('decision')} (conf={gemini_obj.get('confidence')})."
    )
    return s


def append_cost_ledger(rows: list[dict]):
    COST_LEDGER.parent.mkdir(parents=True, exist_ok=True)
    new_file = not COST_LEDGER.exists()
    with open(COST_LEDGER, "a", newline="") as fp:
        w = csv.DictWriter(fp, fieldnames=["ts", "finding_key", "rule", "codex_status", "gemini_status"])
        if new_file:
            w.writeheader()
        for r in rows:
            w.writerow(r)


def write_decision(key: str, finding: dict, decision: str, rule_version: int, **extras):
    DECISIONS_DIR.mkdir(parents=True, exist_ok=True)
    path = DECISIONS_DIR / f"{key}.json"
    now = datetime.now(timezone.utc).isoformat()
    record = {
        "key": key,
        "rule_version": rule_version,
        "type": finding.get("rule"),
        "path": finding.get("path"),
        "decision": decision,
        "first_seen_ts": now,
        "last_decided_ts": now,
        **extras,
    }
    path.write_text(json.dumps(record, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--triage", required=True)
    ap.add_argument("--cap", type=int, default=PER_TICK_CAP)
    args = ap.parse_args()

    triage = json.loads(Path(args.triage).read_text())
    findings = triage.get("external_review", [])[: args.cap]
    rule_version = triage.get("rule_version", 1)

    if not findings:
        print("external-review: no findings to review")
        return 0

    conv_path = REPO / "_core" / "CONVENTIONS.md"
    conventions = conv_path.read_text() if conv_path.exists() else ""

    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    out_root = OUT_ROOT / ts
    out_root.mkdir(parents=True, exist_ok=True)

    cost_rows = []

    for finding in findings:
        fid = finding.get("id", "F???")
        out_dir = out_root / fid
        out_dir.mkdir(parents=True, exist_ok=True)

        prompt = build_prompt(finding, conventions)
        (out_dir / "prompt.txt").write_text(prompt)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            f_codex = pool.submit(run_codex, prompt)
            f_gemini = pool.submit(run_gemini, prompt)
            codex_status, codex_raw = f_codex.result()
            gemini_status, gemini_raw = f_gemini.result()

        (out_dir / "codex.txt").write_text(codex_raw)
        (out_dir / "gemini.txt").write_text(gemini_raw)
        codex_obj = extract_json(codex_raw)
        gemini_obj = extract_json(gemini_raw)
        if codex_obj is not None:
            (out_dir / "codex.json").write_text(json.dumps(codex_obj, indent=2))
        if gemini_obj is not None:
            (out_dir / "gemini.json").write_text(json.dumps(gemini_obj, indent=2))

        synth = synthesize(codex_obj, gemini_obj)
        synth["finding"] = finding
        synth["codex_status"] = codex_status
        synth["gemini_status"] = gemini_status
        (out_dir / "synthesis.json").write_text(json.dumps(synth, indent=2))

        cost_rows.append({
            "ts": ts,
            "finding_key": finding.get("key"),
            "rule": finding.get("rule"),
            "codex_status": codex_status,
            "gemini_status": gemini_status,
        })

        # mark as reviewed but not applied (v1 is recommendation-only)
        write_decision(
            finding["key"], finding, "external-reviewed-not-applied", rule_version,
            review_pointer=str(out_dir.relative_to(Path.home() / ".quantum")),
            agreement=synth["agreement"],
            codex_status=codex_status,
            gemini_status=gemini_status,
        )

        print(f"  reviewed {fid} ({finding.get('rule')}) -> {synth['agreement']}")

    append_cost_ledger(cost_rows)
    print(f"external-review: {len(findings)} findings reviewed; outputs at {out_root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

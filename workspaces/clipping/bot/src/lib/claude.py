"""Wrapper for invoking Claude via the `claude -p` CLI (uses Adithya's subscription).

Avoids ANTHROPIC_API_KEY env var. The `claude` binary is the Claude Code CLI installed globally.
For LLM ranking, extraction, and second-opinion calls inside the pipeline.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path


def claude_p(prompt: str, system: str | None = None, model: str = "sonnet",
             timeout_s: int = 120) -> str:
    """Run `claude -p` headlessly. Returns stdout as plain text."""
    cmd = ["claude", "-p", prompt, "--model", model]
    if system:
        cmd.extend(["--append-system-prompt", system])
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p failed (rc={proc.returncode}): {proc.stderr.strip()}")
    return proc.stdout.strip()


def claude_json(prompt: str, system: str | None = None, model: str = "sonnet",
                timeout_s: int = 120) -> dict | list:
    """Run claude -p, parse stdout as JSON. Tolerates fenced code blocks."""
    raw = claude_p(prompt, system=system, model=model, timeout_s=timeout_s)
    raw = raw.strip()
    if raw.startswith("```"):
        lines = raw.splitlines()
        lines = [l for l in lines if not l.startswith("```")]
        raw = "\n".join(lines).strip()
    return json.loads(raw)


def load_prompt(name: str) -> str:
    """Load `shared/prompts/<name>.md` as a string."""
    p = Path(__file__).resolve().parents[3] / "shared" / "prompts" / f"{name}.md"
    return p.read_text()

"""Cloud LLM dispatcher (Python). Mirrors scripts/cycle.mjs.

Default engine: Gemini Pro vision via the `gemini` CLI, cycling 3 cached accounts.
On quota errors: rotate creds; on all gemini exhausted: fall through to `claude -p`
with sonnet.

Consumers (instagram-summary, future) import this instead of duplicating the
CLI invocation + retry logic.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path

QUANTUM_ROOT = Path("/Users/shakstzy/QUANTUM")
# Staging lives inside the skill itself (NOT raw/, NOT a dot-folder) so gemini's
# workspace sandbox accepts the staged image files. Two filters apply:
#   1) raw/* is gitignored — gemini skips gitignored paths at file-read time
#   2) .dot-folders are excluded by gemini's default ignore policy
# Both must be cleared.
STAGING_DIR = QUANTUM_ROOT / "_core" / "skills" / "cloud-llm" / "staging"
GEMINI_ACCOUNTS_DIR = Path.home() / ".gemini" / "accounts"
GEMINI_ACTIVE_CREDS = Path.home() / ".gemini" / "oauth_creds.json"
GEMINI_PRO_MODEL = "gemini-3-pro-preview"

QUOTA_RE = re.compile(r"(429|exhausted|quota|rate.?limit)", re.IGNORECASE)


class CloudLLMUnreachable(RuntimeError):
    """Both gemini cycle and claude fallback failed. Caller should halt loud."""


def _list_gemini_accounts() -> list[str]:
    if not GEMINI_ACCOUNTS_DIR.exists():
        return []
    return [p.stem for p in sorted(GEMINI_ACCOUNTS_DIR.glob("*.json"))]


def _rotate_gemini_account(email: str) -> None:
    src = GEMINI_ACCOUNTS_DIR / f"{email}.json"
    shutil.copy2(src, GEMINI_ACTIVE_CREDS)


def _stage_images(abs_paths: list[Path]) -> tuple[Path, list[str]]:
    """Copy images into raw/.cloud-llm-staging/<runId>/ if outside QUANTUM_ROOT.
    Returns (stage_dir, list_of_paths_relative_to_QUANTUM_ROOT).
    """
    run_id = uuid.uuid4().hex[:8]
    stage = STAGING_DIR / run_id
    stage.mkdir(parents=True, exist_ok=True)
    rel_paths = []
    for i, src in enumerate(abs_paths):
        src = Path(src).resolve()
        try:
            rel = src.relative_to(QUANTUM_ROOT)
            rel_paths.append(str(rel))
        except ValueError:
            ext = src.suffix or ".jpg"
            target = stage / f"img-{i}{ext}"
            shutil.copy2(src, target)
            rel_paths.append(str(target.relative_to(QUANTUM_ROOT)))
    return stage, rel_paths


def _cleanup_stage(stage: Path) -> None:
    try:
        shutil.rmtree(stage, ignore_errors=True)
    except Exception:
        pass


def _run_gemini(prompt: str, image_refs: list[str], use_flash: bool = False) -> str:
    full_prompt = prompt
    if image_refs:
        full_prompt = prompt + "\n\n" + "\n".join(f"@{r}" for r in image_refs)
    args = ["gemini", "-p", full_prompt, "-o", "text"]
    if not use_flash:
        args[1:1] = ["-m", GEMINI_PRO_MODEL]
    proc = subprocess.run(
        args,
        cwd=str(QUANTUM_ROOT),
        capture_output=True,
        text=True,
        timeout=180,
    )
    stderr = proc.stderr or ""
    stdout = proc.stdout or ""
    # gemini CLI exits 0 on 429 (logs to stderr only). Detect quota in stderr
    # regardless of exit code so the outer cycle can rotate accounts.
    if QUOTA_RE.search(stderr):
        raise RuntimeError(f"gemini 429: {stderr[:300]}")
    if proc.returncode != 0:
        raise RuntimeError(f"gemini exit={proc.returncode}: {stderr[:400]}")
    trimmed = stdout.strip()
    if not trimmed:
        raise RuntimeError(f"gemini returned empty output. stderr={stderr[:300]}")
    # Detect agentic chatter (CLI couldn't access file, emits internal reasoning)
    looks_agentic = bool(re.match(r"^(I will|I am|I'll|I need to|I'd|Let me|Looking at|I notice)", trimmed, re.IGNORECASE))
    has_bullets = bool(re.search(r"^[-*]\s+\w+:", trimmed, re.MULTILINE))
    if looks_agentic and not has_bullets:
        raise RuntimeError(f"gemini returned agentic chatter (likely ignored file): {trimmed[:200]}")
    return trimmed


def _run_claude(prompt: str, abs_paths: list[Path]) -> str:
    full_prompt = prompt
    if abs_paths:
        full_prompt = prompt + "\n\n" + "\n".join(str(p) for p in abs_paths)
    proc = subprocess.run(
        ["claude", "-p", full_prompt, "--model", "sonnet"],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude exit={proc.returncode}: {proc.stderr[:400]}")
    return proc.stdout.strip()


def _try_gemini_cycle(prompt: str, image_refs: list[str]) -> dict:
    accounts = _list_gemini_accounts()
    if not accounts:
        raise CloudLLMUnreachable("no gemini accounts cached at ~/.gemini/accounts/")
    errors = []
    for account in accounts:
        _rotate_gemini_account(account)
        for use_flash in (False, True):
            try:
                output = _run_gemini(prompt, image_refs, use_flash=use_flash)
                return {"engine": "gemini-flash" if use_flash else "gemini-pro", "account": account, "output": output}
            except Exception as e:
                msg = str(e)
                errors.append(f"{account}/{'flash' if use_flash else 'pro'}: {msg[:200]}")
                if not QUOTA_RE.search(msg):
                    raise CloudLLMUnreachable(f"gemini call failed (non-quota): {msg[:400]}") from e
    raise CloudLLMUnreachable("all gemini accounts exhausted:\n" + "\n".join(errors))


def describe_images(abs_paths: list[str | Path], prompt: str) -> dict:
    """Cloud vision call. Returns dict {engine, account, output}.

    Default engine cycle: gemini Pro across all accounts → gemini Flash → claude sonnet.
    Raises CloudLLMUnreachable if everything fails.
    """
    if not abs_paths:
        raise ValueError("describe_images: abs_paths must be non-empty")
    paths = [Path(p) for p in abs_paths]
    stage, image_refs = _stage_images(paths)
    try:
        try:
            return _try_gemini_cycle(prompt, image_refs)
        except CloudLLMUnreachable as gemini_err:
            try:
                output = _run_claude(prompt, paths)
                return {"engine": "claude-sonnet", "account": None, "output": output}
            except Exception as claude_err:
                raise CloudLLMUnreachable(
                    f"both engines failed.\nGemini: {gemini_err}\nClaude: {claude_err}"
                ) from claude_err
    finally:
        _cleanup_stage(stage)


def ask_text(prompt: str) -> dict:
    """Text-only cloud call. Same fallback chain, no image staging."""
    try:
        return _try_gemini_cycle(prompt, [])
    except CloudLLMUnreachable as gemini_err:
        try:
            output = _run_claude(prompt, [])
            return {"engine": "claude-sonnet", "account": None, "output": output}
        except Exception as claude_err:
            raise CloudLLMUnreachable(
                f"both engines failed.\nGemini: {gemini_err}\nClaude: {claude_err}"
            ) from claude_err

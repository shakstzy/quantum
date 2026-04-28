"""Single source of truth for the QUANTUM local-llm daemon.

Other QUANTUM skills (instagram-summary, future workspaces) MUST import from
this module instead of hardcoding the URL, port, or model name. If the daemon
shape changes (port, host, model, payload), edit this file once and every
consumer auto-fixes.

Skill contract: see SKILL.md in this directory.
"""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from pathlib import Path

URL = "http://127.0.0.1:8765/v1/chat/completions"
HEALTH_URL = "http://127.0.0.1:8765/health"
MODEL = "unsloth/gemma-4-26b-a4b-it-UD-MLX-4bit"

DEFAULT_TIMEOUT = 180

UNREACHABLE_HINT = (
    "Ensure the shared local-llm skill is installed and running:\n"
    "  bash /Users/shakstzy/QUANTUM/_core/skills/local-llm/scripts/status.sh\n"
    "If not installed:\n"
    "  bash /Users/shakstzy/QUANTUM/_core/skills/local-llm/scripts/install.sh"
)


class LocalLLMUnreachable(RuntimeError):
    """Daemon not reachable. Caller should surface UNREACHABLE_HINT to the user."""


def image_block(path: str | Path, mime: str = "image/jpeg") -> dict:
    """Build an OpenAI-shaped image_url content block from a local file."""
    b64 = base64.b64encode(Path(path).read_bytes()).decode()
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}


def chat(
    messages: list[dict],
    *,
    max_tokens: int = 512,
    temperature: float = 0.3,
    timeout: int = DEFAULT_TIMEOUT,
    model: str = MODEL,
) -> str:
    """POST to the local Gemma daemon and return the assistant text.

    `messages` is the OpenAI-shaped list. For vision, build content blocks via
    `image_block(path)` and combine with `{"type": "text", "text": "..."}`.
    Raises `LocalLLMUnreachable` on connection failure.
    """
    payload = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }).encode()
    req = urllib.request.Request(
        URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
    except urllib.error.URLError as e:
        raise LocalLLMUnreachable(f"local-llm server unreachable at {URL}: {e}") from e
    return data["choices"][0]["message"]["content"]

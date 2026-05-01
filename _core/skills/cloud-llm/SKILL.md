---
name: cloud-llm
description: Hit Gemini (cycled across Adithya's 3+ accounts) and Sonnet (claude -p) as a single dispatch point for cloud LLM calls — text or vision. Default engine is Gemini Pro vision via the gemini CLI; on 429/quota errors, rotate to the next cached account; if all gemini accounts exhausted, fall through to claude -p sonnet. Use this instead of hitting the CLIs directly so cycling, fallback, and fail-loud semantics are all in one place. Replaces the local-llm skill for consumers that need cloud quality (instagram-summary, tinder-visualize).
allowed-tools: Bash
---

# cloud-llm

Single point of entry for cloud LLM calls (Gemini + Sonnet) with account cycling and engine fallback. Other QUANTUM skills/workspaces (`instagram-summary`, `tinder-visualize`, future) consume this instead of duplicating the CLI invocation + retry logic.

## Why this exists

- Adithya pays for **Max + Gemini Ultra (4 accounts) + ChatGPT plan**. None of these should get drained.
- For one-off cloud work (Tinder visual ingest = ~700 calls), spreading across accounts means no single weekly cap eats it.
- The cycling pattern was previously inline in scattered places. This skill makes it the shared default.

## Engines

| engine | invocation | strengths | weaknesses |
|---|---|---|---|
| **gemini Pro vision** (default) | `gemini -m gemini-3-pro-preview -p "..." -o text` (cwd matters: image paths must be inside cwd) | best quota across 3 accounts; vision quality on par with Sonnet | workspace sandbox restricts image paths to cwd subtree |
| **gemini Flash** (auto on Pro 429) | `gemini -p "..." -o text` (no model flag → Flash) | cheaper quota | lower quality on visual nuance |
| **claude -p sonnet** (final fallback) | `claude -p "..." --model sonnet` | no path restriction; consistent quality | single-account, no cycling  -  eats Max weekly cap |

**Account cycling (gemini only):** copy a cached creds file into place before invocation:

```
cp ~/.gemini/accounts/<email>.json ~/.gemini/oauth_creds.json
```

Cached accounts on Adithya's machine (priority order, always tried in this sequence):
1. `avery@seedboxlabs.co` (Workspace AI Ultra plan, effectively unlimited quota — always primary)
2. `adithya@outerscope.xyz` (personal AI Ultra, backup)
3. `adithya@eclipse.builders` (personal AI Ultra, backup)

The cycle dispatcher (`scripts/cycle.mjs`) hard-codes this order via `GEMINI_ACCOUNT_PRIORITY` so avery is always first regardless of `readdir` ordering. Adithya-only accounts get used only on avery's quota miss.

## Consumer surface (Python)

```python
import sys
sys.path.insert(0, "/Users/shakstzy/QUANTUM/_core/skills/cloud-llm")
from client import describe_images, ask_text, CloudLLMUnreachable

# Vision: pass absolute paths; helper handles cwd staging for gemini.
result = describe_images(["/path/a.jpg", "/path/b.jpg"], "Describe setting + props (NOT facial features). Reply in 4 bullets.")

# Text-only:
result = ask_text("Summarize: ...")
```

## Consumer surface (Node)

```js
import { describeImages, askText } from "/Users/shakstzy/QUANTUM/_core/skills/cloud-llm/scripts/cycle.mjs";

const desc = await describeImages(
  ["/abs/path/photo1.jpg", "/abs/path/photo2.jpg"],
  "Describe setting + props (NOT facial features). 4 bullets max."
);
```

## Behavior

1. Try gemini Pro with current account.
2. On 429/quota: rotate creds to next account, retry. Cycles through all cached accounts before falling through.
3. If all gemini accounts are 429: try claude -p sonnet.
4. If everything fails: throw `CloudLLMUnreachable` with diagnostic. Caller should halt loud (no graceful degradation).
5. Image staging for gemini: if any provided path is outside `/Users/shakstzy/QUANTUM/`, helper copies the file to `raw/.cloud-llm-staging/<runId>/` (gitignored), invokes gemini from QUANTUM cwd, cleans up after.

## When this fires

Triggers  -  any consumer skill that needs cloud LLM and doesn't want to think about cycling:
- Vision: image description, screenshot Q&A, multimodal synthesis
- Text: long-form prompts that exceed local-llm's 32k context

Do NOT use for:
- Skills that require local-only inference (privacy-sensitive raw files that should not leave the machine  -  those still go through `local-llm`).
- Drafting messages in Adithya's voice (that path is `claude -p` directly inside the consumer; cycling adds nothing because it's already single-shot per draft).

## Operator notes

- This skill has no daemon, no install. The CLIs (`gemini`, `claude`) are already on PATH.
- The cycling state is just `~/.gemini/oauth_creds.json` getting overwritten. No DB, no lockfile. If two consumers ran concurrently they could clobber each other mid-call  -  fine in practice because both consumers process serially.
- Logs from each invocation go to consumer's own log; this skill is silent on success.

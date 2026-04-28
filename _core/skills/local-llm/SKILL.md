---
name: local-llm
description: Hit Adithya's persistent local Gemma daemon (Gemma 4 26B-A4B MoE, MLX, 4-bit) over HTTP at http://127.0.0.1:8765. OpenAI-compatible chat/completions, vision-capable. Daemon is launchd-managed by SHAKOS (`com.shakos.local-llm`). Use for inference without cloud cost or cold-load tax. Also covers lifecycle control (start/stop/restart/status) when Adithya wants to free RAM. Do NOT use for embeddings, fine-tuning, contexts >32k, or hot-swapping models without restart.
allowed-tools: Bash
---

# local-llm (QUANTUM stub)

QUANTUM-side trigger doc for the persistent local Gemma server. The daemon, install scripts, plist, and contract reference all live in SHAKOS at `/Users/shakstzy/SHAKOS/system/_core/playbooks/local-llm/`. This stub exists so:

1. Other QUANTUM skills (currently `instagram-summary`, future workspaces) have a single canonical pointer to the contract.
2. Adithya can ad-hoc invoke the daemon by phrase from inside QUANTUM ("ask gemma X", "describe this image with gemma").
3. Lifecycle commands are reachable without remembering SHAKOS paths ("stop gemma to free ram", "is gemma running").

## When this fires

**Direct-inference triggers** (Adithya wants Gemma to answer something locally):
- "ask gemma X" / "ask the local llm X" / "run this through gemma"
- "describe this image with gemma" / "what's in this image, use gemma"
- "summarize this with the local model" / "no cloud, use local"
- Any time another QUANTUM skill needs vision or text inference and explicitly cites this PLAYBOOK in its Inputs.

**Lifecycle triggers** (Adithya managing the daemon itself):
- "is gemma running" / "status of local llm" / "is the local model up"
- "start gemma" / "boot local llm"
- "stop gemma" / "kill local llm" / "free the gemma ram"
- "restart gemma" / "reload the local model"
- "swap local model to <X>" (needs plist edit + restart)

Do NOT fire for:
- Cloud Gemini / Anthropic / OpenAI requests. Different surface.
- Text embeddings. Daemon does not expose an embeddings endpoint.
- Fine-tuning. Out of scope for this server.
- Requests that need >32k combined input+output tokens.

## Daemon shape (current)

- **Endpoint:** `http://127.0.0.1:8765/v1/chat/completions`
- **Health:** `GET http://127.0.0.1:8765/health`
- **Model name (pass verbatim in `model` field):** `unsloth/gemma-4-26b-a4b-it-UD-MLX-4bit`
- **Vision:** yes. `image_url` content blocks with base64 data URIs per OpenAI spec.
- **Bind:** `127.0.0.1` only.
- **Concurrency:** single-stream. Serialize calls.
- **Cold start:** ~30s on first request after boot. Warm thereafter.
- **Latency (warm):** text 1-3s; vision 1-4 images 5-15s.
- **Context limit:** ~32k combined input+output. Vision images count.
- **Resident memory:** ~22GB unified once warm.

## Persistence model

`com.shakos.local-llm` is a **LaunchAgent** at `~/Library/LaunchAgents/com.shakos.local-llm.plist` with:

- `RunAtLoad: true` — starts at every login.
- `KeepAlive` only on `Crashed` (NOT on `SuccessfulExit`) — a clean stop sticks until next login.
- `ThrottleInterval: 30s` — no restart-storms.

So:

- **Reboot:** daemon restarts at next login. Always available.
- **Manual stop (`stop.sh`):** stays stopped until you log out / log back in OR re-run `start.sh`.
- **Disable across logins entirely:** `launchctl unload -w ~/Library/LaunchAgents/com.shakos.local-llm.plist`. To re-enable: `launchctl load -w ...`.

Idle auto-eviction (unload weights after N min idle, reload on next request) is NOT built. Would require a wrapper around `mlx_vlm.server`. Open question, not blocking.

## Procedure

### Status / health

```
curl -sS -m 2 http://127.0.0.1:8765/health
```

Healthy response:

```json
{"status":"healthy","loaded_model":"unsloth/gemma-4-26b-a4b-it-UD-MLX-4bit","loaded_adapter":null}
```

Or:

```
bash /Users/shakstzy/SHAKOS/system/_core/playbooks/local-llm/scripts/status.sh
```

### Lifecycle

```
bash /Users/shakstzy/SHAKOS/system/_core/playbooks/local-llm/scripts/start.sh
bash /Users/shakstzy/SHAKOS/system/_core/playbooks/local-llm/scripts/stop.sh
bash /Users/shakstzy/SHAKOS/system/_core/playbooks/local-llm/scripts/restart.sh
```

Stopping the daemon frees ~22GB unified memory. Restarting pays the ~30s cold-load tax on the next call.

### Ad-hoc inference (text)

```
curl -sS http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "unsloth/gemma-4-26b-a4b-it-UD-MLX-4bit",
    "messages": [{"role": "user", "content": "<your prompt>"}],
    "max_tokens": 512
  }'
```

Or use the SHAKOS wrapper:

```
bash /Users/shakstzy/SHAKOS/system/_core/playbooks/local-llm/scripts/chat.sh "<your prompt>"
```

Parse `choices[0].message.content`. Token counts are in `usage`.

### Ad-hoc inference (vision)

Pass images as data URIs in `image_url` content blocks. Concrete shape lives in `references/api.md` of the SHAKOS playbook. Default timeout 120s for vision requests.

### Audit

If response is empty or contains `[Error:` prefix, log the full response and surface the failure to Adithya. Do not retry blindly. Server log at `~/.shakos/local-llm/server.log`.

## QUANTUM consumers

- **`_core/skills/instagram-summary`** — final multimodal synthesis after caption + audio + frame extraction.
- Future: any workspace that needs zero-cost local vision/text inference. Reference this skill's contract; don't duplicate the curl boilerplate.

## Notes

- Single source of truth for the daemon contract is the SHAKOS playbook. If contract drift happens, fix it there and have this stub re-link.
- Model swap is a deliberate change (edit plist, restart). Not a per-call option.
- Bigger / different vision models are an open design question (see Adithya's design notes; not yet acted on).

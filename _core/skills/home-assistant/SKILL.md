---
name: home-assistant
description: Read and control Adithya's Home Assistant instance via the official `hass-cli` (home-assistant-ecosystem/home-assistant-cli) wrapped by `scripts/ha` which sources the long-lived access token from macOS Keychain. Use for getting entity state (lights, switches, sensors, climate, media players, cameras, sirens), calling services (turn on/off, set brightness, run scenes, trigger automations), reading event/automation lists, and one-shot config queries. Do NOT use for editing HA YAML configs, installing add-ons, modifying dashboards/themes, or building a long-running daemon - this is a stateless toolkit, not an automation engine.
---

# Home Assistant (`hass-cli` via Keychain)

Stateless wrapper around the official `hass-cli` for Adithya's HA instance running on a Raspberry Pi. Auth lives in macOS Keychain `service=quantum-home-assistant` (accounts: `url`, `token`). The `scripts/ha` shim exports both as `HASS_SERVER` / `HASS_TOKEN` env vars and execs `hass-cli`.

Deliberately NOT using an HA MCP server. Rationale: HA's tool surface is huge (hundreds of services across dozens of domains) and entity state dumps run to thousands of tokens. An MCP would persist the schema in every session and pour raw payloads straight into context. A CLI lets us pre-filter at the shell (`grep`, `head`, `awk`, `jq`) before anything reaches the model. See `feedback_simplicity_first` and the lazy-load thread in `feedback_skill_consumers_delegate`.

## When this fires

Trigger phrases (semantic, non-exhaustive):
- "what's the state of <entity/area>", "is the <thing> on", "is anyone home", "what's the temp inside"
- "turn on/off <entity>", "set <light> to <brightness/color>", "dim the <light>"
- "run <scene>", "activate <scene>", "trigger <automation>"
- "what's playing on <media player>", "pause/resume <media player>"
- "what HA automations do I have", "list my automations / scenes / scripts"
- "what cameras / sensors / switches do I have"
- "is HA up", "ping home assistant", "ha status"

Do NOT fire for:
- Editing HA YAML configs, dashboards, themes, or Lovelace cards (use the HA UI).
- Installing/managing HA add-ons or HACS.
- Anything HomeKit-specific (Apple Home, Homebridge config) - this is HA only.
- Smart-home questions about devices NOT in HA (use the vendor app).

## Required inputs

- For **read** verbs: an entity-id prefix is fine (`light.`, `sensor.bedroom_`) - the CLI accepts a positional filter.
- For **service calls**: `<domain>.<service>` plus the target entity. Never guess entity IDs - if Claude is unsure, run `ha state list <prefix>` first to confirm the exact ID.

## Verbs

All verbs are run via `bash _core/skills/home-assistant/scripts/ha <verb> [args]` (or the full path). Output is human-readable text by default; `hass-cli --output json <verb>` gives JSON for `jq` piping.

| Verb | Usage | What it does |
|------|-------|--------------|
| `info` | `ha info` | Auth + connection check. Prints server URL and (masked) token. |
| `state list` | `ha state list [prefix]` | List entity states. Pass a filter like `light.` or `sensor.bedroom` to scope. No filter = ALL entities (~111 right now, ~20-30 lines per page). |
| `state get` | `ha state get <entity_id>` | Single entity full state + attributes. Cheap. |
| `service list` | `ha service list [domain]` | List available services. Always pass a domain (`light`, `switch`, `scene`) - unfiltered is huge. |
| `service call` | `ha service call <domain.service> --arguments entity_id=<id>[,...]` | Fire a service. E.g. `ha service call light.turn_on --arguments entity_id=light.bedroom,brightness_pct=50`. |
| `event list` | `ha event list` | List event types HA is listening for. |
| `event fire` | `ha event fire <type> [--json-data '{"k":"v"}']` | Fire an event. Rare. |
| `history` | `ha history --entity <id> [--start <iso8601>]` | State history for an entity. Volume depends on how chatty the entity is - cap with `--end` or pipe through `head`. |
| `template render` | `ha template render '{{ states("sensor.foo") }}'` | Render a Jinja template. Useful for cross-entity computations. |

## Context hygiene (IMPORTANT)

This skill exists BECAUSE MCP tool results pollute context. Don't undo that by dumping raw output back into context.

- **Filter before reading.** `ha state list` returns 111 lines today. Always scope with a prefix or pipe through `awk '$1 ~ /^light\./'` / `head -20` / `grep <area>` BEFORE the result lands in chat.
- **Use `--output json` only when you'll pipe through `jq`.** JSON is heavier than the default table format; only use it when the next step actually needs it.
- **For exploratory dumps**, delegate to a subagent (`Agent` tool, Explore type). The subagent reads the full dump in its own context and reports a 200-word summary.

Example of doing this right:
```bash
# good: scoped + further filtered before the result hits chat
ha state list light. | grep -v ',unavailable,' | awk '{print $1, $3}' | head
# bad: dumps all 111 entities into context for one question
ha state list
```

## Common patterns

**"Turn off all the lights":**
```bash
ha service call light.turn_off --arguments entity_id=all
```

**"What lights are on right now?":**
```bash
ha state list light. | awk '$3=="on"'
```

**"Run the movie scene":**
```bash
ha state list scene. | grep -i movie    # confirm exact ID
ha service call scene.turn_on --arguments entity_id=scene.movie_night
```

**"Is anyone home?":**
```bash
ha state list person.
# or
ha state list device_tracker.
```

**"What's the temperature inside?":**
```bash
ha state list sensor. | grep -i temperature
```

## Auth + rotation

Token lives in macOS Keychain: `service=quantum-home-assistant`, accounts `url` + `token`. Never on disk, never in the repo. To rotate:

```bash
# In HA UI: Profile (avatar bottom-left) -> Security -> Long-Lived Access Tokens
# -> revoke old, create new
security add-generic-password -U -s quantum-home-assistant -a token -w '<new-token>'
```

To change the URL (if HA moves IP/hostname):
```bash
security add-generic-password -U -s quantum-home-assistant -a url -w 'http://<new-host>:8123'
```

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ha: missing keychain entries` | Keychain entries not set (e.g. fresh machine, new login) | Re-run the two `security add-generic-password` commands above. |
| `Cannot connect to host homeassistant.local:8123` | HA Pi off / on a different network / mDNS broken | `curl -s --max-time 3 http://homeassistant.local:8123/manifest.json` to confirm. If down, check the Pi. |
| `401 Unauthorized` | Token revoked or expired | Generate a new long-lived token in the HA UI and rotate via `security add-generic-password -U`. |
| `state list` returns 0 rows for a known entity | The token's user account has no access to that entity area, or the entity is in a disabled integration | Confirm in the HA UI under Settings -> Devices & Services. |

## Audit

Log non-trivial mutations (service calls that change device state) to `~/.quantum/home-assistant/audit.log` as JSON lines:

```bash
echo "{\"ts\":\"$(date -u +%FT%TZ)\",\"verb\":\"service.call\",\"target\":\"light.bedroom\",\"data\":{...}}" >> ~/.quantum/home-assistant/audit.log
```

Reads (state queries, info) are NOT audited.

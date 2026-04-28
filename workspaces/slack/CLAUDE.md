# slack

Pulls Slack messages from `eclipse-labs.slack.com` into `raw/slack/`.

## Triggers

- `pull` -> `bash scripts/pull.sh` (incremental; resumes via per-channel cursor map)
- For send/read/search ops, use the `slack` skill at `_core/skills/slack/SKILL.md`.

## Layout

```
scripts/ingest_all.py    enumerate conversations -> conversations.history per channel -> NDJSON sharded by ts month
scripts/pull.sh          wrapper that calls ingest_all.py for the configured workspace
```

## Ingest

- **Source:** Slack Web API as Adithya (xoxp user token).
- **Trigger:** `pull` -> `bash scripts/pull.sh`.
- **Automation:** `~/Library/LaunchAgents/com.shakstzy.quantum-slack.plist` every 1h. Logs at `~/Library/Logs/quantum-slack.{stdout,stderr}.log`.
- **Shape:** item-stream (Shape A per `_core/CONVENTIONS.md`).
- **Output path:** `raw/slack/<workspace>/YYYY-MM.ndjson` (one message per line, sharded by message month).
- **Format:** NDJSON.
- **Dedup key:** `(channel, ts)`. ingest_all.py reads the existing shard's keys before append.
- **Watermark:** `raw/.ingest-log/slack-<workspace>.cursors.json` (per-channel last-seen ts).
- **Mutations:** none here. Sends/reads via `_core/skills/slack/SKILL.md` (CONFIRM gate optional).

## Conventions

- Token: macOS Keychain `service=quantum-slack account=<workspace>`.
- Workspace default: `eclipse-labs`. Override with `SLACK_ACCOUNT=<name>` env var.
- Channel metadata cache: `raw/.ingest-log/slack-<workspace>.channels.json`. Refreshed each run, used by graph time to resolve channel IDs.
- Pull is read-only. Re-runs are idempotent against the cursor map and per-shard dedup.

## Coverage caveat

Current scopes (see `_core/skills/slack/references/scopes.md`) cover:
- Public channels (channels:read, channels:history)
- DMs (im:read, im:history)

NOT covered (scopes not granted, so conversations.list won't enumerate them):
- Private channels (needs `groups:read`)
- Group DMs (needs `mpim:read`)

To expand, add the scope at `https://api.slack.com/apps/`, reinstall, store the new `xoxp-` in Keychain, re-run.

## Cadence

| Plist | Interval | Notes |
|-------|----------|-------|
| `com.shakstzy.quantum-slack` | 3600s (1h) | Runs `pull.sh`. Tier 2 endpoints (~50/min) so 1h cadence is generous. |

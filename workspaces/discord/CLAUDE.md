# discord

Pulls Discord DMs + group DMs from `https://discord.com/api/v9/*` into `raw/discord/`. Uses the discord skill (`_core/skills/discord/`) for the authenticated Chrome session and the local-llm skill (`_core/skills/local-llm/`) for Gemma significance scoring.

## Triggers

- `pull` -> `bash scripts/pull.sh`
- For ad-hoc send / read / DM / search ops, use the discord skill at `_core/skills/discord/SKILL.md`.

## Layout

```
scripts/ingest_all.mjs   pull + Gemma route + write monthly shards
scripts/pull.sh          bash wrapper that calls ingest_all.mjs
setup/com.shakstzy.quantum-discord-pull.plist   launchd plist (48h cadence)
.dev-fixtures/           cached API fixtures for parser dev (gitignored)
```

## Conventions

- **Per-conversation files (file boundary = relationship boundary):**
  - `raw/discord/dms/<friend-username>--<channel-id>.ndjson` for 1:1 DMs.
  - `raw/discord/group-dms/<channel-id>.ndjson` for group DMs.
  - Each file is ONE conversation, append-only, chronologically ordered.
  - **Line 1** is a self-describing header: `{"_type":"channel_header","id":"<id>","kind":"dm","recipients":[...],"created_at":"<iso>"}`. Written once at file creation; never re-written.
  - **Lines 2+** are message records: `{"_type":"message","id":"<msg_id>","channel_id":"<id>","timestamp":"<iso>","author":{...},"content":"..."}`.
  - Why per-conversation: graphify clusters per-file, so each file IS a relationship. Lint passes can scan one conversation at a time. Easy to grep one friend. Easy to delete one conversation for privacy without disturbing others.
- **Flagged messages:** `raw/discord/_review-list.ndjson` (cross-channel). Bots, system messages (calls, joins, pins), empty content, and Gemma-scored NOISE land here with `_routed_from: <channel_id>` and `_route_reason: <why>`. Audit periodically; false positives can be moved to the right channel file manually (raw is otherwise immutable).
- **Watermark:** `raw/.ingest-log/discord.channels.json` maps `channel_id -> last_message_id`. Re-runs only fetch `?after=<last_id>`.
- **Significance audit log:** `raw/.ingest-log/discord.significance.ndjson` (append-only). One line per classified message: `{ts, channel_id, message_id, class, reason}`. Useful for tuning Gemma prompts later or reconstructing what was filtered.
- **Friend handles stored raw** (username + global_name + id, in the channel header). Friend resolution to people-graph nodes happens at lint time, not ingest time. Same "full fidelity" rule iMessage uses.
- **Group DMs:** included. Header records the full participant list under `recipients`.
- **Attachments:** URL refs only. `has_attachment: true` flag set so conversation flow stays readable. We don't download files (Discord CDN URLs may expire later; that's acceptable for graphify purposes).
- **Cadence:** every 48 hours via `setup/com.shakstzy.quantum-discord-pull.plist`. Logs at `~/Library/Logs/quantum-discord-pull.{stdout,stderr}.log`.

## Friend renames + immutability

If a Discord friend changes their username after we've created their per-conversation file, we keep appending to the OLD-named file (we look up by `channel_id`, not by name). The header line in the file still references the old recipient handle at file-creation time; new messages keep the new handle in their author block. Graphify can de-dup by `channel_header.id`. No churn, no rewrites, raw stays immutable.

## Pacing (detection-conscious by design)

- One Chrome session for the whole pull (NOT one launch per channel).
- Within a channel, paginated requests jitter 5-15s apart.
- Between channels: 30-60s on first-run / backfill, 1.5-3s in steady-state (most channels return zero new messages incrementally, so this is fast).
- Honors `Retry-After` on 429. Two consecutive 401s halt the run and trip the breaker.
- `_core/skills/discord/` owns the breaker file (`~/.quantum/chrome-profiles/discord/.breaker.json`); the ingest inherits it.

## First run

The first run sees an empty watermark file and pulls the last 30 days from every channel. Override via `--backfill-days=N`.

```bash
# Dry-run on first run before flipping launchd on:
bash scripts/pull.sh --dry-run --max-channels=5

# Real first-run pull (paced, may take 30-60 min for 60+ channels):
bash scripts/pull.sh
```

After the first run the watermarks file is populated; subsequent runs are incremental and fast.

## Setup (one-time)

1. Verify the discord skill session works: `node _core/skills/discord/scripts/run.mjs whoami`.
2. Verify Gemma daemon: `bash _core/skills/local-llm/scripts/status.sh` (should show running).
3. Dry-run with a small cap: `bash scripts/pull.sh --dry-run --max-channels=3`. Inspect Gemma's signal/noise calls in the printed output. Tune the prompt in `ingest_all.mjs` if classifications look off.
4. Real first-run: `bash scripts/pull.sh`.
5. Install launchd plist:
   ```bash
   cp setup/com.shakstzy.quantum-discord-pull.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shakstzy.quantum-discord-pull.plist
   launchctl enable gui/$(id -u)/com.shakstzy.quantum-discord-pull
   ```
6. (Optional) Force a kickstart to verify the launchd-spawned context works:
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.shakstzy.quantum-discord-pull
   tail -20 ~/Library/Logs/quantum-discord-pull.stderr.log
   ```

No FDA needed: this workspace doesn't read TCC-protected files. Chrome profile lives in `~/.quantum/chrome-profiles/discord/` (user-writable).

## Flags (ingest_all.mjs)

| Flag | Effect |
|------|--------|
| `--dry-run` | Print SIGNIFICANT/NOISE decisions, write nothing, leave watermarks alone |
| `--max-channels=N` | Cap channels per run (default unlimited) |
| `--backfill-days=N` | Override backfill horizon for first run (default 30) |
| `--no-gemma` | Skip Gemma scoring; everything new goes to monthly shard. For fixture dev or Gemma-down emergencies. |

## Detection / safety notes

- ToS-sensitive (selfbot REST surface). Use a burner if heavy use becomes the norm.
- Keep Discord open in your normal client while runs are scheduled (cheapest detection mitigation, see `_core/skills/discord/references/detection-mitigation.md`).
- The pull is paced to look organic: one Chrome session, sequential channel walks, jittered timing. Don't run multiple invocations concurrently.
- If `_review-list.ndjson` grows quickly with messages that look obviously significant to you, the Gemma prompt needs tuning. Edit `ingest_all.mjs` `scoreBatchWithGemma()` prompt and re-dry-run.

## Known limitations (v1)

- DMs only. No guild/server channel ingest. (High-volume guilds = highest detection risk.)
- No edit-tracking on incremental runs. We pull `?after=<last_id>` so we only see new messages, not edits to old ones.
- No deletion tracking. If a message in a past pull gets deleted, our shard still has it. Acceptable for a personal graph snapshot.
- Single profile. Burner support exists in the skill (`DISCORD_PROFILE_DIR=~/.quantum/chrome-profiles/discord-burner`) but the workspace launchd plist doesn't pass it. Edit the plist if you flip to a burner.

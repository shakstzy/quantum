# calendar

Pulls Google Calendar events across Adithya's 4 accounts into `raw/calendar/`.

## Triggers

- `pull` -> `bash scripts/pull.sh` (incremental; resumes via per-account watermark)
- For event create/modify/delete, use the `google-workspace` skill at `_core/skills/google-workspace/SKILL.md`.

## Layout

```
scripts/ingest_all.py    enumerate events -> dedupe by eventId -> NDJSON sharded by event start month
scripts/pull.sh          fan out ingest_all.py across all 4 accounts in parallel
```

## Ingest

- **Source:** Google Calendar via `gog -j calendar` (4 accounts).
- **Trigger:** `pull` -> `bash scripts/pull.sh`.
- **Automation:** `~/Library/LaunchAgents/com.shakstzy.quantum-calendar.plist` every 6h. Logs at `~/Library/Logs/quantum-calendar.{stdout,stderr}.log`.
- **Shape:** item-stream, sharded by Google calendar source (Shape A per `_core/CONVENTIONS.md`, sub-source variant).
- **Output path:** `raw/calendar/<account-slug>/<calendar-slug>.ndjson` (one event per line; one file per Google calendar like `main`, `habits`, `work`).
- **Format:** NDJSON.
- **Dedup key:** Calendar `eventId`. The whole shard is rewritten each run (Google's `events.list` returns the full window), so dedup is implicit.
- **Watermark:** none. Each run reads the past-7 / future-30 window and rewrites the per-calendar shard.
- **Mutations:** none here. Event mutations via `_core/skills/google-workspace/SKILL.md` (CONFIRM gate).

## Conventions

- Window: pulls past 7 days + future 30 days per run. Whole-shard rewrite means events that fall outside the window are NOT preserved across runs (events older than 7 days drop off the active shard on the next pull). This is the current behavior; if long-tail history matters, switch to append + watermark like email.
- Default timezone: America/Chicago.
- Pull is read-only. Re-runs are idempotent within the active window.

## Cadence

| Plist | Interval | Notes |
|-------|----------|-------|
| `com.shakstzy.quantum-calendar` | 21600s (6h) | Runs `pull.sh` across 4 accounts in parallel. |

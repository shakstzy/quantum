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
- **Shape:** item-stream (Shape A per `_core/CONVENTIONS.md`).
- **Output path:** `raw/calendar/<account-slug>/YYYY-MM.ndjson` (one event per line, sharded by start month).
- **Format:** NDJSON.
- **Dedup key:** Calendar `eventId`. ingest_all.py reads `raw/.ingest-log/calendar-<account-slug>.events.txt` and skips processed events.
- **Watermark:** `raw/.ingest-log/calendar-<account-slug>.events.txt`.
- **Mutations:** none here. Event mutations via `_core/skills/google-workspace/SKILL.md` (CONFIRM gate).

## Conventions

- Window: pulls past 7 days + future 30 days per run, deduped against the watermark so re-runs are cheap.
- Default timezone: America/Chicago.
- Pull is read-only. Re-runs are idempotent.

## Cadence

| Plist | Interval | Notes |
|-------|----------|-------|
| `com.shakstzy.quantum-calendar` | 21600s (6h) | Runs `pull.sh` across 4 accounts in parallel. |

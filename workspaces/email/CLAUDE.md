# email

Pulls Gmail across Adithya's 4 accounts into `raw/email/`.

## Triggers

- `pull` -> `bash scripts/pull.sh` (incremental; resumes via per-account watermark)
- For send/search/reply ops, use the `google-workspace` skill at `_core/skills/google-workspace/SKILL.md`.

## Layout

```
scripts/ingest_all.py    paginate -> dedupe by threadId -> NDJSON sharded by message month
scripts/pull.sh          fan out ingest_all.py across all 4 accounts in parallel
```

## Ingest

- **Source:** Gmail via `gog -j gmail` (4 accounts).
- **Trigger:** `pull` -> `bash scripts/pull.sh`.
- **Automation:** `~/Library/LaunchAgents/com.shakstzy.quantum-email.plist` every 1h. Logs at `~/Library/Logs/quantum-email.{stdout,stderr}.log`.
- **Shape:** item-stream (Shape A per `_core/CONVENTIONS.md`).
- **Output path:** `raw/email/<account-slug>/YYYY-MM.ndjson` (one thread per line, sharded by message month).
- **Format:** NDJSON.
- **Dedup key:** Gmail `threadId`. ingest_all.py reads `raw/.ingest-log/email-<account-slug>.threads.txt` and skips processed threads.
- **Watermark:** `raw/.ingest-log/email-<account-slug>.threads.txt` (one threadId per line).
- **Mutations:** none here. Sends/replies via `_core/skills/google-workspace/SKILL.md` (CONFIRM gate).

## Conventions

- Account slug: local-part with `@` and `.` -> `-`. So `adithya@eclipse.builders` -> `adithya-eclipse-builders`.
- Pull is read-only. Re-runs are idempotent; the watermark guarantees each thread is fetched once across all runs.
- Never edit files in `raw/`. Re-run pull instead.

## Cadence

| Plist | Interval | Notes |
|-------|----------|-------|
| `com.shakstzy.quantum-email` | 3600s (1h) | Runs `pull.sh` across 4 accounts in parallel. |

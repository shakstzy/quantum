# gdrive

Pulls Google Drive metadata + extracted markdown across Adithya's 4 accounts into `raw/gdrive/`.

## Triggers

- `pull` -> `bash scripts/pull.sh` (incremental; resumes via per-account watermark)
- For upload/share/delete/download, use the `google-workspace` skill at `_core/skills/google-workspace/SKILL.md`.

## Layout

```
scripts/ingest_all.py    enumerate files -> dedupe by fileId -> NDJSON index + per-file md/binary
scripts/pull.sh          fan out ingest_all.py across all 4 accounts in parallel (uses _core/scripts/.venv)
```

## Ingest

- **Source:** Google Drive via `gog -j drive` (4 accounts).
- **Trigger:** `pull` -> `bash scripts/pull.sh`.
- **Automation:** `~/Library/LaunchAgents/com.shakstzy.quantum-gdrive.plist` daily at 03:00. Logs at `~/Library/Logs/quantum-gdrive.{stdout,stderr}.log`.
- **Shape:** item-stream (Shape A per `_core/CONVENTIONS.md`).
- **Output path:** `raw/gdrive/<account-slug>/{_index.ndjson, files/<fileId>.<ext>, md/<fileId>.md}`.
- **Format:** NDJSON for the per-account `_index.ndjson` (one file metadata record per line); per-file binary or extracted markdown next to it.
- **Dedup key:** Drive `fileId`. ingest_all.py reads `raw/.ingest-log/gdrive-<account-slug>.files.txt` and skips processed files.
- **Watermark:** `raw/.ingest-log/gdrive-<account-slug>.files.txt`.
- **Mutations:** none here. Uploads/shares via `_core/skills/google-workspace/SKILL.md` (CONFIRM gate; uploads >100 MB or with permission changes always require CONFIRM).

## Conventions

- Metadata-first: `_index.ndjson` is the canonical record. Binary content is extracted to markdown via `pymupdf4llm` for PDFs (hence the `_core/scripts/.venv` requirement).
- Pull is read-only. Re-runs are idempotent against the watermark.
- Never edit files in `raw/`. Re-run pull instead.

## Cadence

| Plist | Interval | Notes |
|-------|----------|-------|
| `com.shakstzy.quantum-gdrive` | daily 03:00 local | Runs `pull.sh` across 4 accounts in parallel. |

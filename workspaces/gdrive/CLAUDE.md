# gdrive

Pulls Google Drive metadata across Adithya's 4 accounts into `raw/gdrive/`.

## Triggers

- `pull` -> `bash scripts/pull.sh [days]` (default 30d)
- For upload/share/delete/download, use the `google-workspace` skill at `_core/skills/google-workspace/SKILL.md`.

## Layout

```
scripts/pull.sh       list recently-modified files via gog, dump JSON per account into raw/gdrive/
```

## Conventions

- Output: `raw/gdrive/YYYY-MM-DD-<account-slug>.json`. Metadata only; binary content fetched on-demand by callers.
- Pull is read-only. All mutations go through the `google-workspace` skill (CONFIRM gate applies; uploads >100 MB or with permission changes always require CONFIRM).
- Never edit files in `raw/`. Re-run pull instead.

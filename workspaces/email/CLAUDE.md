# email

Pulls Gmail across Adithya's 4 accounts into `raw/email/`.

## Triggers

- `pull` -> `bash scripts/pull.sh [days]` (default 7d)
- For send/search/reply ops, use the `google-workspace` skill at `_core/skills/google-workspace/SKILL.md`.

## Layout

```
scripts/pull.sh       fetch via gog, dump JSON per account into raw/email/
```

## Conventions

- Output filename: `raw/email/YYYY-MM-DD-<account-slug>.json`. Account slug is the local-part with dots -> hyphens.
- Pull is read-only. Sends and modifies go through the `google-workspace` skill (CONFIRM gate applies).
- Never edit files in `raw/`. Re-run pull instead.

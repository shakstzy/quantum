# calendar

Pulls Google Calendar events across Adithya's 4 accounts into `raw/calendar/`.

## Triggers

- `pull` -> `bash scripts/pull.sh [past_days] [future_days]` (default 7 / 30)
- For event create/modify/delete, use the `google-workspace` skill at `_core/skills/google-workspace/SKILL.md`.

## Layout

```
scripts/pull.sh       fetch events window via gog, dump JSON per account into raw/calendar/
```

## Conventions

- Output: `raw/calendar/YYYY-MM-DD-<account-slug>.json`.
- Pull is read-only. All mutations go through the `google-workspace` skill (CONFIRM gate applies).
- Default timezone: America/Chicago.

# imessage

Pulls iMessage / SMS / RCS from the local `~/Library/Messages/chat.db` into `raw/imessage/`.

## Triggers

- `pull` -> `bash scripts/pull.sh` (incremental; uses ROWID watermark)
- For ad-hoc send / read / contact-lookup ops, use the `macos-contacts-imessage` skill at `_core/skills/macos-contacts-imessage/SKILL.md`.

## Layout

```
scripts/ingest_all.py    chat.db -> NDJSON sharded by YYYY-MM, plus _review-list.ndjson
scripts/pull.sh          wrapper that calls ingest_all.py
```

## Conventions

- **Kept messages:** `raw/imessage/YYYY-MM.ndjson` (one line per message, sharded by message month).
- **Flagged messages:** `raw/imessage/_review-list.ndjson`. Anything heuristically classified as 2FA / shortcode / noreply / promo lands here instead of the monthly shards. Adithya audits this file periodically; false positives can be moved to the right shard manually (raw is otherwise immutable).
- **Watermark:** `raw/.ingest-log/imessage.watermark` stores last processed `message.ROWID`. Re-runs only process new rows.
- **Chat classification cache:** `raw/.ingest-log/imessage.chat-class.json` maps `chat.ROWID -> {class: keep|review, reason: ...}`. Once a chat is classified, all future messages in that chat follow the same class. Edit this file to reclassify.
- **Handles are stored raw** (phone in E.164 or Apple ID email). Contact resolution happens at graph time, not ingest time. This is "full fidelity" per Adithya's instruction.
- **Group chats:** included. Each message records the full participant list.
- **Attachments:** text only. Image / video / audio bodies are skipped; an `has_attachment: true` flag is set so the conversation flow stays readable.
- **Cadence:** every 12 hours via `~/Library/LaunchAgents/com.shakstzy.quantum-imessage.plist`. Logs at `~/Library/Logs/quantum-imessage.{stdout,stderr}.log`.

## Spam / 2FA heuristics (v1)

A chat is flagged for review if ANY of:

1. Any participant handle is an all-digits shortcode of length 3-7 (no country code).
2. Any participant handle email contains `noreply`, `no-reply`, `donotreply`, `notifications@`, `alerts@`, `support@`, or `info@`.
3. 1:1 chat where the participant is not in Contacts AND every message text matches at least one of:
   - `verification code`, `your code is`, `use this code`, `OTP`, `one-time`, `do not share`
   - `% off`, `$\d+ off`, `Reply STOP`, `STOP to opt out`, `unsubscribe`

Else the chat is kept.

## Coverage caveat

This Mac's chat.db starts at **2024-03-11**. Pre-2024 history lives only on Adithya's iPhone. To backfill, plug iPhone in -> Finder encrypted backup -> parse `sms.db` from the backup. Not done yet; tracked as a separate task.

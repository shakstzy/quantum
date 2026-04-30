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

## How the trigger works

**This workspace does NOT use launchd.** chat.db is TCC-protected and macOS silently ignores FDA grants on the system binaries launchd actually invokes (`/bin/bash` is SIP-locked; even Homebrew python3 grants don't propagate cleanly through a launchd-spawned tree). Tried both, both fail with PermissionError.

What works: the `SessionStart` Claude Code hook in `.claude/settings.json` fires `scripts/hooks/imessage-ingest.sh` every time Adithya opens a Claude Code session in QUANTUM. Claude Code is spawned from iTerm, iTerm has FDA, and FDA propagates through the session's process tree, so the hook reads chat.db without any extra grant.

- Incremental no-op = 0.07s, runs in background, never blocks session start.
- Lockfile at `/tmp/quantum-imessage-ingest.lock` prevents concurrent Claude windows from racing.
- Hook log: `~/Library/Logs/quantum-imessage.hook.log`.
- Cadence is "whenever Claude Code opens." Adithya opens it many times a day; the watermark catches up regardless of how often. No 12h timer needed.
- Manual ad-hoc: `bash workspaces/imessage/scripts/pull.sh` from any iTerm session.

## Conventions

- **Kept messages:** `raw/imessage/YYYY-MM.ndjson` (one line per message, sharded by message month).
- **Flagged messages:** `raw/imessage/_review-list.ndjson`. Anything heuristically classified as 2FA / shortcode / noreply / promo lands here instead of the monthly shards. Adithya audits this file periodically; false positives can be moved to the right shard manually (raw is otherwise immutable).
- **Watermark:** `raw/.ingest-log/imessage.watermark` stores last processed `message.ROWID`. Re-runs only process new rows. Verified 0.07s for a no-op incremental.
- **Chat classification cache:** `raw/.ingest-log/imessage.chat-class.json` maps `chat.ROWID -> {class: keep|review, reason: ...}`. Once a chat is classified, all future messages in that chat follow the same class. Edit this file to reclassify.
- **Contacts are resolved at ingest time.** Each record carries `sender_name`, `chat_display_name`, and `chat_participant_names` populated from `~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb`. Unresolved handles fall back to the raw phone / Apple ID. This is what gives Graphify the entity-linking signal.
- **Handles are also stored raw** (phone in E.164, Apple ID email). Both raw + resolved travel together so Graphify can link by either.
- **Group chats:** included. Each message records the full handle list and the resolved-name list. Apple's group-chat title (when set) lands in `chat_display_name`.
- **Attachments:** text only. Image / video / audio bodies are skipped; a `has_attachment: true` flag is set so the conversation flow stays readable.
- **Cadence:** every 30 minutes via `~/Library/LaunchAgents/com.shakstzy.quantum-imessage.plist` (`StartInterval = 1800`). Logs at `~/Library/Logs/quantum-imessage.{stdout,stderr}.log`.

## Per-message schema

```json
{
  "rowid": 1,
  "guid": "...",
  "chat_rowid": 13,
  "chat_guid": "any;-;+19135445450",
  "chat_display_name": null | "Roommates",
  "chat_handles": ["+19135445450", ...],
  "chat_participant_names": ["Avery Abraham Stanford Biotech NYC", ...],
  "is_group": false,
  "handle": "+19135445450",
  "sender_name": "Avery Abraham Stanford Biotech NYC" | null,
  "is_from_me": false,
  "service": "iMessage",
  "subject": null,
  "text": "...",
  "has_attachment": false,
  "is_system_message": false,
  "item_type": 0,
  "date_apple_ns": 797547345649237888,
  "date_iso": "2026-04-10T20:55:45.649238+00:00"
}
```

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

---
name: macos-contacts-imessage
description: Read/write macOS Contacts.app and send/read iMessage or SMS via native AppleScript and the Messages SQLite database at ~/Library/Messages/chat.db. Use for looking up a contact by name/phone/email, creating or updating contacts, sending iMessages or SMS (one-to-one), fetching conversation history, listing recent chats, and polling for new inbound messages. Do NOT use for group-chat admin (add/remove members), tapbacks, message edits, iCloud sync management, or any WhatsApp/Telegram/Signal channel.
---

# macOS Contacts + iMessage

Native macOS primitives for driving Contacts.app and Messages.app. Pure osascript + sqlite3. No external binary, no plugin install.

Deliberately NOT using steipete's `imsg` Swift CLI or Anthropic's `imessage` plugin. Rationale: both add build or install steps and carry larger context surface; the same four operations (send, list chats, history, watch) are ~60 lines of sqlite and osascript. See `references/why-native.md` for tradeoffs.

## When this fires

Trigger phrases: "text <name>", "imessage <name>", "send a text to", "look up <name> in my contacts", "add <name> to my contacts", "save <number> as a contact", "what did <name> last text me", "show my recent imessages with <name>", "pull my iMessage history with <name>".

Do NOT fire for:
- Group chats, message reactions, edits, or replies-to-specific-message (AppleScript cannot do these).
- WhatsApp, Telegram, Signal, Slack, Discord (different skill entirely; not built yet).
- Contacts groups/distribution lists (not covered; use Contacts.app directly).
- Bulk mail merge (would trigger macOS rate-limiting; out of scope).

## Required caller inputs

For every send the caller MUST supply:
- **Recipient** -- phone (E.164 preferred) or Apple ID email.
- **Body** -- the exact text to send.
- **Service** (optional) -- `auto` (default), `iMessage`, `SMS`, or `RCS`. `auto` resolves the service via IDS.framework first and Messages.app chat history second; see "Service detection" below. `SMS` and `RCS` require an iPhone paired via Continuity.

For a contact create the caller MUST supply:
- **First name** (or full name to split).
- At least one of: phone, email.

If any required field is missing, stop and ask. Do not guess phone numbers, names, or intent.

## Procedure

1. **Load permissions reference.** Read `references/macos-permissions.md`. On first run in a fresh shell, run the self-test (`osascript -e 'tell application "Messages" to get service 1'`). Automation access to Messages is the only hard requirement for sends; FDA is only needed if the caller will invoke `history.sh` in this run.
2. **Normalize inputs.** Apply `rules/phone-normalization.md` to any phone number. Default region is US (`+1`). Emails pass through unchanged.
3. **Contact lookup (if needed).** Call `scripts/contacts.sh find --phone <E.164>` or `--name <query>` or `--email <addr>`. Returns JSON array of matches.
4. **Contact create or update (if needed).** Call `scripts/contacts.sh create ...` or `update --id <id> ...`. Returns the new/updated contact id.
5. **Preview the send.** `imessage.sh` auto-detects the service (see "Service detection" below), prints the assembled payload (recipient, resolved service with detection source, body) to stdout, then sends immediately. Do NOT wait for a `SEND` token unless `MACOS_IMSG_REQUIRE_CONFIRM=1` is set. See `rules/send-confirmation.md`. This is a deliberate exception to the global "literal CONFIRM/SEND/PUBLISH gate for destructive ops" rule because Messages.app already shows every outgoing message to the operator in real time; see Checkpoint section below for the full rationale.
6. **Send.** Call `scripts/imessage.sh send --to <recipient> --text "<body>" [--service auto|iMessage|SMS|RCS]`. Default `auto` resolves iMessage vs SMS vs RCS from Apple's local registration data plus Messages.app chat history. For attachments use `send-file --to <recipient> --file <absolute-path>`.
7. **History or watch (if requested).** Call `scripts/history.sh chats` to list recent conversations, `history --handle <recipient> [--limit N]` to fetch a thread, or `watch --handle <recipient> --since-rowid N` to fetch messages newer than the last seen rowid. These commands require FDA; sends do not.
8. **Emit results.** Return the JSON payload from the invoked script. `imessage.sh send` emits `{"handoff":"ok","service_used":"...","detection":"ids|messages-chat|explicit"}`. The skill does NOT claim delivery. Delivery is visible only in Messages.app UI.
9. **Audit.** Run every check in the Audit table below. If any fail, surface them.

## Service detection (auto mode)

1. `scripts/ids-query <handle>` is a tiny ObjC binary (auto-built on first use) that queries Apple's `IDSIDQueryController` in `IDS.framework`. It reliably returns `iMessage` for Apple-ID emails. For phone handles without an authenticated `preferredFromID`, IDS returns status 2 as a cache-miss fallback; we treat anything other than a definitive `iMessage` as "inconclusive, try step 2."
2. AppleScript enumerates Messages.app's `chats` and returns the service type (`iMessage`, `SMS`, or `RCS`) of any chat whose participants include the handle. This is the same binding Messages.app uses to route a new message, so it is authoritative when a history match exists.
3. If neither resolves, the script exits with code 4. Caller must pass `--service iMessage|SMS|RCS` explicitly. We do not guess.

## Checkpoint (Pattern 11) -- opt-in only

Default: no gate. The skill sends immediately after previewing the payload to stdout. Callers who want the old `SEND` confirmation must set `MACOS_IMSG_REQUIRE_CONFIRM=1`.

| After step | Agent presents | Human decides |
|------------|----------------|---------------|
| 4 (only if `MACOS_IMSG_REQUIRE_CONFIRM=1`) | Full send payload: recipient (normalized), service, body text | Type `SEND` to confirm, or edit a field, or abort |

Adithya's default collaboration mode is "just send"; the gate exists for scripted contexts (e.g., scheduled remote agents, pre-review tooling) where a human is not watching. Batch senders keep logging every send to their stage output folder regardless of the gate.

## Audit (Pattern 12)

Run after step 7, before declaring done:

| Check | Pass condition |
|-------|----------------|
| Automation verified | `osascript` probe of Messages succeeded this session OR the caller set `MACOS_IMSG_SKIP_PERMCHECK=1` |
| Phone normalized | All recipients are `+<digits>` OR an email address |
| Service resolved honestly | `imessage.sh` emitted `service_used` with a detection source (`ids`, `messages-chat`, or `explicit`); the skill never picked iMessage blindly |
| Send previewed | Payload (recipient, resolved service + detection source, body) printed to stdout before send; `SEND` token required only if `MACOS_IMSG_REQUIRE_CONFIRM=1` |
| Handoff captured | osascript returned exit 0 and `imessage.sh` emitted `{"handoff":"ok",...}`. Delivery is NOT claimed by the skill; it is visible in Messages.app UI only |
| No chat.db on send path | `imessage.sh` did not read `~/Library/Messages/chat.db` at any point during the send. chat.db access is confined to `history.sh` |
| Contact mutation confirmed | After `create`/`update`, a `find` returns the new state |
| Read-only DB access | If `scripts/history.sh` ran, it opened chat.db with `-readonly` (never `-readwrite`) |

## Budget

- Live sends per invocation: no hard cap; macOS throttles aggressive sends. Callers doing batches should space by 2s minimum.
- History fetch: default 100 messages, caller can raise via `--limit`.
- Watch polling: single-shot. The skill does NOT background-poll. Callers (e.g., stages) decide their own polling cadence.

## Files

- `scripts/contacts.sh` -- Contacts.app access. `find` uses JXA + `CNContactStore` (native indexed search, sub-second on 2k+ contacts). `create`, `update`, `delete` use AppleScript (simpler for single-record writes). CNContactStore's `predicateForContactsMatchingPhoneNumber` handles phone fuzz automatically, so unnormalized inputs still match for lookups.
- `scripts/imessage.sh` -- osascript wrapper for Messages.app: `send`, `send-file`. Auto-detects service via the IDS binary plus Messages.app chat enumeration. Never reads chat.db.
- `scripts/ids-query.m` -- Objective-C source for the IDS.framework lookup binary. Auto-compiled by `imessage.sh` on first use (`clang -fobjc-arc -framework Foundation -O2`). Requires Xcode command-line tools.
- `scripts/history.sh` -- sqlite3 reader for chat.db: `chats`, `history`, `watch`. THIS is the only script that requires FDA.
- `rules/phone-normalization.md` -- E.164 rules; US default.
- `rules/send-confirmation.md` -- confirmation-gate semantics, env overrides.
- `references/macos-permissions.md` -- canonical permissions matrix (Automation + Accessibility + Full Disk Access). First-run walkthrough.
- `references/why-native.md` -- why this skill uses osascript+sqlite3 rather than steipete/imsg or the Anthropic plugin.

## Known limitations

- AppleScript cannot send tapbacks, edit, or unsend messages. These require Apple's private MessageKit API.
- AppleScript send to SMS or RCS (not iMessage) requires a paired iPhone via Continuity. No fallback on Mac-only.
- IDS service detection for phone handles is not always definitive without an authenticated `preferredFromID`. The skill compensates by consulting Messages.app's chat history as the second source, but a fresh handle the user has never messaged will fall through to `--service` refusal. Pass an explicit service to unblock cold sends.
- Delivery status beyond osascript handoff is NOT programmatically observable without reading chat.db. The skill intentionally does not read chat.db on the send path. Verify delivery in Messages.app UI.
- Inbound attachments: `chat.db` stores file paths only. The actual files live in `~/Library/Messages/Attachments/`. This skill returns paths; callers read files themselves if needed.
- Dates in chat.db are Apple-epoch nanoseconds (seconds since 2001-01-01 UTC). `history.sh` converts to ISO-8601 in local time; callers should expect string timestamps.
- **Rich-content messages return empty text.** When Messages.app receives a message with inline reply, link preview, or rich media, it stores the content in the `attributedBody` NSKeyedArchiver blob and leaves `text` NULL. `history.sh` returns empty string for those rows. A decoder lives on the roadmap; until then callers see the message exists but not what it said.
- macOS 14+ only. Earlier versions have a different chat.db schema and different `IDSIDQueryController` selectors.
- `contacts.sh find` requires Contacts framework (TCC "Contacts" access), which is a separate permission from Contacts.app Automation. Usually granted together, but if find returns empty where it shouldn't, check System Settings -> Privacy -> Contacts.
- `ids-query.m` uses Apple's private `IDS.framework`. Selectors are stable across macOS 12-15 but Apple reserves the right to change them. The binary fails loud (exit nonzero, `service=unknown`) rather than guessing.

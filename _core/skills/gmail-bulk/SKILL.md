---
name: gmail-bulk
description: Bulk Gmail operations across Adithya's 4 personal Gmail accounts using direct Gmail API + batchModify. Use for jobs that touch hundreds-to-thousands of messages (mass-trash, mass-archive, mass-label, bulk-unsubscribe via List-Unsubscribe one-click POSTs). Composes search -> inventory -> action -> audit. Independent of `gog` (separate OAuth client, separate refresh tokens). Use this NOT gog when the message count crosses ~50.
---

# Gmail Bulk

Direct Gmail API tool for bulk ops. Built because `gog gmail messages modify` is one-message-per-call with ~7s OAuth refresh overhead. This tool calls `users.messages.batchModify` (1000 messages per API call) so it finishes thousands of operations in seconds instead of minutes.

## Triggers

- "mass trash X", "delete every email from Y", "nuke all subscriptions", "clean up my inbox"
- Any job touching 50+ messages
- "unsubscribe from <list of senders>"
- "find every email matching X and Y, then Z"

Do NOT use for: single-message ops (use `gog`), sending mail (use `gog gmail messages send`), reading 1-5 messages (gog).

## Required caller inputs

- **Account.** Full email via `-a <email>`. Resolves via gog's `rules/account-routing.md`. If ambiguous, ask. Never guess.
- **Query.** Gmail search syntax. Always include `-in:trash` to skip already-trashed unless intent is to perma-delete trash.
- **Action.** One of: `trash`, `archive`, `delete-permanent`, `add-label`, `remove-label`, `unsubscribe`.

## Procedure

1. **Verify auth.** `python auth.py list`. If target account is missing, run `python auth.py add <email>` (browser flow). Refresh tokens persist in macOS Keychain under service `quantum-gmail-bulk`.
2. **Inventory.** `python inventory.py -a <email> -q '<query>' -o runs/<job>.jsonl`. Pulls every matching message ID + headers.
3. **Dry-run.** `python bulk.py -a <email> --action <action> --input runs/<job>.jsonl --dry-run` prints what will happen.
4. **Confirmation gate.** Require literal `CONFIRM` (uppercase, on its own line) before any destructive batch >5 items.
5. **Execute.** Drop `--dry-run`. Tool batches up to 1000 messages per `batchModify` call.
6. **Audit.** Tool writes `runs/<job>.audit.jsonl` with action + message ID + result. Surface counts.

## Destructive op classification

Same as gog skill: any batch >5 items needs the gate. The tool also enforces `--force` for `delete-permanent` (irrecoverable; not just trash).

## Auth model

- **Separate OAuth client from gog.** Created in Adithya's `claude` GCP project, named `quantum-gmail-bulk`, application type Desktop app.
- **Per-account refresh token in macOS Keychain.** Service: `quantum-gmail-bulk`, account: full email.
- **Scopes:** `https://www.googleapis.com/auth/gmail.modify` (covers search, modify, batchModify; does NOT include send -- intentional, send still goes through gog).
- gog's credentials at `~/Library/Application Support/gogcli/credentials.json` are **untouched**. This tool does not read them.

## Files

- `credentials/oauth_client.json` -- OAuth client config (client_id, client_secret). Created once. Gitignored.
- `auth.py` -- OAuth installed-app flow + Keychain storage.
- `inventory.py` -- search query -> JSONL of matching messages.
- `classify.py` -- (optional) Claude-driven classifier for ambiguous senders.
- `bulk.py` -- batch action runner. Uses `batchModify` and `batchDelete`.
- `unsubscribe.py` -- reads `List-Unsubscribe` headers, POSTs one-click URLs.
- `runs/` -- per-job inventory JSONL + audit JSONL.

## Budget

- Gmail API: 250 quota units / user / second (modify=5, batchModify=50). batchModify for 1000 messages = 50 units = fits in 1 second.
- 5000-message trash job: 5 batchModify calls = ~5 seconds total.

## Failure modes

| Symptom | Cause | Action |
|---------|-------|--------|
| `invalid_grant` | Refresh token revoked / expired | `python auth.py add <email>` to re-auth |
| `insufficientPermissions` | Scope missing | Confirm OAuth client granted `gmail.modify` |
| `quotaExceeded` | Rare with batchModify | Tool retries with exponential backoff |
| `Requested entity was not found` | Message already trashed/deleted | Tool logs and continues |

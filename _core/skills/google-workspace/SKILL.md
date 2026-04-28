---
name: google-workspace
description: Gmail, Google Calendar, and Google Drive across Adithya's 4 personal Gmail accounts via the `gog` CLI (steipete/gogcli, Homebrew). Toolkit-shape skill -- primitives that any workspace composes into workflows. Use for reading inbox, searching messages, sending email, listing/creating/modifying calendar events, searching/uploading/sharing Drive files, and switching accounts. Do NOT use for Workspace admin, service accounts, domain-wide delegation, Chat/Docs/Sheets/Slides, or non-Google services.
---

# Google Workspace (gog)

Thin wrapper over the `gog` CLI. Toolkit shape: this file documents verbs, routing, and safety rails. Callers compose them into workflows. The CLI itself is the verb reference: `gog gmail --help`, `gog calendar --help`, `gog drive --help`, `gog auth --help`.

Deliberately not MCP. CLI output is parsed with `-j` (JSON), zero always-on context cost.

## Triggers

"check my gmail", "what's on my calendar", "send email from <account>", "reply to <sender>", "schedule <event>", "block <time>", "find <query> in my inbox", "share <file>", "upload to drive", "what's in my drive folder <x>".

Do NOT fire for: Workspace admin (use GAM), service accounts, domain delegation, non-Google providers, Chat/Docs/Sheets/Slides/Tasks/Keep/Forms (gog supports them, this skill does not document them; extend before using).

## Required caller inputs

Every command MUST include:
- **Account.** Full email via `-a <email>`. Resolve via `rules/account-routing.md`. If ambiguous, ask. Never guess.

For Gmail send: recipients, subject, body. Never guess.
For Calendar create: calendar alias/ID, title, start, end. Timezone defaults to America/Chicago.
For Drive upload: absolute local path, target folder name/ID/root.

If any required field is missing, stop and ask.

## Procedure

1. **Verify auth.** `gog auth list --check`. If target account is expired or missing: `gog auth add <email>` (browser flow). The OAuth app is in Testing mode -- refresh tokens expire every 7 days per account.
2. **Pick account.** Resolve via `rules/account-routing.md`. Pass full `-a <email>` on every command for outbound ops (aliases are mutable state and can drift; reads MAY use aliases).
3. **Dry-run destructive ops.** For Gmail send; Calendar create; any Calendar modify of time/attendees/status; Calendar delete; Drive delete; Drive upload >100 MB OR with permission changes; any modify across 5+ items: run with `-n` first and surface the intended action.
4. **Confirmation gate.** Require literal `CONFIRM` (uppercase, on its own line) before executing any op from step 3. "yes", "go", "send it" do NOT count.
5. **Execute.** Drop `-n`. Add `-j` whenever the agent will parse output. Forward JSON to caller or save to the stage's output path.
6. **Audit.** Run the table below. Surface any failure.

## Destructive op classification

Destructive (require dry-run + `CONFIRM`):
- `gog gmail messages send` (every send)
- `gog gmail thread modify` involving `SPAM`/`TRASH`, OR over 5 threads
- `gog calendar create` (every create)
- `gog calendar events modify` of time, attendees, or status
- `gog calendar event delete` (every delete)
- `gog drive delete` (trash IS destructive; `--permanent` is irrecoverable)
- `gog drive upload` >100 MB OR with sharing/permission change
- `gog drive copy` outside own My Drive
- `gog auth remove <email>`
- Any `gog <domain> modify` batch >5 items

Non-destructive (skip the gate): all `get`/`list`/`search`/`ls`/`info`/`show`; archive (remove `INBOX`) and mark-read (remove `UNREAD`) on self-owned threads; custom-label apply/remove; Drive `get`/`download`/`mkdir`/`copy` within own My Drive; Drive `upload` <100 MB with no permission changes.

When in doubt, treat as destructive.

## Audit

| Check | Pass condition |
|-------|----------------|
| Account specified | Every command included `-a <email>` |
| Correct account | Matches the routing rule for this task |
| JSON when parsing | `-j` set on any command whose output is interpreted |
| Destructive op confirmed | `CONFIRM` received, OR op was read-only |
| No silent send-block | If caller asked to send, agent did NOT keep `--gmail-no-send` |
| Token healthy | No unhandled `invalid_grant` |
| Secrets safe | OAuth client JSON never printed; refresh tokens never extracted |

## Budget

- Access tokens last ~1h. Refresh tokens (Testing mode) expire every 7 days, per account.
- Gmail send: cap 50/account/hour. Google personal-account limits kick in around 100.
- Calendar create-with-attendees: cap 20/account/hour.
- Drive: 20k queries/100s/account. Not a practical limit.

## Secrets hygiene

The agent MUST NOT read, `cat`, print, or transmit:
- `~/.shakos/secrets/gogcli-oauth-client.json` (client_id + client_secret)
- `~/Library/Application Support/gogcli/config.json`
- Refresh tokens in macOS Keychain (service `gogcli`). `security find-generic-password` is forbidden.
- `GOG_ACCESS_TOKEN` env values

Token health is checked via `gog auth list --check`, never by reading secret files. Both secret paths are outside the QUANTUM git tree.

Env policy: do NOT set `GOG_ACCOUNT` (skill requires explicit `-a`). Do NOT set `GOG_ACCESS_TOKEN` (bypasses auth hygiene).

## Failure modes

| Symptom | Cause | Action |
|---------|-------|--------|
| `invalid_grant` | Refresh token expired (7-day Testing limit) | `gog auth add <email>` |
| `access_denied` | Scope mismatch / user revoked | Re-run `gog auth add <email>`; re-grant scopes |
| `quotaExceeded` | Hit Google per-user quota | Back off, report, do not silently retry |
| `insufficientPermissions` | Token missing scope | Re-auth with full scope set |

## Files

- `rules/account-routing.md` -- which account for which task. Source of truth.

## Known limitations

- OAuth in Testing mode: 7-day refresh-token expiry. Publishing triggers Google verification for sensitive scopes (Gmail+Drive); not worth it for a 4-account personal setup.
- `--gmail-no-send` is Gmail-only. No blanket-block for Calendar/Drive writes; rely on `CONFIRM`.
- `gog` is single-maintainer (steipete). If upstream stalls, vendor or fork.
- Docs/Sheets/Slides/Chat/Tasks/Keep/Forms supported by `gog` but not documented here. Extend before using.

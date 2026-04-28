---
name: slack
description: Send and read Slack messages as Adithya (not a bot) via a user OAuth token (xoxp) against the Web API. Native Node fetch, zero deps, token in macOS Keychain. Toolkit shape - primitives that any workspace composes into workflows. Use for DMs, channel posts, reading history, search, resolving users and channels. Do NOT use for bot apps, Slash commands, Events API subscribers, Workflow Builder, or Enterprise Grid admin.
---

# Slack (xoxp user token)

Slack Web API primitives for sending and reading messages AS Adithya on `eclipse-labs.slack.com`. Thin wrapper over Slack's REST endpoints using native Node fetch. Token lives in macOS Keychain, never on disk, never in the repo.

Deliberately NOT using MCP. Rationale: a Slack MCP adds a persistent tool surface in every session for a skill that is rarely invoked; a 250-line Node CLI reading one keychain entry is strictly less bloat and leaves no global state.

Deliberately NOT using the official `slack` CLI either: that tool is scoped to app development (manifests, local dev servers, deploys), not to "send a message as me". Wrong tool.

## When this fires

Trigger phrases (non-exhaustive): "send slack", "slack message", "message on slack", "dm <name> on slack", "post to #channel", "read #channel in slack", "what's new in #channel", "search slack for X", "who is <name> on slack", "who's in #channel".

Do NOT fire for:
- Bot or app development (events, slash commands, modals, workflows, Block Kit app design).
- Enterprise Grid admin, SCIM, user provisioning, audit logs.
- Huddles, Canvas editing, Lists, Workflow Builder.
- Any non-Slack service (Discord, Teams, Matrix, IRC).

## Required caller inputs

For every command:
- **Account** - which Slack workspace. Resolve by env or default. Currently only `eclipse-labs` configured.

For send:
- **Target** (`#channel`, `@user`, or raw Slack ID) and **text**. Never guess either. Body can come via stdin if long.

For read / search / users / channels:
- **Target or query**. Read without a target is an error.

If any required field is missing, stop and ask.

## Procedure

1. **Verify auth.** Run `node scripts/run.mjs whoami`. Confirm `ok: true` and the expected user/team. If the token is invalid, rotate it (see `references/scopes.md` and `rules/rotate.md` once added).
2. **Pick account.** Default is `eclipse-labs`. Override with `SLACK_ACCOUNT=<name>` env var. Token resolves from Keychain `service=quantum-slack, account=<name>`.
3. **Preview writes.** For `send`, print the target and body to stderr before the API call. Default is send-immediately (mirrors iMessage, see `rules/send-gate.md`). Opt-in `QUANTUM_SLACK_REQUIRE_CONFIRM=1` gates on the literal `CONFIRM` token.
4. **Execute.** Run the verb. Responses are JSON on stdout; errors on stderr with non-zero exit.
5. **Audit.** Run the Audit table below.

## Verbs

| Verb | Usage | What it does |
|------|-------|--------------|
| `whoami` | `node scripts/run.mjs whoami` | `auth.test`: confirms token, prints user/team/URL |
| `send` | `node scripts/run.mjs send <target> <text...>` | Posts via `chat.postMessage`. Target resolves `#chan`, `@user`, or raw ID. Body from argv or stdin. |
| `read` | `node scripts/run.mjs read <target> [--count=N]` | Last N via `conversations.history`. Oldest-first. |
| `history` | `node scripts/run.mjs history <target> [--oldest=<ts>] [--latest=<ts>] [--max=N]` | Bulk cursor-paginated history. NDJSON to stdout (one message per line). Respects 429 Retry-After with exponential sleep. For bulk archival ingest, not for interactive reads. |
| `search` | `node scripts/run.mjs search <query...>` | `search.messages`, 20 hits, newest first. User-token-only endpoint. |
| `users` | `node scripts/run.mjs users [query]` | Fuzzy match across name / real_name / display_name. Top 50. |
| `channels` | `node scripts/run.mjs channels [query]` | List public + private channels you're in. Top 100. |
| `dm-open` | `node scripts/run.mjs dm-open <@user\|UserID>` | Opens IM, prints the DM channel ID. Useful for scripting. |

Slack Web API is the authoritative surface for edge cases. Do not re-document endpoints here: `https://api.slack.com/methods` is the source of truth.

## Audit (Pattern 12)

| Check | Pass condition |
|-------|----------------|
| Token scope sufficient | The verb's required scope is in `auth.test` response headers (see `references/scopes.md`) |
| Target unambiguous | Target resolved to exactly one channel/user, not a prefix-collision hit |
| Body preserved | Newlines and code blocks survived round-trip (fenced ``` blocks untouched) |
| Send gate honored | If `QUANTUM_SLACK_REQUIRE_CONFIRM=1`, user typed literal `CONFIRM` |
| No token leak | Token never printed to stdout, stderr, or logs |
| Error surfaced | Non-`ok` responses raised; Slack `error` field included in the failure message |

## Budget and limits

- `chat.postMessage`: Tier 4 (100+/min, effectively uncapped for user automation). Slack's abuse detector kicks in around 1/sec sustained to the same channel.
- `conversations.history` / `users.list` / `conversations.list`: Tier 2 (~20/min). Paginate with cursors, don't hammer.
- `search.messages`: Tier 2, user-token only (bot tokens cannot search). Usable for ad-hoc queries, not for crawling.
- Slack rate-limit response is HTTP 429 with `Retry-After`. The script raises; caller decides whether to sleep and retry.

## Files

- `scripts/run.mjs` - single-file CLI. Native Node fetch. No `npm install` needed.
- `references/scopes.md` - currently granted scopes, nice-to-have scopes, how to add more in the Slack app config.
- `rules/send-gate.md` - when the `CONFIRM` gate fires and when it does not.

## Security notes

- Token is `xoxp-*`, a USER token. It acts as Adithya everywhere. Treat like a password.
- Storage: macOS Keychain `service=quantum-slack, account=<workspace-slug>`. Never write the token to files, env exports in shell history, or shell aliases. The script reads Keychain at call time.
- Rotation: at `api.slack.com/apps/<app-id>/oauth`, revoke and regenerate. Update Keychain via `security add-generic-password -s quantum-slack -a <workspace> -w "xoxp-..." -U`. No other file touches required.
- If a token appears in chat, logs, or a commit, rotate immediately. Slack's token leak detector may also revoke it automatically.

## Known limitations

- Single workspace (`eclipse-labs`) configured. To add more: create a Slack app in that workspace with the same user scopes, install, store the `xoxp-` in Keychain under a new account name, call with `SLACK_ACCOUNT=<new-name>`.
- Private channel enumeration requires `groups:read` which is NOT currently granted. You can still post to and read from private channels if you already know the channel ID or use `search` to find them.
- Group DM send (`mpim:write`) and read (`mpim:read`) not currently granted. Add in app config if needed.
- File uploads not implemented. Add via `files.uploadV2` (external upload flow) when needed.
- No thread-reply affordance in `send` yet. Pass `thread_ts` through the API by extending the script's `send` verb when a workflow needs it.
- Slack app is single-workspace (Classic OAuth install). For multi-workspace distribution a public app + directory submission would be required; not relevant for personal use.

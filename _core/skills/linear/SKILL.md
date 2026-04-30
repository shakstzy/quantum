---
name: linear
description: Read and write Linear issues, projects, comments, cycles, labels, and teams via the linctl CLI (Go/Cobra). Personal API key auth, JSON-first output, full Linear surface including raw GraphQL escape hatch. Use for listing/searching/creating/updating issues, threading comments, querying projects and cycles, managing labels, and inspecting agent sessions. Do NOT use for Linear's marketing site, public OAuth integrations, or anything outside Adithya's personal Linear workspace.
---

# Linear (linctl + macOS Keychain)

Linear API primitives via `linctl` (`dorkitude/linctl` v0.1.8, Go/Cobra, MIT). Token lives in macOS Keychain `service=quantum-linear`; linctl also caches a copy at `~/.linctl-auth.json` (mode 600) for fast non-interactive calls.

Deliberately NOT using Linear's official MCP. Rationale: an MCP adds a persistent 20+ tool surface in every session for a tool used ad-hoc. A single Cobra binary that loads only when a trigger fires is strictly less context bloat. Adithya called this out explicitly when picking the install path.

## When this fires

Trigger phrases (non-exhaustive, semantic): "list my linear issues", "what's assigned to me in linear", "search linear for X", "create a linear issue", "start <issue-id>", "update <issue-id>", "assign <issue-id>", "comment on <issue-id>", "what's the status of <issue-id>", "show me the <project> project in linear", "what cycle am I in", "list linear teams", "linctl <verb>".

Do NOT fire for:
- Linear's marketing site or public docs.
- Building a public OAuth Linear integration for third-party users.
- GitHub PR creation (that goes through `gh`; linctl can read the linked Linear issue but the PR itself is `gh pr create`).
- Slack/Notion/Discord routing - those have their own skills.

## Auth model (IMPORTANT)

Token is a **personal API key** (`lin_api_*`) tied to Adithya's `outerscope.xyz` Linear account. It acts AS Adithya - anything `linctl` writes is attributed to him, no bot prefix.

- **Canonical store:** macOS Keychain `service=quantum-linear, account=$USER`.
- **Working copy:** `~/.linctl-auth.json` (mode 600), written by `linctl auth login`. linctl reads this file on every invocation; it does NOT honor `LINEAR_API_KEY` env var for `whoami`/most reads in current versions.
- **Re-auth:** `security find-generic-password -s quantum-linear -a "$USER" -w | linctl auth login -p` rewrites the on-disk file from keychain. No interactive prompt needed.
- **Rotation:** at `linear.app/settings/api`, revoke + create new key. Then: `security add-generic-password -U -a "$USER" -s quantum-linear -w 'lin_api_NEW'` and re-run the re-auth one-liner above.

If a token leaks to chat, logs, or a commit: rotate immediately at the URL above.

## Hard rules (footguns)

These are NOT obvious from the help text. Read every time before running list/search verbs.

1. **6-month default filter.** `linctl issue list`, `linctl issue search`, and `linctl project list` only return items created in the last 6 months by default. To go further back: append `--newer-than 1_year_ago` or `--newer-than all_time`. If a user asks "what issues did I file last year about X" and you forget this, you'll silently return zero hits.
2. **Completed/canceled filtered out by default** on `issue list` and `issue search`. Append `--include-completed` to see them. For archived issues in `issue search`, also add `--include-archived`.
3. **Always pass `--json` (or `-j`) for reads.** This is the Quick Start guidance from linctl's own README directed at Claude/Cursor/Gemini. The default table output wastes tokens and is hard to parse reliably. Writes can stay default-mode if the user wants to see the confirmation, but reads are always JSON.
4. **Issue IDs are `TEAM-NUM`** (e.g. `ENG-123`), not UUIDs. Most verbs accept either, but the human-friendly form is what shows up in URLs and commits.
5. **Team scoping.** `linctl issue list` without `--team` returns issues across **all teams** Adithya has access to. To narrow, pass `--team <KEY>` (e.g. `--team OUT` for Outerscope). There is no `--all-teams` flag - omitting `--team` is the cross-team mode.
6. **No `issue mine` verb.** The way to list issues assigned to Adithya is `linctl issue list --assignee me --json`. (The schpet/linear-cli has `issue mine`; linctl does not.)

## Required caller inputs

For every verb:
- **None** for reads - auth file already on disk.

For writes (`issue create`, `issue update`, `comment create`, `project create`, etc.):
- Confirm the team and title with Adithya before firing if not specified. Do not invent a team slug.
- For status changes (`issue update --state <name>`), use the exact state name from `linctl team state list <team> --json` - the matcher is fuzzy but case-sensitive on tokens.

## Procedure

1. **Verify auth.** `linctl whoami --json`. Confirm `authenticated: true` and `user.email == adithya@outerscope.xyz`.
2. **Resolve target.** If the user named an issue by partial title, run `linctl issue search "<query>" --json --include-completed --newer-than all_time` and disambiguate if multiple hits.
3. **Preview writes.** For `issue create`, `issue update`, `comment create`, `project create`, print the resolved fields to stderr before the call. No `CONFIRM` gate by default - Linear writes are reversible (un-archive, edit, delete comment) and the token is scoped to Adithya's own account.
4. **Execute.** Run the verb with `--json` (reads) or default mode (writes Adithya wants to see). Errors land on stderr with non-zero exit.
5. **Audit.** Run the Audit table below.

Gate exception: cross-account or destructive ops (delete a project, bulk archive issues, change a team's default state, mention a delegated agent) require an explicit `CONFIRM` from Adithya in chat before firing.

## Verbs

| Verb | Usage | What it does |
|------|-------|--------------|
| `whoami` | `linctl whoami --json` | Confirms token and identity. |
| `auth status` | `linctl auth status` | Quick auth health check (no JSON output, plaintext). |
| `issue list` (assigned to me) | `linctl issue list --assignee me --json [--newer-than all_time]` | Issues assigned to Adithya. Respects 6-month filter unless `--newer-than` overridden. |
| `issue list` | `linctl issue list --json [--team T] [--assignee EMAIL\|me] [--state S] [--cycle current\|N] [--priority 0-4] [--include-completed] [--newer-than ...] [--limit N]` | Filtered issue list. Omit `--team` to list across all teams. |
| `issue search` | `linctl issue search "<query>" --json [--team T] [--include-completed] [--include-archived]` | Full-text search. |
| `issue get` | `linctl issue get <ID> --json` | Single issue with comments, attachments, relations. |
| `issue create` | `linctl issue create --team T --title "..." [--description "..."] [--priority N] [--assignee me] [--label X]` | New issue. |
| `issue update` | `linctl issue update <ID> [--title ...] [--state ...] [--assignee ...] [--priority N]` | Patch fields. |
| `issue assign` | `linctl issue assign <ID> [--user me\|<email>]` | Assign or self-assign. |
| `issue attach` | `linctl issue attach <ID> --url <url> [--title ...]` | Attach a URL or GitHub PR. |
| `comment list` | `linctl comment list <ID> --json` | All comments on an issue. |
| `comment create` | `linctl comment create <ID> --body "..."` | New comment. Body via stdin if multi-line. |
| `comment update` | `linctl comment update <COMMENT_ID> --body "..."` | Edit. |
| `comment delete` | `linctl comment delete <COMMENT_ID>` | Delete (Adithya-authored only). |
| `project list` | `linctl project list --json [--team T] [--newer-than ...]` | Project rollup. 6-month default filter. |
| `project get` | `linctl project get <ID> --json` | Single project with milestones. |
| `project create` | `linctl project create --team T --name "..." [--description "..."]` | New project. |
| `team list` | `linctl team list --json` | All teams. |
| `team state list` | `linctl team state list <team> --json` | Workflow states for a team (use this before `issue update --state`). |
| `label list` | `linctl label list --json [--team T]` | Labels. |
| `user me` | `linctl user me --json` | Same as `whoami` but with full user fields. |
| `agent` | `linctl agent <ID> --json` | Inspect agent session for an issue (delegations, mentions). |
| `graphql` | `cat query.graphql \| linctl graphql --variables '{"k":"v"}'` | Escape hatch - raw Linear GraphQL with linctl auth. Use sparingly when a verb doesn't cover the need. |

linctl's `docs` verb (`linctl docs`) renders the upstream README. Do not re-document endpoints here - README is the source of truth.

## Audit (Pattern 12)

| Check | Pass condition |
|-------|----------------|
| Token valid | `whoami --json` returned `authenticated: true` and `email == adithya@outerscope.xyz` |
| Default filter awareness | If a user asks about issues older than 6 months, the call included `--newer-than` |
| State filter awareness | If a user asks about completed/canceled issues, the call included `--include-completed` |
| Output format | Reads used `--json`; writes default mode is OK if user wanted human-readable confirmation |
| ID form | `TEAM-NUM` form preferred over UUIDs in command-line args |
| State name match | `issue update --state X` was preceded by `team state list` to confirm `X` exists for that team |
| Write scoped | Writes only touch issues/projects the user explicitly named; no cross-team "helpful" updates |
| Body preserved | Multi-line comment/description bodies passed via stdin, not argv (preserves newlines) |
| No token leak | Token never printed to stdout, stderr, logs, or chat |

## Budget and limits

- **Rate limit:** Linear's GraphQL API allows ~1500 req/hour per user token. linctl batches where it can; bursty agent loops can hit this. Surface 429s as errors, do not retry in tight loops.
- **Bulk ops:** No native bulk verbs. Looping `issue update` over a list of IDs is fine for ≤50; beyond that, use `graphql` with a multi-issue mutation to stay under rate limits.
- **Pagination:** linctl auto-paginates list/search up to 250 items by default. Override with `--limit N` (max ~500 per call before Linear API caps).

## Files

- `/opt/homebrew/bin/linctl` - binary (Homebrew, `dorkitude/linctl/linctl` formula).
- `~/.linctl-auth.json` - working credential cache (mode 600). DO NOT commit; not under QUANTUM control.
- macOS Keychain `service=quantum-linear, account=$USER` - canonical mirror; survives binary reinstall.
- This file - `_core/skills/linear/SKILL.md`. No `scripts/` dir; linctl is the script.

## Security notes

- Token grants full read+write to Adithya's Linear workspace AS Adithya. Treat like a password.
- The on-disk `.linctl-auth.json` is mode 600. Confirm with `ls -la ~/.linctl-auth.json` before assuming.
- Never paste the token into chat, commit messages, gists, or any tool argv that gets logged. linctl reads from disk; you never need to pass it inline.
- Rotation drill (also documented in Auth model above): revoke at `linear.app/settings/api` → `security add-generic-password -U` → re-auth one-liner.

## Known limitations

- **Personal-account auth only.** linctl does not support OAuth or workspace bots. Anything written is attributed to Adithya.
- **Cycle creation/edit not exposed** as a top-level verb; use `graphql` for cycle mutations if needed.
- **Reaction/emoji ops not supported.** Linear's API has them; linctl doesn't wrap them yet.
- **No webhook/subscription support.** linctl is request/response only. For "notify me when X happens," wire a Linear webhook → your own handler, not through this skill.
- **Sub-issue tree builds** require multiple `issue create --parent <ID>` calls; no single-shot tree builder.
- **Markdown in descriptions/comments** passes through as-is - Linear renders it. Tables and complex embeds may render imperfectly; preview before bulk publishing.

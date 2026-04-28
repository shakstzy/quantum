---
name: notion
description: Read and write Notion pages, databases, and blocks via the official Notion REST API. Native Node fetch, zero deps, internal-integration token in macOS Keychain. Toolkit shape - primitives any workspace composes into workflows. Use for searching pages, reading/appending page content, creating pages under a parent, and querying databases. Do NOT use for Notion's marketing site, Notion Calendar, Notion Mail, Notion AI chat, or building public OAuth integrations.
---

# Notion (internal integration token)

Notion API primitives for reading and writing Adithya's Notion workspace (`RENAISSANCE`). Thin wrapper over Notion's REST v1 using native Node fetch. Token lives in macOS Keychain, never on disk, never in the repo.

Deliberately NOT using MCP. Rationale: a Notion MCP adds a persistent 15+ tool surface in every session for a playbook that is usually invoked ad-hoc; a single-file Node CLI reading one Keychain entry is strictly less bloat and loads only when a trigger fires.

Deliberately NOT using a browser automation playbook. The official API is stable, auth is a long-lived token, and everything Adithya needs today (search, page read/write, db query) is covered by REST.

## When this fires

Trigger phrases (non-exhaustive, semantic): "search notion for X", "look up <page> in notion", "what's on my <page> notion page", "read my notion page <title>", "add a page to notion under <parent>", "create a page in notion", "append to <page> in notion", "write this to notion", "query the <db> database in notion", "what's in the <db> notion database", "pull rows from <db> in notion".

Do NOT fire for:
- Notion's marketing site, Notion Calendar (separate product), Notion Mail, Notion AI chat.
- Building a public OAuth Notion integration for third-party users.
- Scraping Notion via a browser when the API would work.
- Any non-Notion knowledge tool (Obsidian, Roam, Coda, Confluence).

## Integration model (IMPORTANT)

Notion internal integrations are **scoped by explicit page sharing**. The integration only sees pages and databases where it has been added via the page's `...` menu -> **Connections** -> integration name. An unshared page returns 404 or empty search results even though the token is valid.

Default workspace: `RENAISSANCE` (Adithya's personal). Integration name: `CLAUDE`. If Adithya asks for a page and the search returns empty, the most likely cause is the page isn't Connected to the integration - ask him to add the connection.

## Required caller inputs

For every verb:
- **Account** - which Notion workspace. Resolves from `NOTION_ACCOUNT` env (default `default`). Currently only `default` is configured.

For `page-get`, `block-append`, `db-query`, `db-get`:
- **Notion ID** - 32 hex chars, with or without dashes. Accept either the bare ID, a dashed UUID, or the trailing hex in a notion.so URL. The CLI normalizes to dashed UUID before calling.

For `page-create`:
- **Parent page ID** and **title**. Body markdown on stdin (optional). Database-parent creates are NOT supported yet (would need property schema inspection).

For `block-append`:
- Target block or page ID plus markdown body. Markdown on stdin, or space-joined argv. Supports `# / ## / ###` headings, `-` and `*` bullets, `1.` numbered, `> quotes`, fenced `code`, paragraphs. Lines > 2000 chars hard-split (Notion rich_text limit).

If any required field is missing, stop and ask.

## Procedure

1. **Verify auth.** Run `node scripts/run.mjs whoami`. Confirm `ok: true` and the expected workspace (`RENAISSANCE` by default).
2. **Resolve target.** If the user named a page by title, run `search "<title>" --filter page` and disambiguate if multiple hits. Use the `id` field from the top match.
3. **Preview writes.** For `page-create` and `block-append`, print the resolved parent + title (or first 200 chars of body) to stderr before the API call. No `CONFIRM` gate by default - Notion writes are trivially reversible (archive a page, delete a block) and the integration is scoped to Connected pages only.
4. **Execute.** Run the verb. Responses are JSON on stdout; errors on stderr with non-zero exit.
5. **Audit.** Run the Audit table below.

## Verbs

| Verb | Usage | What it does |
|------|-------|--------------|
| `whoami` | `node scripts/run.mjs whoami` | `GET /users/me`: confirms token, prints bot id, workspace, notion-version |
| `search` | `node scripts/run.mjs search <query...> [--filter page\|database]` | `POST /search`, 20 hits, newest first. Returns id, object, title, url, parent. |
| `page-get` | `node scripts/run.mjs page-get <id> [--no-children]` | `GET /pages/:id` + recursive `GET /blocks/:id/children` (depth cap 3). Returns title, props, and flattened child blocks. |
| `page-create` | `node scripts/run.mjs page-create <parent-page-id> <title...>` | `POST /pages` with page-parent. Body markdown on stdin optional. |
| `block-append` | `node scripts/run.mjs block-append <page-or-block-id> [markdown...]` | `PATCH /blocks/:id/children`. Markdown -> simple blocks. Auto-batches at 100 per request. |
| `db-query` | `node scripts/run.mjs db-query <db-id> [--filter <json>] [--sort <json>] [--max N]` | `POST /databases/:id/query`, paginated. Simplifies common property types (title, select, number, date, people, relation, etc.) into flat JSON. |
| `db-get` | `node scripts/run.mjs db-get <db-id>` | `GET /databases/:id`. Returns property schema (name -> type) without rows. |

Notion's API reference is the authoritative surface for edge cases. Do not re-document endpoints here: `https://developers.notion.com/reference` is the source of truth.

## Audit (Pattern 12)

| Check | Pass condition |
|-------|----------------|
| Token valid | `whoami` returned `ok: true` and the expected workspace |
| Target reachable | Integration is Connected to the page/db (no 404, no empty search for a page that should exist) |
| ID normalized | IDs passed to the API are dashed 8-4-4-4-12 UUIDs |
| Write scoped | Writes only touch pages/databases the user explicitly named; no "helpful" cross-page edits |
| Body preserved | Newlines, headings, and code fences survived markdown -> blocks conversion |
| No token leak | Token never printed to stdout, stderr, or logs |
| Rate-limit respected | 429s are surfaced to the caller; no tight retry loops |

## Budget and limits

- **Rate limit:** Notion averages ~3 requests/sec per integration. Bursts return HTTP 429 with `Retry-After`. The script surfaces 429s as errors; caller decides whether to sleep and retry.
- **Page size:** search and db-query return up to 100 per request; the CLI paginates via `next_cursor`.
- **Block append:** 100 blocks per `PATCH /blocks/:id/children` call. The CLI auto-batches for larger inputs.
- **Rich text:** 2000 chars per text node. The CLI hard-splits long lines into multiple text nodes inside one block.

## Files

- `scripts/run.mjs` - single-file CLI. Native Node fetch. No `npm install` needed.

## Security notes

- Token is an `ntn_*` **internal integration token**. It acts as the `CLAUDE` bot in the `RENAISSANCE` workspace. Treat like a password.
- Storage: macOS Keychain `service=quantum-notion, account=<workspace-slug>`, default account `default`. Never write the token to files, env exports in shell history, or shell aliases. The script reads Keychain at call time.
- Rotation: at `notion.so/my-integrations`, regenerate the secret. Update Keychain via `security add-generic-password -s quantum-notion -a default -w "ntn_..." -U`. No other file touches required.
- Scope: the integration only sees what Adithya Connects to it via page settings. This is a feature, not a bug.
- If a token appears in chat, logs, or a commit, rotate immediately.

## Known limitations

- **Single workspace** (`default` account) configured. To add a second Notion workspace: create a separate internal integration in that workspace, Connect it to the target pages, store its token under a new Keychain account name, call with `NOTION_ACCOUNT=<new-name>`.
- **Database-parent `page-create` not implemented.** Creating a row in a database requires inspecting and populating the db's property schema, which adds complexity the simple verb doesn't cover. Add when a workspace needs it.
- **Markdown is lossy.** The minimal parser handles headings, paragraphs, bullets, numbered lists, quotes, and fenced code. It does NOT handle: nested lists, tables, inline formatting (bold/italic/code), embedded links with custom text, images, callouts, toggles, columns. Reading preserves whatever structure Notion stores; writing is deliberately simple.
- **Block reads are flattened.** Rich text per block is concatenated to `plain_text`; inline links and annotations are dropped from the read output. The full block object is still inspectable by bypassing the CLI and hitting the API directly if needed.
- **No archive / delete verb.** Out of caution. If needed, extend with `page-archive <id>` (`PATCH /pages/:id` with `archived: true`).
- **No Notion Comments API.** Not wired; add if a workflow needs it.

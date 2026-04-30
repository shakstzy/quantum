# LinkedIn Workspace

Personal LinkedIn capability layer. Patchright-driven persistent Chrome profile + URL-navigation + innerText extraction + minimal structural-href selectors. Single user, single account, no paid APIs. Ban-aversion is priority #1.

This is **v0**: primitives only. Higher-level workflows (cold outreach campaigns, AI-drafted messages, follow-up sequences, lead gen) are out of scope and will plug on top in v1+.

## Architecture (post-pivot 2026-04-30)

Originally we built around LinkedIn's internal Voyager API (in-page `fetch()` + JSESSIONID-as-CSRF). On 2026-04-30 we discovered [stickerdaniel/linkedin-mcp-server](https://github.com/stickerdaniel/linkedin-mcp-server) (1708 stars, Apache 2.0, very actively maintained) and switched to its more drift-resistant approach:

- **No Voyager API.** Navigate to LinkedIn URLs, extract `main` innerText, return raw text. The LLM (Claude on the receiving end) parses the text when it needs structured data.
- **Structural href signals, not class-name selectors.** Connect / Message / Edit-intro state is read from anchor hrefs (`/preload/custom-invite/`, `/messaging/compose/`, `/edit/intro/`) which are language- and layout-independent.
- **Connect via deeplink**, not Connect-button click: `https://www.linkedin.com/preload/custom-invite/?vanityName=<id>` opens the invite dialog directly. We submit it via positional button indexing inside the dialog (no localized text matching).
- **Send-message via compose deeplink**: `https://www.linkedin.com/messaging/compose/?profileUrn=<encoded>&recipient=<urn>&screenContext=NON_SELF_PROFILE_VIEW&interop=msgOverlay`. Works for both established and new connections (the minimal `?recipient=<urn>` form does NOT — it shows a "Say hello" widget for non-connections).
- **One section = one navigation.** Each verb does exactly one page navigation. No combining endpoints.

We chose to stay with our own thin CLI workspace rather than wire the MCP server into Claude Code as a tool, because the MCP injects 13 tool definitions into every Claude conversation context. We mine the MCP's proven patterns; we do not run it in-process.

## What's wired

| Verb | Surface | Approach | Gate |
|---|---|---|---|
| `get-profile` | `npm run get-profile -- --profile <id>` | navigate → innerText | get_profile |
| `list-threads` | `npm run list-threads` | navigate `/messaging/` + click each thread to capture IDs | none |
| `get-conversation` | `npm run get-conversation -- --thread <id>` or `--profile <username>` | navigate `/messaging/thread/<id>/` | none |
| `send-dm` | `npm run send-dm -- --profile <id> --text "..."` | compose deeplink + humanType + Send | send_dm_to_connection / send_dm_to_non_connection |
| `send-connect` | `npm run send-connect -- --profile <id> [--note "..."]` | `/preload/custom-invite/?vanityName=` deeplink + dialog submit | send_connect |
| `accept-invite` | `npm run accept-invite -- --profile <id>` | `connectWithPerson` detects `incoming_request` → click inline Accept | accept_invite |
| `withdraw-invite` | `npm run withdraw-invite -- --profile <id>` | navigate `/mynetwork/invitation-manager/sent/` + match row + click Withdraw | withdraw_invite |
| `list-invites` | `npm run list-invites -- --direction received\|sent` | navigate manager → innerText | none |
| `search-people` | `npm run search-people -- --query "..."` | navigate `/search/results/people/?keywords=` → innerText | search_people |
| `pull` | `npm run pull` (daily, after launchd is wired) | inbox + threads + invites | per-action |
| `status` | `npm run status [--json]` | local files only | none |
| `diag` | `npm run diag [--url <u>]` | screenshot + page-text + structural-href survey | none (read-only) |
| `login` | `npm run login` | headful Chrome (interactive) | none |

All write CLIs default to `--dry-run`. Pass the literal `--send` token to actually execute.

## First-time setup

```
cd workspaces/linkedin
npm install            # postinstall runs `patchright install chromium`
npm run login          # headful Chrome, you log in by hand (handles 2FA, comply gate, captcha)
```

The persistent profile lives at `workspaces/linkedin/.profile/`. After login succeeds, all subsequent runs reuse it. Cookies, fingerprint, history persist across runs. Do NOT copy this dir to another machine — LinkedIn 2026 fingerprints hardware (per Gemini-Flash 2026-04-30 adversarial review).

## Paths

| Where | What |
|---|---|
| `workspaces/linkedin/.profile/` | Persistent Chromium user-data-dir |
| `workspaces/linkedin/config/caps.json` | Daily/weekly volume caps (editable) |
| `workspaces/linkedin/config/selectors.json` | (legacy) — most selectors are inlined now in `extractor.mjs` |
| `workspaces/linkedin/.dev-fixtures/` | Cached Voyager JSON for dev iteration (legacy, unused post-pivot) |
| `~/.quantum/linkedin/.halt` | Kill switch. If present, every CLI exits early. |
| `~/.quantum/linkedin/state/rate-state.json` | Daily counters (atomic-write) |
| `~/.quantum/linkedin/state/actions.ndjson` | Append-only action log |
| `~/.quantum/linkedin/quarantine/` | Old profiles auto-quarantined on hard ban-signal |
| `~/.quantum/linkedin/alerts/` | Markdown alert files written by ban-signal handler |
| `~/.quantum/linkedin/diag/<ts>/` | `diag` artifacts (screenshot, page-text, structural-anchor survey) |
| `raw/linkedin/<slug>-linkedin.md` | One file per LinkedIn person. Graph-linkable per QUANTUM raw-deposit rule. |

## Ban-aversion stack (priority #1)

Layered. Any single one can short-circuit a run.

1. **Halt-file check** at every entrypoint. `~/.quantum/linkedin/.halt` exists -> exit 2.
2. **Volume caps** in `config/caps.json`. **Bumped 2026-04-30 (Adithya has Premium):** 30 connects/day, 100/wk (Premium Career/Business hard ceiling; Sales Nav = 200/wk if confirmed). Cold-DM cap removed (200/day cosmetic ceiling); 50 DMs/day to existing connections; 200 profile fetches/day; 30 searches/day. Daily counters survive process restarts. Earlier 10/day, 50/wk values were conservative-by-default for a free account.
3. **Active-hours guard.** 09:00-19:00 CST, weekdays only by default. Edit `config/caps.json` to change.
4. **Pending-invite ceiling.** Before any `send_connect`, enforce <400 outstanding sent invitations. If above, force-withdraw the oldest 25 before adding more. The check visits `/mynetwork/invitation-manager/sent/` and counts rows with a Withdraw control. Per Gemini-Flash fix #4: the ban hammer drops at the ratio level, not the volume level.
5. **Rate-limit detection** before AND after every navigation. Checks: URL on `/checkpoint/`, `/authwall/`; body-text rate-limit phrases on error-shaped pages (no `<main>`, body < 2KB).
6. **Modal close** after every navigation (LinkedIn intersperses dismissable modals).
7. **Auto-quarantine on hard signal.** On `BanSignalError` (auth_wall, rate_limit_page), the persistent profile is moved to `~/.quantum/linkedin/quarantine/profile-<ts>-<signal>/` and `.halt` is tripped. Per Gemini-Flash fix #6: poking a flagged profile after a ban signal escalates to permanent IP-level ban.
8. **No programmatic re-login.** When `AuthError` fires, the operator runs `npm run login` manually. Auto-relogin loops are the canonical ban-trigger pattern.
9. **Messy-human behavior.** Between actions in `pull.mjs` we sprinkle micro-fidget / scroll / dwell. Every `burst_size` actions (default 8) we do a long cooldown (45-65 min) and browse the feed. 5% chance per inter-action of a 8-18 minute "distraction" pause. Per Gemini-Flash fix #2: 2026 behavioral ML detects "randomized consistency".
10. **Manual-login bootstrap.** `npm run login` is headful. The operator types creds, handles 2FA / OTP / device verification / comply gate by hand. We never auto-fill credentials.

## Selector drift (browser-skill self-heal protocol)

Per QUANTUM learning `2026-04-30-live-test-and-fix-browser-skills`: when a verb breaks, do **not** ask the operator. Instead:

1. Run `npm run diag -- --url <relevant page>` to dump screenshot + innerText + structural-anchor survey.
2. Read `~/.quantum/linkedin/diag/<ts>/selector-survey.json` — every key is a selector we depend on, the value tells you whether it matched + a sample `outerHTML`.
3. Patch `src/linkedin/extractor.mjs` (the structural anchors) or `src/linkedin/connection-state.mjs` (the action-area heuristics) — these are the only selector-bearing files post-pivot.
4. Re-run the failing verb. Confirm a real artifact (e.g. for `get-profile`, the markdown file has a non-empty `name:` and a non-empty `## Profile snapshot` with > 200 chars).
5. Send the patch to `codex exec` for a one-round review. Apply P0/P1 fixes.
6. Update the relevant section here in CLAUDE.md.

## What's NOT in v0 (explicit deferrals)

- AI message drafting (will integrate `humanizer` skill in v1).
- Auto-reply / inbound thread automation.
- Scheduled drip sequences.
- Sales Navigator / Recruiter surfaces.
- Multi-account.
- Posts, reactions, comments, newsletter, recommendations, endorsements.
- Company employee scrapes / company profiles (the MCP has these; we'll port if needed).
- Job search (the MCP has it; same).
- TLS/JA4 fingerprint hardening (Gemini-Flash fix #1) — flagged as CRITICAL but not landed in v0. Treat as known risk; mitigate via persistent-profile age + low volume until verified. v1 task.
- BrowserGate extension probing mitigation (Gemini-Flash fix #3) — flagged IMPORTANT. v1: install 2-3 noise extensions in the persistent profile.

## Tests

```
npm test   # identity + entity-store smoke (no live LinkedIn calls)
```

## Wiring on cron (do NOT enable until smoke passes)

Daily pull at 10:30 CST via launchd. The plist will live at `setup/com.shakstzy.quantum-linkedin-pull.plist` once `pull.sh` is verified end-to-end. Per QUANTUM learning `2026-04-28-plist-exists-is-not-loaded.md`: writing a plist file is not enough — `launchctl bootstrap` must succeed and the next scheduled fire must produce a non-trivial run.

Per QUANTUM learning `2026-04-28-launchd-needs-fda-for-chat-db.md`: this workspace doesn't touch chat.db, so Full Disk Access is not required. Standard launchd permissions are enough.

# LinkedIn Workspace

Capability layer for LinkedIn. Patchright-driven persistent Chrome profile + in-page Voyager API fetch + DOM fallbacks. Single user, single account, no paid APIs. Ban-aversion is priority #1.

This is **v0**: the primitives layer. Higher-level workflows (cold outreach campaigns, AI-drafted messages, follow-up sequences, lead gen) are explicitly out of scope and will plug on top in v1+.

## What's wired

| Verb | Surface | Transport | Gate |
|---|---|---|---|
| `get_profile` | `npm run get-profile -- --profile <id>` | Voyager | get_profile |
| `get_self_profile` | `npm run pull` (auto) | Voyager | none |
| `list_threads` | `npm run list-threads` | Voyager | none |
| `get_thread` | `npm run pull` (auto) | Voyager | none |
| `send_dm` | `npm run send-dm -- --profile <id> --text "..."` | Voyager (+ DOM fallback) | send_dm_to_connection / send_dm_to_non_connection |
| `send_connect` | `npm run send-connect -- --profile <id>` | DOM | send_connect (+ pending-ceiling enforcement) |
| `accept_invite` / `ignore_invite` | `npm run accept-invite -- --invitation-urn <u> --shared-secret <s>` | Voyager | accept_invite / ignore_invite |
| `withdraw_invite` | `npm run withdraw-invite -- --invitation-urn <u>` | Voyager | withdraw_invite |
| `list_invites` | `npm run list-invites -- --direction received\|sent` | Voyager | none |
| `search_people` | `npm run search-people -- --query "..."` | Voyager | search_people |
| `pull` | `npm run pull` (daily, after launchd is wired) | Voyager | per-action |
| `status` | `npm run status [--json]` | local files only | none |
| `diag` | `npm run diag [--url <u>]` | DOM | none (read-only) |
| `login` | `npm run login` | DOM (interactive) | none |

All write CLIs default to `--dry-run`. Pass the literal `--send` token to actually execute.

## First-time setup

```
cd workspaces/linkedin
npm install            # postinstall runs `patchright install chromium`
npm run login          # headful Chrome, you log in by hand (handles 2FA, comply gate, captcha)
```

The persistent profile lives at `workspaces/linkedin/.profile/`. After `login` succeeds, all subsequent runs reuse it. Cookies, fingerprint, history persist across runs. Do NOT copy this dir to another machine  -  LinkedIn 2026 fingerprints hardware (per Gemini-Flash 2026-04-30 adversarial review).

## Paths

| Where | What |
|---|---|
| `workspaces/linkedin/.profile/` | Persistent Chromium user-data-dir |
| `workspaces/linkedin/config/caps.json` | Daily/weekly volume caps (editable) |
| `workspaces/linkedin/config/selectors.json` | DOM selector chains for fallbacks |
| `workspaces/linkedin/.dev-fixtures/` | Cached Voyager JSON for dev iteration |
| `~/.quantum/linkedin/.halt` | Kill switch. If present, every CLI exits early. |
| `~/.quantum/linkedin/state/rate-state.json` | Daily counters (atomic-write) |
| `~/.quantum/linkedin/state/actions.ndjson` | Append-only action log |
| `~/.quantum/linkedin/quarantine/` | Old profiles auto-quarantined on ban-signal |
| `~/.quantum/linkedin/alerts/` | Markdown alert files written by ban-signal handler |
| `~/.quantum/linkedin/diag/<ts>/` | `diag` artifacts (screenshot, page-text, selector-survey) |
| `raw/linkedin/<slug>-linkedin.md` | One file per LinkedIn person. Graph-linkable per QUANTUM raw-deposit rule. |

## Ban-aversion stack (priority #1)

Layered. Any single one can short-circuit a run.

1. **Halt-file check** at every entrypoint. `~/.quantum/linkedin/.halt` exists -> exit 2.
2. **Volume caps** in `config/caps.json`. 10 connects/day, 50/wk (per Gemini-Flash 2026-04-30 adversarial review fix #3  -  community-tested values dropped vs. 2024). 5 cold DMs/day, 30 DMs to existing connections/day, 100 profile fetches/day, 30 searches/day. Daily counters survive process restarts.
3. **Active-hours guard.** 09:00–19:00 CST, weekdays only by default. Edit `config/caps.json` to change.
4. **Pending-invite ceiling.** Before any `send_connect`, enforce <400 outstanding sent invitations. If above, force-withdraw the oldest 25 (min age 14d) before adding more. Per Gemini-Flash fix #4: the ban hammer drops at the ratio level, not the volume level.
5. **CSRF refresh on every fetch.** `JSESSIONID` is pulled from the live cookie store *before* every Voyager call. Per Gemini-Flash fix: LinkedIn rotates JSESSIONID mid-session in 2026; cached values turn into 403s.
6. **Watchdog timer** on every in-page evaluate. Closes the page if Chromium hangs (OOM, captcha overlay, frozen V8). Surfaces as `BrowserUnresponsiveError`.
7. **Ban-signal detection** before AND after every Voyager call and DOM action. Checks: URL on `/checkpoint/`, `/uas/login`, `/authwall`; comply-gate selector; captcha selectors; OTP form; weekly-invitation-limit alert; HTTP 401/403/429.
8. **Auto-quarantine on hard signal.** On `BanSignalError` (auth_wall, http_401), the persistent profile is moved to `~/.quantum/linkedin/quarantine/profile-<ts>-<signal>/` and `.halt` is tripped. Per Gemini-Flash fix #6: poking a flagged profile after a ban signal escalates to permanent IP-level ban.
9. **No programmatic re-login.** When `AuthError` fires, the operator runs `npm run login` manually. Auto-relogin loops are the canonical ban-trigger pattern.
10. **Messy-human behavior.** Between Voyager calls we sprinkle micro-fidget / scroll / dwell. Every `burst_size` actions (default 8) we do a long cooldown (45–65 min) and browse the feed. 5% chance per inter-action of a 8–18 minute "distraction" pause. Per Gemini-Flash fix #2: 2026 behavioral ML detects "randomized consistency"  -  pure jittered XHR-only sessions get flagged faster than mixed activity.
11. **Manual-login bootstrap.** `npm run login` is headful. The operator types creds, handles 2FA / OTP / device verification / comply gate by hand. We never auto-fill credentials.

## Selector drift (browser-skill self-heal protocol)

Per QUANTUM learning `2026-04-30-when-a-browser-driven-skill-breaks`: when a verb breaks, do **not** ask the operator. Instead:

1. Run `npm run diag -- --url <relevant page>` to dump screenshot + page-text + selector survey.
2. Read `~/.quantum/linkedin/diag/<ts>/selector-survey.json` for which selector chains hit and which missed.
3. Patch `config/selectors.json`.
4. Re-run the failing verb. Confirm a real artifact (e.g. for `get-profile`, the markdown file has a non-empty `name:` and a non-empty `## Profile snapshot`).
5. Send the patch to `codex exec` for a one-round review. Apply P0/P1 fixes.
6. Update the relevant section here in CLAUDE.md.

## What's NOT in v0 (explicit deferrals)

- Personalized note on connect requests (defer per Gemini-Flash fix #5: free accounts have a hard monthly note cap; blank requests have higher acceptance in many niches anyway).
- Lead-gen ML / qualification.
- AI message drafting (will integrate `humanizer` skill in v1).
- Auto-reply / inbound thread automation.
- Scheduled drip sequences.
- Sales Navigator / Recruiter surfaces.
- Multi-account.
- Posts, reactions, comments, newsletter, recommendations, endorsements.
- Company employee scrapes.
- TLS/JA4 fingerprint hardening (Gemini-Flash fix #1)  -  flagged as CRITICAL but not landed in v0. Treat as known risk; mitigate via persistent-profile age + low volume until verified. v1 task.
- BrowserGate extension probing mitigation (Gemini-Flash fix #3)  -  flagged IMPORTANT. v1: install 2-3 noise extensions in the persistent profile.

## Tests

```
npm test    # parser tests + identity helpers + entity-store smoke (no live LinkedIn calls)
```

## Wiring on cron (do NOT enable until smoke passes)

Daily pull at 10:30 CST via launchd. The plist will live at `setup/com.shakstzy.quantum-linkedin-pull.plist` once `pull.sh` is verified end-to-end. Per QUANTUM learning `2026-04-28-plist-exists-is-not-loaded.md`: writing a plist file is not enough  -  `launchctl bootstrap` must succeed and the next scheduled fire must produce a non-trivial run.

Per QUANTUM learning `2026-04-28-launchd-needs-fda-for-chat-db.md`: this workspace doesn't touch chat.db, so Full Disk Access is not required. Standard launchd permissions are enough.

## Open risks (carry into v1)

1. **JA4 / TLS fingerprint mismatch**  -  patchright Chromium may not match the JA4 of the host's installed Chrome. Verify before scaling volume.
2. **BrowserGate extension probing**  -  install uBlock + 1Password (or similar) in the persistent profile to look "human."
3. **Voyager normalized+json+2.1 schema drift**  -  the parser handles both `dash` and legacy `voyager` namespaces but a major endpoint rewrite will require fixture re-record.
4. **DOM connect flow**  -  LinkedIn A/B-tests this most aggressively. Run `diag` early and often. The selector chains are designed to fall back gracefully but not all variants are covered.

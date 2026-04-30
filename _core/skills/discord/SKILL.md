---
name: discord
description: Read and send Discord messages AS Adithya (not a bot) using a real Chrome session driven by patchright. All Discord REST calls execute inside the page context against discord.com/api/v9, authenticated by session cookies in a persistent profile dir. Toolkit shape - primitives for DMs, channel posts, reading history, search, resolving friends and channels. Personal DMs work here where bot tokens cannot. Burner account recommended; main-account use is at your own risk.
---

# Discord (user session via patchright)

Discord REST primitives for sending, reading, and searching AS Adithya. Personal DMs included. Thin wrapper over `https://discord.com/api/v9/*` where every call runs inside a real Chrome session opened by patchright. Authentication is session cookies in a persistent profile dir; the Authorization header is captured live from Discord's own client and replayed inside the same page context.

Deliberately NOT using a Discord MCP. Rationale: every public DM-reading Discord MCP is user-token or browser-session based (same ToS surface as this skill) AND adds a persistent tool surface loaded into every session for a skill that is rarely invoked. A single-folder Node script driving one Chrome profile is strictly less bloat.

Deliberately NOT using a bot token. Rationale: bots cannot read your own DMs, cannot search your history, and post AS the bot instead of AS you. Bot tokens solve a different problem.

Deliberately NOT using raw `node fetch` against discord.com. Rationale: REST traffic with Node's TLS fingerprint and no matching browser Client Hints is the strongest possible selfbot signature. Running every call through a real Chrome page on discord.com gives real TLS/JA3, real Client Hints, real origin, and reuses Discord's own captured Authorization header.

## ToS note, read this first

Using your real account against the REST API programmatically is self-botting. Discord's policy at https://support.discord.com/hc/en-us/articles/115002192352 explicitly forbids automating a normal user account; violation can result in account termination. Detection is low but nonzero, especially if a REST-only client has no matching gateway WebSocket presence. Mitigation: keep Discord open in your normal client while the CLI runs (see `references/detection-mitigation.md`). Burner account recommended; main-account use is at your own risk.

## When this fires

Trigger phrases: "dm <name> on discord", "text <name> on discord", "message <name> on discord", "read my dms with <name>", "what did <name> last say on discord", "search my discord for <query>", "post in #<channel> on discord", "read #<channel> on discord", "who is <name> on discord".

Do NOT fire for:
- Running a Discord bot or app (events, slash commands, modals, activities). Different auth, different semantics.
- Moderating a server (kick, ban, role management) unless explicitly asked.
- Non-Discord services (Slack, iMessage, Telegram, Matrix).
- Posting to a Discord SERVER channel as the Zernio managed bot. That goes to `_core/skills/zernio-post/` (`platform: "discord"`), which sends via Zernio's centralized bot via REST to channels Adithya owns or where the Zernio bot is authorized. Triggers like "post in #ann on discord", "send announcement to discord server", "publish to my discord server" route there. This skill is explicitly for Adithya's PERSONAL account (DMs, group DMs, channels Adithya is a member of, posting as Adithya). If the user phrasing is ambiguous (just "post on discord" with no other signal), ASK whether they want the Zernio bot to post or their personal account.

## Required caller inputs

For every command:
- **Profile** which Chrome profile dir holds the session. Default `~/.quantum/chrome-profiles/discord/`. Override with `DISCORD_PROFILE_DIR=<path>`.

For send / dm:
- **Target** (`@friend`, `dm:<name>`, friend name, or numeric channel ID) and **text**. Never guess either. Body can come via stdin if long.

For read / search:
- **Target or query**. Read without a target is an error.

If any required field is missing, stop and ask.

## QUANTUM integration

| Item | Path / Value |
|------|--------------|
| Skill home | `_core/skills/discord/` |
| Profile dir | `~/.quantum/chrome-profiles/discord/` (persistent; cookies survive restart) |
| Pidfile | `~/.quantum/chrome-profiles/discord/.skill.pid` |
| Breaker file | `~/.quantum/chrome-profiles/discord/.breaker.json` |
| Breaker trip | Two consecutive 401/403s at runtime, or any captcha DOM during login |
| Breaker cooldown | 24h; `--force` to override, `reset-breaker` to clear manually |
| Auth probe | Successful GET `/users/@me` with captured token |

## First-time setup (once)

```bash
cd _core/skills/discord
node scripts/run.mjs login
```

The first invocation runs `npm install` to fetch patchright + Chrome (~300MB, 2-3 minutes). After that, opens a visible Chrome window pointed at discord.com. Log in (email + password + 2FA or QR code). The script waits for a successful authenticated API call from Discord's own client, captures the Authorization header into the page, confirms the session via `/users/@me`, and closes.

Future runs are silent; cookies in the profile dir authenticate every navigation and the page-side hook re-captures the header from the first real Discord client request.

Re-run `login` when a runtime verb reports a 401 (Discord invalidated the session on password change, log-out-everywhere, or suspicious-activity flag).

## Procedure

1. **Verify auth.** `node scripts/run.mjs whoami` boots Chrome silently, hits `/users/@me`, prints your user. Refuses to run if the profile has no valid cookies.
2. **Resolve targets.** Friend names resolve against `/users/@me/relationships`. `#channel` names require a guild ID. DM channels open/reuse via `POST /users/@me/channels`.
3. **Preview writes.** `dm` and `send` print the target and body to stderr before the API call. Immediate-send by default (mirrors iMessage and slack skills). `QUANTUM_DISCORD_REQUIRE_CONFIRM=1` opts into the literal `CONFIRM` gate.
4. **Execute.** Run the verb. JSON to stdout, errors to stderr, non-zero exit on failure.
5. **Respect rate limits.** CLI honors `Retry-After` on 429 and backs off automatically (up to 4 attempts).
6. **401 handling.** First 401 prints "token invalidated, run login" and exits. Two consecutive 401s in one invocation trip the breaker.

## Verbs

| Verb | Usage | What it does |
|------|-------|--------------|
| `login` | `node scripts/run.mjs login [--force]` | One-time visible browser login. Cookies persist to profile dir. |
| `whoami` | `node scripts/run.mjs whoami` | GET `/users/@me`, confirm session |
| `friends` | `node scripts/run.mjs friends [query]` | List friends, optional name filter |
| `list-dms` | `node scripts/run.mjs list-dms [--limit=N]` | Open DM channels, most recent first |
| `resolve-user` | `node scripts/run.mjs resolve-user <name\|id>` | Friend name -> user ID via friends list |
| `resolve-channel` | `node scripts/run.mjs resolve-channel <#name> --guild <id>` | `#name` -> channel ID (requires guild) |
| `dm` | `node scripts/run.mjs dm <target> <text...>` | DM friend (body via argv or stdin) |
| `send` | `node scripts/run.mjs send <channel-id> <text...>` | Post to a guild channel by numeric ID |
| `read` | `node scripts/run.mjs read <target> [--limit=N]` | Last N messages; target = friend name, dm:<name>, @<name>, or channel ID |
| `search` | `node scripts/run.mjs search <target> <query...>` | Search messages in a DM or channel |
| `status` | `node scripts/run.mjs status` | Profile + cookies + breaker + pidfile state |
| `reset-breaker` | `node scripts/run.mjs reset-breaker` | Reset 24h halt after manual intervention |

Discord REST is the authoritative surface for edge cases. Do not re-document endpoints here: `https://discord.com/developers/docs/reference` is the source of truth.

## Audit (Pattern 12)

| Check | Pass condition |
|-------|----------------|
| Session valid | `whoami` returns 200 and your user id |
| Target unambiguous | Friend name resolved to exactly one user id |
| Body preserved | Code fences and newlines survive round-trip |
| Send gate honored | If `QUANTUM_DISCORD_REQUIRE_CONFIRM=1`, user typed literal `CONFIRM` |
| No token leak | Authorization header never printed to stdout, stderr, or logs |
| Rate-limit respected | On 429, script slept per `Retry-After` then retried |

## Detection risk and mitigation

- **Keep Discord open in your normal desktop client or browser while the CLI runs.** Your real gateway connection is the cheapest camouflage; a REST-only account is the obvious selfbot signature.
- All API calls execute inside a real Chrome session, so TLS fingerprint, Client Hints, and Origin are real.
- Requests go serial, not parallel, by default. Burst-parallel reads trip abuse detection fast.
- Circuit breaker halts 24h on two consecutive 401/403s.
- See `references/detection-mitigation.md` for full risk surface and v2 heartbeat-WS roadmap.

## Files

- `scripts/run.mjs` dispatcher + all runtime verbs. Boots Chrome via patchright per call.
- `scripts/login.mjs` patchright login flow + signed-in detection. Only loads when `login` is invoked.
- `scripts/browser.mjs` patchright launcher, init-script token capture, pidfile, breaker.
- `package.json` patchright as the only dep; `postinstall` pins Chrome channel.
- `references/detection-mitigation.md` risk surface, why keep Discord open, heartbeat-WS roadmap.
- `references/token-extraction.md` manual DevTools fallback if patchright login breaks.
- `references/ban-procedure.md` what to do if the account gets flagged.
- `rules/send-gate.md` when the `CONFIRM` gate fires and when it does not.

## Security notes

- Session cookies are equivalent to the password. Profile dir is `chmod 700`.
- Authorization header captured at runtime is held in `window.__quantumDiscordToken` inside the page; never written to disk or env.
- Rotation: log out of all devices in Discord settings, then re-run `login`.
- If an Authorization value ever appears in chat, logs, or a commit, log out everywhere from Discord settings immediately.

## Known limitations (v1)

- No gateway WebSocket heartbeat. Runtime looks like REST-only traffic unless you keep Discord open elsewhere.
- Guild channel name resolution requires passing the guild ID explicitly. No global name cache yet.
- No voice, no reactions, no file uploads, no thread creation. Add when a workflow needs it.
- Search scope is per-channel; guild-wide search via `messages/search` is implemented but returns approximate counts.
- Single profile (`discord`). To add a burner: pass `DISCORD_PROFILE_DIR=~/.quantum/chrome-profiles/discord-burner` and run `login` again.

## Troubleshooting

| Problem | Action |
|---------|--------|
| `Session expired or never logged in` | Run `node scripts/run.mjs login` |
| 401 at runtime | Token invalidated; re-run `login` |
| 429 on every call | You're hammering. Serial, not parallel. Wait one minute. |
| `Profile locked by pid N` | Another login is in flight. Wait or kill pid. |
| Captcha in DOM during login | Complete captcha in the visible browser. If persistent, breaker halts 24h. |
| Friend not found | User isn't in your friends list. Pass user ID directly. |
| `BREAKER_HALTED` | Run `reset-breaker` only after you understand why it tripped. |

---
name: x-read
description: Read X (Twitter) threads, conversations, and a logged-in user's identity AS Adithya using a persistent Chrome session driven by patchright. Read-only by contract; the helper layer rejects every method except GET. Replays X GraphQL operations (TweetDetail, Viewer) via templates captured from X's own client, so per-request decoration like x-client-transaction-id, x-twitter-auth-type, bearer, and CSRF are reused intact. Uses Adithya's main Premium account by default; single-strike circuit breaker on any auth challenge.
---

# x-read (X/Twitter via patchright user session)

Single-thread read primitives for x.com AS Adithya. Read-only. v1 verbs: `login`, `whoami`, `thread`, `status`, `reset-breaker`.

Deliberately NOT using twscrape or twikit. Those need a burner-account pool with IMAP-verifiable inboxes and bring their own ban-fleet hygiene problem. v1 prioritizes "thread fetch works today against my real account" over scale; if and when burner pool is wired, a sibling `x-scrape` skill should handle mass scraping with twscrape.

Deliberately NOT a Twitter API v2 wrapper. Adithya does not want to pay for X API. The web GraphQL surface is what x.com uses for its own client and is the lowest-detection path.

Deliberately NOT carrying over the discord skill's storage-state snapshot/restore. X uses a `ct0` cookie for CSRF; resurrecting a stale ct0 from a snapshot causes silent 403s. Chrome's own cookie store handles persistence.

## ToS note, read this first

Driving an authenticated x.com session programmatically is automation under X's Developer Agreement and Automation Rules. Read-only patterns at human pace are low-signal but nonzero risk; enforcement is account-level, not just IP/profile. Mitigations the skill enforces:

- read-only by contract (GET-only at the helper layer)
- single-strike breaker on any auth challenge (24h halt; Adithya's main is Premium, so we fail closed)
- no request bursts; one verb invocation = one or two replayed requests
- single-tab Chrome session, real fingerprint via patchright

Mitigations the skill does NOT enforce: proxy/IP rotation, account aging, human-pace randomization. v1 is intended for occasional thread reads on Adithya's main; if usage frequency goes up, switch to a burner account by setting `X_READ_PROFILE_DIR` to a different path and running `login` against the burner.

## When this fires

Trigger phrases: "read this X thread", "summarize this tweet thread", "pull replies on <tweet-url>", "who am I logged in as on X", "fetch this twitter conversation".

Do NOT fire for:
- Posting / replying / liking / following / DMs on X. Read-only by design. Posting goes through `_core/skills/zernio-post/` (`platform: "twitter"`, account `my-twitter`).
- Mass scraping. Sibling `x-scrape` skill (not yet built) is the right place.
- Searching X. Out of scope for v1 (deferred to a `search` verb in v2).
- Reading user profile timelines. Out of scope for v1 (deferred).

## Required caller inputs

For `login`: nothing.

For `whoami`: nothing.

For `thread`: a tweet URL (`https://x.com/<handle>/status/<id>` or `https://x.com/i/status/<id>`) or a bare numeric tweet ID.

If any required input is missing, stop and ask.

## QUANTUM integration

| Item | Path / Value |
|------|--------------|
| Skill home | `_core/skills/x-read/` |
| Profile dir | `~/.quantum/chrome-profiles/x/` (persistent; cookies survive restart) |
| Pidfile | `~/.quantum/chrome-profiles/x/.skill.pid` |
| Breaker file | `~/.quantum/chrome-profiles/x/.breaker.json` |
| Breaker policy | Single strike (any auth challenge -> 24h halt) |
| Auth probe | Captured `Viewer` GraphQL response body from organic page traffic |
| Write verbs | None. The replay helper (`pageApi`, kept for v2) hard-rejects non-GET methods, ops outside an allowlist, and non-X URLs. v1 verbs do not call replay at all — they parse the X client's organic response bodies. |

Output destination: stdout JSON. The skill does NOT write to `raw/` itself — the caller decides whether a fetched thread is signal (promote to `raw/x/`) or bulk (keep ephemeral). This matches the higgsfield pattern: skills emit to stdout/skill-output, workspaces own `raw/` deposits.

## First-time setup (once)

```bash
cd _core/skills/x-read
node scripts/run.mjs login
```

A visible Chrome window opens at `x.com/login`. Sign in (handle + password + 2FA). The script waits up to 15 minutes for an authenticated GraphQL call to fire from X's own client; once captured, it closes the browser. Cookies persist in the profile dir.

## Procedure

1. **Resolve verb.** `whoami` for identity probe; `thread <url-or-id>` for conversation fetch.
2. **Boot session.** `launchContext({ visible: false })` from `browser.mjs` opens patchright Chrome with the persistent profile, attaches a CDP `Network.requestWillBeSent` listener for `/i/api/graphql/*` requests, navigates to a warm-up URL.
3. **Warm-up.** For `whoami`, navigate to `x.com/home` (X client fires `Viewer`). For `thread`, navigate to `x.com/i/status/<id>` (X client fires `TweetDetail` for the focal tweet). Wait up to 30s for the required op to land in the template map.
4. **Replay.** `pageApi(page, opName, template, { variables })` rebuilds the GET URL with merged variables, runs `fetch` from inside the x.com page context with the captured headers, returns `{status, ok, body, rateLimit}`. Method is forced to GET.
5. **Parse.** For `thread`, walk `data.threaded_conversation_with_injections_v2.instructions[].entries[]`, normalize each tweet result (handle Note Tweets, tombstones, media, author).
6. **Output.** Single JSON object to stdout.
7. **Close.** Tear down patchright context. Pidfile released.

## Failure modes (handled)

| Symptom | Detection | Action |
|---------|-----------|--------|
| Cookies expired | Auth challenge URL after warm-up nav | Trip breaker, exit 3, instruct `login` |
| Captcha / Arkose | warm-up redirected to `/i/flow/login` or `/account/access` | Trip breaker, exit 3 |
| QueryId rotated, op not seen | template map miss after 30s | Exit 3 with captured-ops list for debugging |
| 401 / 403 from replay | response status | Treat as session expired, exit 3 |
| 429 | response status | Read `x-rate-limit-reset` (UNIX timestamp -> seconds remaining), surface to caller, exit 4 |
| Profile dir locked | live PID in pidfile | Refuse launch |
| Tombstoned tweet | `__typename === 'TweetTombstone'` | Include in output with `tombstone` field, no text |

## Failure modes (NOT handled in v1)

- Cursor-paginated "show more replies" modules. v1 returns only primary entries surfaced by the first response. Caller is informed via `truncated_note` field in output.
- Sensitive-media interstitial. Tweet may return without media URLs.
- Quote-tweet recursion. We surface the immediate tweet's quoted_status only via `legacy.is_quote_status` flag if present; we do not recurse into the quoted tweet.
- Polls, cards, communities, Spaces. Out of scope.
- Edited tweets: `text` reflects the latest version per X's response; we don't emit edit history.
- Long videos / multi-variant media. We surface `media_url_https` per entity; we don't iterate variants.

## Audit (run after every `thread` invocation, before declaring done)

| Check | Pass condition |
|-------|----------------|
| Replay returned 200 | `res.ok === true` |
| Output has root | `out.root.id` matches the requested tweet ID |
| Output has at least 0 replies | `out.replies` is an array (may be empty for solo tweets) |
| `pageApi` rejected non-GET | trivially true; helper enforces |
| Breaker still healthy | `readBreaker().state === 'healthy'` |
| Truncation note present | output contains `truncated_note` so caller knows replies may be partial |

## Budget

- Sessions per minute: avoid more than 4. Each verb invocation cold-boots Chrome (~5-10s) and tears down. Bursting will trip account-level heuristics regardless of fingerprint quality.
- Replay calls per session: 1-2 in v1 (warm-up nav + optional explicit replay).
- No retry loop. If a replay fails, surface the error; don't auto-retry. (Future work: bounded retry on 429 only.)

## Files

- `package.json` — patchright dep, ESM
- `scripts/browser.mjs` — patchright launcher, CDP capture of full request templates, breaker, pidfile, GET-only `pageApi`, rate-limit-reset Unix-timestamp conversion
- `scripts/login.mjs` — visible login flow with single-strike breaker on challenge
- `scripts/run.mjs` — CLI: `login | whoami | thread | status | reset-breaker`
- `references/graphql-endpoints.md` — capture/replay strategy, cursor pagination caveats
- `references/detection-mitigation.md` — what's mitigated, what's not, what trips the breaker
- `rules/read-only.md` — read-only contract enforced at helper + verb + skill layers

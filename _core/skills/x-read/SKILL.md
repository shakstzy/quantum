---
name: x-read
description: Read X (Twitter) AS Adithya using a persistent Chrome session driven by patchright. Read-only by contract. Six verbs. login (one-time visible sign-in). whoami (your user object). thread (tweet + visible replies). profile (user profile + recent tweets). bookmarks (your saved tweets, Premium-unlimited). analytics (Premium account-overview metrics: impressions, engagements, profile visits, follows, time series). search (SearchTimeline with Top/Latest/People/Photos/Videos). All data comes from capturing the X client's organic GraphQL responses inside a real Chrome page; no replay HTTP from us in v1. Single-strike breaker on any auth challenge.
---

# x-read (X/Twitter via patchright user session)

Read primitives for x.com AS Adithya. Read-only by contract. Six verbs:

| Verb | What it does |
|------|--------------|
| `login` | One-time visible Chrome sign-in. Cookies persist. |
| `whoami` | Your user object (id, handle, name, premium, follower counts, bio). |
| `thread <url-or-id>` | A tweet + its visible reply tree, with quote/retweet unwrap. |
| `profile <handle>` | Profile (id, handle, name, bio, follower counts, verified) + first page of UserTweets. |
| `bookmarks [--limit=N]` | Your saved tweets (Premium has unlimited). Default limit 50, max 200. |
| `analytics` | Raw `viewer_v2` from `accountOverviewQuery`. Includes organic_metrics_time_series (Engagements, Impressions, ProfileVisits, Follows, Replies, Likes, Retweets, Bookmarks, Share). |
| `search <query>` | SearchTimeline. `--product=Top\|Latest\|People\|Photos\|Videos` (default Top). |
| `status` | Profile dir + cookies + breaker + pidfile state. |
| `reset-breaker` | Clear the 24h halt after manual verification. |

All verbs accept `--profile <name>` to swap accounts. Default profile (no flag) lives at `~/.quantum/chrome-profiles/x`. Each `--profile burner1`, `--profile burner2` etc gets its own dir at `~/.quantum/chrome-profiles/x-<name>` with isolated pidfile + breaker, so a burner tripping its breaker does not lock the main account. Sign in to each burner once via `login --profile burner1`, then run verbs with the same flag.

Deliberately NOT using twscrape or twikit. Those need a burner-account pool with IMAP-verifiable inboxes and bring their own ban-fleet hygiene problem. v1 prioritizes "works today against the real account" over scale; if and when burner pool is wired, a sibling `x-scrape` skill should handle mass scraping with twscrape.

Deliberately NOT a Twitter API v2 wrapper. Adithya does not want to pay for X API. The web GraphQL surface is what x.com uses for its own client and is the lowest-detection path.

Deliberately NOT carrying over the discord skill's storage-state snapshot/restore. X uses a `ct0` cookie for CSRF; resurrecting a stale ct0 from a snapshot causes silent 403s. Chrome's own cookie store handles persistence.

## ToS note, read this first

Driving an authenticated x.com session programmatically is automation under X's Developer Agreement and Automation Rules. Read-only patterns at human pace are low-signal but nonzero risk; enforcement is account-level, not just IP/profile. Mitigations the skill enforces:

- read-only by contract (GET-only at the helper layer; v1 verbs don't replay at all)
- single-strike breaker on any auth challenge (24h halt; Adithya's main is Premium, so we fail closed)
- no request bursts; one verb invocation = one navigation + one captured response
- single-tab Chrome session, real fingerprint via patchright

Mitigations the skill does NOT enforce: proxy/IP rotation, account aging, human-pace randomization. v1 is intended for occasional reads on Adithya's main; for higher volume, switch to a burner by setting `X_READ_PROFILE_DIR` to a different path and running `login` against the burner.

## When this fires

Trigger phrases (high confidence): "read this X thread", "summarize this tweet thread", "pull replies on <tweet-url>", "who am I logged in as on X", "fetch this twitter conversation", "show me <handle>'s recent tweets on X", "what did I bookmark on X", "show my X analytics", "how is my X account doing", "search X for <query>".

Do NOT fire for:
- Posting / replying / liking / following / DMs on X. Read-only by design. Posting goes through `_core/skills/zernio-post/` (`platform: "twitter"`, account `my-twitter`).
- Mass scraping. Sibling `x-scrape` skill (not yet built) is the right place.
- Tweet-level analytics (per-tweet impressions). v1 surfaces account-overview only; a `tweet-analytics` verb may land in v2.

## QUANTUM integration

| Item | Path / Value |
|------|--------------|
| Skill home | `_core/skills/x-read/` |
| Profile dir | `~/.quantum/chrome-profiles/x/` (persistent; cookies survive restart) |
| Pidfile | `~/.quantum/chrome-profiles/x/.skill.pid` |
| Breaker file | `~/.quantum/chrome-profiles/x/.breaker.json` |
| Breaker policy | Single strike (any auth challenge -> 24h halt) |
| Auth probe | `whoami` navigates `/i/user/<rest_id>` (rest_id from the `twid` cookie) and captures `UserByScreenName` |
| Write verbs | None. The replay helper (`pageApi`, kept for v2) hard-rejects non-GET methods, ops outside an allowlist, and non-X URLs. v1 verbs do not call replay at all - they parse the X client's organic response bodies. |

Output destination: stdout JSON. The skill does NOT write to `raw/` itself - the caller decides whether a fetched thread is signal (promote to `raw/x/`) or bulk (keep ephemeral). This matches the higgsfield pattern: skills emit to stdout, workspaces own `raw/` deposits.

## First-time setup (once)

```bash
cd _core/skills/x-read
node scripts/run.mjs login
```

A visible Chrome window opens at `x.com/login`. Sign in (handle + password + 2FA). The script polls for `auth_token + ct0` cookies and prints progress every 30s. Once both cookies appear it closes the browser. Cookies persist in the profile dir.

## Procedure (v1: organic-response capture, no replay)

Every verb (except `login | status | reset-breaker`) follows the same flow:

1. **Boot session.** `launchContext({ visible: false })` opens patchright Chrome with the persistent profile, attaches a CDP `Network.requestWillBeSent` listener (templates, indexed by OperationName) and a Playwright `page.on('response')` listener (parsed response bodies, indexed by OperationName) for `/i/api/graphql/*` traffic.
2. **Navigate.** Each verb knows the URL that organically triggers the GraphQL op it needs.
3. **URL + DOM challenge probe.** After page settles, check for challenge URL or DOM markers (Arkose iframe, login form, ocf-text-challenge). If found, trip breaker single-strike.
4. **Capture.** `ctx.waitForResponse(opName, { timeoutMs: 30000 })` resolves with the first matching response's parsed body. Status 401/403/429 trip the breaker.
5. **Parse.** Verb-specific extraction. Tweet-shape verbs (thread/profile/bookmarks/search) share `collectTweetResultsDeep` + `normalizeTweet` for consistent output. Analytics surfaces raw viewer_v2.
6. **Output.** Single JSON object to stdout. Non-zero exit code on parse failure / root-mismatch / 401-403-429 / breaker trip.
7. **Close.** Tear down patchright context. Pidfile released.

### Op map (verified live 2026-04)

| Verb | Navigation | GraphQL op | Response data path |
|------|-----------|-----------|--------------------|
| `whoami` | `/i/user/<rest_id>` | `UserByScreenName` | `data.user.result` |
| `thread` | `/i/status/<id>` | `TweetDetail` | `data.threaded_conversation_with_injections_v2.instructions[].entries[]` |
| `profile` | `/<handle>` | `UserByScreenName` (info), `UserTweets` (timeline) | `data.user.result`, `data.user.result.timeline.timeline.instructions[].entries[]` |
| `bookmarks` | `/i/bookmarks` | `Bookmarks` | `data.bookmark_timeline_v2.timeline.instructions[].entries[]` |
| `analytics` | `/i/account_analytics` | `accountOverviewQuery` | `data.viewer_v2` (raw passthrough) |
| `search` | `/search?q=...&f=<product>` | `SearchTimeline` | `data.search_by_raw_query.search_timeline.timeline.instructions[].entries[]` |

### Why organic capture over replay (v1)

- Zero extra HTTP from us means lower account-risk surface (no double-fire of the same op against X's anti-abuse).
- Avoids a whole class of bugs around getting browser-managed headers (cookie, referer, sec-ch-*) right.
- The replay path is fragile to X's `x-client-transaction-id` rotation; the page already minted a valid one for its own request and we just observe the response.

The replay path (`pageApi`) is retained in `browser.mjs` for v2 (cursor-paginated walks need a way to issue follow-up calls with a new cursor variable). It enforces method=GET, op-allowlist, host=x.com/twitter.com, and trips the breaker on 401/403.

### Self-heal: when the parser breaks

X rotates GraphQL op names and response shapes every few weeks. When a verb starts returning empty/wrong data:

```bash
# Discover the current op + response shape on a target surface:
node scripts/diag.mjs --target=home          # -> HomeTimeline shape
node scripts/diag.mjs --target=bookmarks     # -> Bookmarks
node scripts/diag.mjs --target=analytics     # -> accountOverviewQuery
node scripts/diag.mjs --target=profile:elonmusk
node scripts/diag.mjs --target='search:claude code'
```

`diag.mjs` dumps captured GraphQL templates, response keys, response shapes, plus a probe of legacy REST endpoints. Use the output to find the new op name or shape, then patch `run.mjs` accordingly. This is THE supported maintenance loop; don't speculate from logs.

## Failure modes (handled)

| Symptom | Detection | Action |
|---------|-----------|--------|
| Cookies expired | Auth challenge URL after navigation | Trip breaker, exit 3, instruct `login` |
| Captcha / Arkose / login form | DOM probe + URL pattern match | Trip breaker, exit 3 |
| Op not seen within 30s | response map miss | Exit 3 with captured-ops list for debugging |
| 401 / 403 | response status | Trip breaker (single strike), exit 3 |
| 429 | response status | Read `x-rate-limit-reset` (UNIX timestamp -> seconds remaining), surface to caller, exit 4 |
| Profile dir locked | live PID in pidfile | Refuse launch |
| Tombstoned tweet (TweetTombstone / TweetUnavailable) | `__typename` match | Surface in output with `tombstone` field; no body text |
| Body capture failure (resp.text() threw) | `parseError` set on captured response | Exit with capture-failure error |
| Suspended/private/deleted root tweet | focal ID not in TweetDetail entries | `ok:false` with diagnostic |
| User shape changed | `data.user.result` missing | `ok:false` with field-shape debug |

## Failure modes (NOT handled in v1)

- Cursor-paginated "show more" modules. v1 returns only primary entries surfaced in the first response. Caller is informed via `truncated_note`.
- Sensitive-media interstitial. Tweet may return without media URLs.
- Polls, cards, communities, Spaces. Out of scope.
- Edited tweets: `text` reflects the latest version per X's response; we don't emit edit history.
- Long videos / multi-variant media. We surface `media_url_https` per entity; we don't iterate variants.
- Per-tweet analytics. Account overview only in v1.
- Rate-limit auto-retry. Surface and bail; caller decides.

## Audit (run after every verb invocation)

| Check | Pass condition |
|-------|----------------|
| Captured response is 2xx JSON | `resp.status` 200-299, `resp.parseError` null, `resp.body` is object |
| Verb-specific shape | thread: `out.root.id` matches focal id (or tombstone with focal id). profile/bookmarks/search: `tweets` is array. analytics: `data.viewer_v2` is object. whoami: `id + handle` populated. |
| Breaker still healthy | `readBreaker().state === 'healthy'` |
| Truncation note present (timeline verbs) | `truncated_note` set so caller knows pagination is incomplete |

## Budget

- Sessions per minute: avoid more than 4. Each verb invocation cold-boots Chrome (~5-10s) and tears down. Bursting will trip account-level heuristics regardless of fingerprint quality.
- Replay HTTP per session: 0 in v1 (we only consume the X client's organic responses).
- No retry loop. If response capture fails, surface the error and bail.

## Files

- `package.json` - patchright dep, ESM
- `scripts/browser.mjs` - patchright launcher, CDP capture of full request templates, page response capture, breaker, pidfile, GET-only `pageApi` (unused in v1, retained for v2 cursor walks)
- `scripts/login.mjs` - visible login flow; cookie-poll + GraphQL fallback for auth signal; single-strike breaker on challenge
- `scripts/run.mjs` - CLI for all verbs (login, whoami, thread, profile, bookmarks, analytics, search, status, reset-breaker) plus shared parser helpers
- `scripts/diag.mjs` - self-heal tool. Dumps captured ops + response shapes for any X surface. Run when a verb breaks.
- `references/graphql-endpoints.md` - capture/replay strategy, cursor pagination caveats
- `references/detection-mitigation.md` - what's mitigated, what's not, what trips the breaker
- `rules/read-only.md` - read-only contract enforced at helper + verb + skill layers

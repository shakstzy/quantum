# bumble

Bumble automation for Adithya. Patchright-driven (no API-direct), human-paced, ban-aversion is priority #1.

Mirrors the `workspaces/tinder/` doctrine, with Bumble-specific adjustments below. If a rule applies in Tinder and is not contradicted here, it applies here too.

## Hard Rules (non-negotiable)

1. **No `bumble.com/api/*`, `mobile.bumble.com/api/*`, or GraphQL replays. Ever.** All actions go through patchright driving the real web UI. API-direct fingerprints are a known shadowban vector and Bumble's anti-bot stack is at least as aggressive as Tinder's.
2. **Hard cap: 50 swipes/day** (half of Tinder, since Bumble's swipe surface is more closely watched). Distributed across 2-3 short sessions. Right-swipe ratio capped at 50% (sample down within filter if too many qualify).
3. **Daily message cap: 10/hour rolling window** with per-message gaps 60-300s. Effective throughput much lower than the cap; on hetero-mode matches the woman starts the conversation, so most outbound is replies, not openers.
4. **Skip 1-2 days/week randomly.** No bot operates 7 days a week without going dark. Probability 0.20.
5. **Sessions are short** (5-15 min). No marathon batches.
6. **Halt hard on detection signals**: Cloudflare Turnstile, photo-verification prompt, account-restriction banner, login wall, mode-not-Date. See `setup/detection-ladder.md`.
7. **Auth is manual only.** Phone number flow. No Google/Facebook/Apple OAuth (extra fingerprint surfaces). Adithya logs into the dedicated chrome profile once.
8. **Selectors drift.** Re-verify before any production run after 7+ day gap. The bot self-checks on startup and halts loudly if selectors break.
9. **Always Date mode.** Halt if active mode is not Date. BFF/Bizz are off-scope.
10. **Bumble does not initiate openers on hetero matches.** Adithya cannot send the first message; the bot's send role is reply + nudge + extend.

## Why this is its own workspace (not a Tinder clone)

- Bumble's 24-hour match expiration changes the cadence: matches die at 24h if she hasn't messaged; her message starts a new 24h timer for the man to reply. `decide.mjs` triages by expiry-imminence, not just recency.
- Bumble's Cloudflare + bot-mitigation stack is reportedly more aggressive than Tinder's. Tighter caps, longer pauses, single-strike breaker on Turnstile.
- Photo verification is pushed harder; verify in the real Bumble iOS/Android app, not in the bot.

## How it runs

There is no human-facing CLI. Cron fires `node scripts/<X>.mjs` directly (see `setup/cron.md`). When Adithya wants to drive interactively, Claude (me) runs the scripts via Bash; Adithya never types `./bin/...`.

| Script | Purpose |
|--------|---------|
| `scripts/login.mjs` | Open patchright Chromium to bumble.com for one-time manual login |
| `scripts/swipe.mjs` | One swipe session (subject to caps) |
| `scripts/pull.mjs` | Scrape match list + thread snapshots into `raw/bumble/<slug>.md` |
| `scripts/decide.mjs` | Walk every entity, cross-ref iMessage, draft replies via `claude -p`, queue to `04-outbound/` |
| `scripts/send.mjs` | Drain `04-outbound/approved/` via patchright (one msg per fire) |
| `scripts/visualize.mjs` | Per-entity visual ingest: open thread, capture photos from `.page__profile`, download to `bot/.photos/<slug>/`, send to `_core/skills/cloud-llm` (Gemini Pro -> claude fallback), append `## Visual` (vibe / settings / activities / props / pets / group_context / style_signals / environments / notable_signals / red_flags). NO-FACIAL-FEATURES guardrail in the prompt. Re-scrapes profile while there. Skips entities that already have a `## Visual` section unless `QUANTUM_BUMBLE_VISUALIZE_FORCE=<slug,slug>` is set. `QUANTUM_BUMBLE_VISUALIZE_SLUG=<one>` to target a single match. `QUANTUM_BUMBLE_VISUALIZE_LIMIT=<n>` to cap a session. |
| `scripts/status.mjs` | Counters, queue sizes, halt state, entity counts by city/status |
| `scripts/self-check.mjs` | Pre-flight env / deps / config / halt |
| `scripts/selector-check.mjs` | Interactive DOM selector verification |
| `scripts/diag.mjs` | Self-heal entry point: launches Chromium + dumps DOM survey + screenshots when something breaks |
| `scripts/discover-dom.mjs` | THROWAWAY one-shot probe: visit each surface, dump candidate selectors |
| `scripts/discover-network.mjs` | THROWAWAY one-shot probe: capture observed XHR/fetch shapes (read-only, never replayed) |

### Drafting via `claude -p`

Drafts come from `claude -p`, which uses Adithya's Claude Code subscription; no separate API key. The voice profile (`config/voice/`) is composed into each prompt. Override model with `QUANTUM_BUMBLE_MODEL` (default: `sonnet`).

## Layout

```
config/
  voice/                    # drafting reads these voice/style references
    messaging-voice.md
    reply-skill.md
    nudge-skill.md
    sms-voice.md
    swipe-filter.md
    funnel-rules.md
    date-venues.md
    adithya-dating-profile.md
  caps.json                 # daily/hourly/per-session caps (tighter than Tinder)
  schedule.json             # session windows + skip-day probability
  selectors.json            # DOM selectors with last-verified date (populated by discover-dom)
  filter.json               # age range, max distance, right-swipe ratio cap
  cities.json               # city buckets + area-code map (Austin/SF/LA/NYC)
bot/
  src/
    runtime/
      profile.mjs           # patchright launch + persistent context + lock
      humanize.mjs          # ghost-cursor + per-char typing + idle pauses
      caps.mjs              # daily/hourly counters, persisted state
      detection.mjs         # Turnstile / photo-verify / restriction-banner / login-wall watchers
      logger.mjs            # session events (NDJSON)
      entity-store.mjs      # per-person markdown CRUD
      city.mjs              # city resolver
      slug.mjs              # slug generator <first>-<source>-<city>[-<n>]
      imessage-xref.mjs     # Contacts lookup + iMessage activity scan
      queue.mjs             # 04-outbound/* file-based queue
      halt.mjs              # ~/.quantum/bumble/.halt state
      notifier.mjs          # AppleScript -> self-iMessage when pending queue grows
      paths.mjs             # absolute path constants for this workspace
      mode-guard.mjs        # asserts Date mode active; halts on BFF/Bizz
      expiry.mjs            # 24h match-expiry tracking
    bumble/
      page.mjs              # navigation primitives
      swipe.mjs             # swipe-loop primitives
      matches.mjs           # match-list scrape + per-thread upsert
      send.mjs              # outbound message via patchright
    drafting/
      voice-loader.mjs      # loads config/voice/ into a single prompt block
      draft.mjs             # `claude -p` invocation, returns draft + lint
      voice-lint.mjs        # rule checker (length, em-dashes, banned words, AI tells)
  scripts/                  # entry points (see table above)
04-outbound/
  drafts/                   # raw drafts pre-lint
  pending/                  # awaiting approval (HITL); auto-expires to expired/ after 6h
  approved/                 # approved, awaiting send window
  sent/                     # successfully delivered (HITL'd)
  expired/                  # not approved within 6h, dropped
  auto-sent/                # passed lint + auto-eligible, sent without HITL
setup/
  chrome-profile.md
  login.md
  selector-verify.md
  detection-ladder.md
  cron.md
  com.shakstzy.quantum-bumble-{swipe,pull,send}.plist
.profile/                   # gitignored; patchright persistent context lives here
```

## Where data lives

Per-person entity files at `raw/bumble/<first>-bumble-<city>.md`:

```markdown
---
slug: caroline-bumble-austin
first_name: caroline
source: bumble
city: austin
match_id: <hex>
person_id: <hex>
phone: null
status: new            # new | active | nudge_pending | gone_dark | unmatched | expired
expires_at: 2026-05-03T14:32:11Z   # 24h after last activity
first_seen: 2026-05-02T14:32:11Z
last_activity: 2026-05-02T14:32:11Z
last_scrape: 2026-05-02T14:32:11Z
previous_slugs: []
---

## Profile
(overwritten on every rescrape)

## Conversation
(append-only timeline)
**her** 2026-05-02 14:32 hey
**you** 2026-05-02 14:35 hey, what's up

## Outbound log
(append-only event list)
- 2026-05-02 14:35 sent (hitl, reply) [draft:abc12345] lint=true "hey, what's up"
```

Slug rule: `<first>-bumble-<city>`. Collisions get `-2`, `-3`, etc.

City buckets: **austin**, **sf**, **la**, **nyc**. Resolution is phone area code first, then Bumble distance from Austin (<=100mi -> austin), else default home (austin).

Session-level events go to `~/.quantum/bumble/sessions.ndjson`; entity files stay clean for graphify.

## Cross-workspace dependencies

- **Reads `raw/imessage/YYYY-MM.ndjson`** to detect if a Bumble match has moved to iMessage and whether she's been replying.
- **Writes nothing outside `raw/bumble/` and `04-outbound/`.**

## Auto-send vs HITL split

| Type | Mode | Why |
|------|------|-----|
| Reply where she sent something substantive | HITL | Taste call, escalation, escalation timing |
| 24h-expiry nudge to her ("hey, before this expires") | n/a | NOT used; Bumble shows extend buttons in-app, take that route |
| Re-engagement after iMessage silence (5+ days) | auto | Short, one-shot, low-stakes |
| Anything matching `voice-lint.mjs` failure | HITL | Forces human review of voice-rule violations |
| Anything past message #6 in the thread | HITL | Move toward number/date - high stakes |

HITL items expire to `expired/` after 6 hours. AppleScript pings Adithya's own iMessage when pending queue grows past 3.

## Detection ladder (halt and log on any)

1. Cloudflare Turnstile iframe ("Verifying you are human...") -> halt; alert user; manual solve required
2. Photo verification request modal -> halt; in-person resolution via real Bumble iOS app
3. Account restriction / "We've noticed unusual activity" banner -> halt; permanent investigation needed
4. Login wall / "Your session has expired" -> halt; alert user; manual login
5. Mode is not Date (BFF or Bizz active) -> halt; user check
6. Zero matches in 7 days while swiping -> assume soft shadowban; halt; alert user
7. Selector self-check fails on startup -> halt; run `selector-check.mjs` interactively

State file: `~/.quantum/bumble/.halt`; presence blocks all sessions until removed.

## Discovery phase (one-time, before going live)

Adithya logs in once via `node scripts/login.mjs`. Once logged in:

1. `node scripts/discover-dom.mjs` - opens swipe surface, match list, and one open thread; dumps candidate selectors + screenshots to `bot/.dev-fixtures/<ts>/`. Populates `config/selectors.json`.
2. `node scripts/discover-network.mjs` - listens to XHR/fetch on the swipe + match-list + send paths, dumps observed shapes to `bot/.dev-fixtures/<ts>/network.ndjson`. We never replay these requests; the capture is for diag-time drift detection.
3. After both pass, `node scripts/selector-check.mjs` re-validates and stamps `last_verified` dates.

Both `discover-dom.mjs` and `discover-network.mjs` are throwaway. Delete after the answers are wired into `config/selectors.json` and `src/bumble/*.mjs`. `diag.mjs` is the durable self-heal entry point.

## Learnings (agent-drafted, user-approved)

<!-- decide.mjs may propose additions to this section based on:
     - Which message patterns led to number-close
     - Which times of day yielded highest reply rate
     - Selector drift events
     - Detection ladder firings -->

### Time-of-day reply patterns

_(empty)_

### Selector drift log

_(empty)_

### Detection events

_(empty)_

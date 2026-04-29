# tinder

Tinder automation for Adithya. Patchright-driven (no API-direct), human-paced, ban-aversion is priority #1.

This workspace replaces an earlier API-direct bot which contributed to a shadowban via direct `api.gotinder.com` calls and mechanically jittered timing. Lessons baked in below.

## Hard Rules (non-negotiable)

1. **No `api.gotinder.com` calls. Ever.** All actions go through patchright driving the real web UI. API-direct fingerprints are a known shadowban vector.
2. **Hard cap: 100 swipes/day.** Distributed across 2-3 short sessions. Right-swipe ratio capped at 50% (sample down within filter if too many qualify).
3. **Daily message cap: 20/hour rolling window** with per-message gaps 30-300s. Effective throughput much lower than the cap.
4. **Skip 1-2 days/week randomly.** No bot operates 7 days a week without going dark.
5. **Sessions are short** (5-15 min). No marathon batches.
6. **Halt hard on detection signals**: Arkose CAPTCHA, Face Check prompt, rate-limit banner, login wall, zero-match-in-7-days. See `setup/detection-ladder.md`.
7. **Auth is manual only.** User logs into the dedicated chrome profile; no programmatic auth, no cookie export.
8. **Selectors drift.** Re-verify before any production run after a 7+ day gap. The bot self-checks on startup and halts loudly if selectors break.

## How it runs

There is no human-facing CLI. Cron fires `node scripts/<X>.mjs` directly (see `setup/cron.md`). When Adithya wants to drive interactively, Claude (me) runs the scripts via Bash  -  Adithya never types `./bin/...`.

| Script | Purpose |
|--------|---------|
| `scripts/swipe.mjs` | One swipe session (subject to caps) |
| `scripts/pull.mjs` | Scrape match list + thread snapshots into `raw/tinder/<slug>.md` |
| `scripts/decide.mjs` | Walk every entity, cross-ref iMessage, draft replies via `claude -p`, queue to `04-outbound/` |
| `scripts/send.mjs` | Drain `04-outbound/approved/` via patchright (one msg per fire) |
| `scripts/status.mjs` | Counters, queue sizes, halt state, entity counts by city/status |
| `scripts/self-check.mjs` | Pre-flight env / deps / config / halt |
| `scripts/selector-check.mjs` | Interactive DOM selector verification |
| `scripts/login.mjs` | Open patchright Chromium to tinder.com for manual login (one-time) |

### Drafting via `claude -p`

Drafts come from `claude -p`, which uses Adithya's Claude Code subscription  -  no separate API key. The voice profile (`config/voice/`) is composed into each prompt. Override model with `QUANTUM_TINDER_MODEL` (default: `sonnet`).

## Layout

```
config/
  voice/                    # drafting reads these voice/style references
    messaging-voice.md
    opener-skill.md
    escalation-skill.md
    sms-voice.md
    swipe-filter.md
    funnel-rules.md
    date-venues.md
    adithya-dating-profile.md
  caps.json                 # daily/hourly/per-session caps
  schedule.json             # session windows + skip-day probability
  selectors.json            # DOM selectors with last-verified date
  filter.json               # age range, max distance, right-swipe ratio cap
  cities.json               # city buckets + area-code map (Austin/SF/LA/NYC)
bot/
  src/
    runtime/
      profile.mjs           # patchright launch + persistent context
      humanize.mjs          # ghost-cursor + per-char typing + idle pauses
      caps.mjs              # daily/hourly counters, persisted state
      detection.mjs         # Arkose / Face Check / rate-banner / login-wall watchers
      logger.mjs            # session events (NDJSON) — NOT per-entity
      entity-store.mjs      # per-person markdown CRUD: upsert, append messages, append outbound
      city.mjs              # city resolver (phone area code, distance heuristic)
      slug.mjs              # slug generator <first>-<source>-<city>[-<n>]
      imessage-xref.mjs     # Contacts lookup + iMessage activity scan
      queue.mjs             # 04-outbound/* file-based queue
      halt.mjs              # ~/.quantum/tinder/.halt state
      notifier.mjs          # AppleScript -> self-iMessage when pending queue grows
    tinder/
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
  com.shakstzy.quantum-tinder-{swipe,pull,send}.plist
.profile/                   # gitignored; patchright persistent context lives here
```

## Where data lives

Per-person entity files at `raw/tinder/<first>-<source>-<city>.md`:

```markdown
---
slug: caroline-tinder-austin
first_name: caroline
source: tinder
city: austin
match_id: <hex>
person_id: <hex>
phone: null            # filled in if discoverable from Contacts
status: new            # new | active | nudge_pending | gone_dark | unmatched
first_seen: 2026-04-28T14:32:11Z
last_activity: 2026-04-28T14:32:11Z
last_scrape: 2026-04-28T14:32:11Z
previous_slugs: []     # populated on city re-bucket so wiki links resolve
---

## Profile
(overwritten on every rescrape)

## Conversation
(append-only timeline)
**her** 2026-04-28 14:32 hey
**you** 2026-04-28 14:35 hey, what's up

## Outbound log
(append-only event list)
- 2026-04-28 14:35 sent (auto, opener) [draft:abc12345] lint=true "hey, what's up"
```

Slug rule: `<first>-<source>-<city>` (lowercase, hyphenated). Collisions get `-2`, `-3`, etc.

City buckets: **austin**, **sf**, **la**, **nyc** (others to be proposed). Resolution is phone area code first, then Tinder distance from Austin (≤100mi -> austin), else default home (austin). When city changes on rescrape, file is renamed and old slug appended to `previous_slugs` for backlink resolution.

Session-level events (swipe sweeps, halts, selector drift, send actions) go to `~/.quantum/tinder/sessions.ndjson`  -  not the entity files. Entity files stay clean for graphify.

## Cross-workspace dependencies

- **Reads `raw/imessage/YYYY-MM.ndjson`** to detect if a Tinder match has moved to iMessage and whether she's been replying. Phone-number lookup uses macOS Contacts via `osascript`. TODO: switch to graphify lookups when the dedicated Apple Contacts ingest workspace is built.
- **Writes nothing outside `raw/tinder/` and `04-outbound/`.**

## Auto-send vs HITL split

| Type | Mode | Why |
|------|------|-----|
| First-message opener on new match | auto | Templated per `opener-skill.md`, low taste required |
| Re-engagement nudge after iMessage silence (5+ days) | auto | Short, one-shot, low-stakes |
| Reply where she sent something substantive | HITL | Taste call, escalation, escalation timing |
| Anything matching `voice-lint.mjs` failure | HITL | Forces human review of voice-rule violations |
| Anything past message #6 in the thread | HITL | Move toward number/date  -  high stakes |

HITL items expire to `expired/` after 6 hours. AppleScript pings Adithya's own iMessage when pending queue grows past 3.

## Detection ladder (halt and log on any)

1. Arkose CAPTCHA iframe present -> halt; alert user; wait for manual solve
2. Face Check selfie prompt -> halt; alert user; in-person resolution required
3. Rate-limit banner -> halt; wait 6 hours minimum
4. Login wall / session expired -> halt; alert user; manual login
5. Zero matches in 7 days while swiping -> assume soft shadowban; halt; alert user
6. Selector self-check fails on startup -> halt; run `selector-check.mjs` interactively

State file: `~/.quantum/tinder/.halt`  -  presence blocks all sessions until removed (`rm` it).

## Learnings (agent-drafted, user-approved)

<!-- Stage decide.mjs may propose additions to this section based on:
     - Which message patterns led to number-close
     - Which times of day yielded highest reply rate
     - Selector drift events (record when a selector broke and what the fix was)
     - Detection ladder firings (what triggered, what we changed) -->

### Time-of-day reply patterns

_(empty)_

### Selector drift log

_(empty)_

### Detection events

_(empty)_

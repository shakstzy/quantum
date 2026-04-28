# tinder

Tinder automation for Adithya. Patchright-driven (no API-direct), human-paced, ban-aversion is priority #1.

This workspace replaces the SHAKOS `relationships/bot/` which contributed to a shadowban via API-direct calls + mechanically jittered timing. Lessons baked in below.

## Hard Rules (non-negotiable)

1. **No `api.gotinder.com` calls. Ever.** All actions go through patchright driving the real web UI. API-direct fingerprints are a known shadowban vector.
2. **Hard cap: 100 swipes/day.** Distributed across 2-3 short sessions. Right-swipe ratio capped at 50% (sample down within filter if too many qualify).
3. **Daily message cap: 20/hour rolling window** (effectively ~150/day max, but rate-limited per-message at 30-300s gaps so real throughput is much lower).
4. **Skip 1-2 days/week randomly.** No bot operates 7 days a week without going dark.
5. **Sessions are short** (5-15 min). No marathon batches.
6. **Halt hard on detection signals**: Arkose CAPTCHA, Face Check prompt, rate-limit banner, login wall, zero-match-in-7-days. See `setup/detection-ladder.md`.
7. **Auth is manual only.** User logs into the dedicated chrome profile; no programmatic auth, no cookie export.
8. **Selectors drift.** Re-verify before any production run after a 7+ day gap. The bot self-checks on startup and halts loudly if selectors break.

## Triggers

| Trigger | Action |
|---------|--------|
| `pull` | Run `bot/scripts/pull.mjs` — fetches new matches + thread snapshots into `raw/tinder/` |
| `swipe` | Run `bot/scripts/swipe.mjs` — one swipe session (subject to per-session and per-day caps) |
| `decide` | Run `bot/scripts/decide.mjs` — for each match, draft outbound and queue to `04-outbound/` |
| `send` | Run `bot/scripts/send.mjs` — drains `04-outbound/approved/` and `auto-sent/` via patchright |
| `status` | Print today's swipe count, pending queue size, last session times, halt-flag state |
| `pending` | List items in `04-outbound/pending/` for review |
| `setup` | Walk through `setup/` docs in order: chrome-profile -> login -> selector-verify |

CLI wrapper: `./bin/tinder <trigger>` from this dir. Scripts also runnable directly via `node bot/scripts/<name>.mjs`.

## Layout

```
config/
  voice/                     # ported from SHAKOS shared/, drafting reads these
    messaging-voice.md
    opener-playbook.md
    escalation-playbook.md
    sms-voice.md
    swipe-filter.md
    funnel-rules.md
    date-venues.md
    adithya-dating-profile.md
  caps.json                  # daily/hourly/per-session caps
  schedule.json              # session windows + skip-day probability
  selectors.json             # DOM selectors with last-verified date
  filter.json                # age range, max distance, right-swipe ratio cap
bot/
  src/
    runtime/
      profile.mjs            # patchright launch + persistent context
      humanize.mjs           # ghost-cursor + HumanTyping wrappers, idle pauses
      caps.mjs               # daily/hourly counters, persisted state
      detection.mjs          # Arkose / Face Check / rate-banner / login-wall watchers
      logger.mjs             # NDJSON append to raw/tinder/
    tinder/
      page.mjs               # navigation primitives (goto recs, goto matches, open thread)
      swipe.mjs              # swipe-loop primitives
      matches.mjs            # match-list scrape
      threads.mjs            # per-thread message scrape
      send.mjs               # outbound message via patchright
    drafting/
      voice-loader.mjs       # loads config/voice/ as cached prompt context
      draft.mjs              # Sonnet call with prompt caching
      voice-lint.mjs         # rule-checks output (length, em-dashes, banned words)
  scripts/
    swipe.mjs                # one swipe session
    pull.mjs                 # matches + threads scrape
    decide.mjs               # cross-ref iMessage, draft, queue
    send.mjs                 # drain approved queue
    status.mjs
    selector-check.mjs       # interactive selector verification
    self-check.mjs           # health: profile, env, caps, halt-flag
  package.json
bin/
  tinder                     # CLI wrapper
01-swipe/                    # stage placeholder; logs land in raw/tinder/swipes/
02-pull-matches/             # stage placeholder; logs land in raw/tinder/matches/ + threads/
03-followup-decide/          # stage placeholder; queue lives in 04-outbound/
04-outbound/
  drafts/                    # raw drafts pre-lint
  pending/                   # awaiting human approval
  approved/                  # approved, awaiting send window
  sent/                      # successfully delivered
  expired/                   # not approved within 6h, dropped
  auto-sent/                 # passed lint + auto-eligible, sent without HITL
setup/
  chrome-profile.md          # one-time profile creation
  login.md                   # manual login walkthrough
  selector-verify.md         # interactive selector validation
  detection-ladder.md        # what halts the bot and how to recover
  cron.md                    # launchd plist install
.profile/                    # gitignored; patchright persistent context lives here
```

## Where data lives

All raw deposits follow the QUANTUM `raw/<workspace>/YYYY-MM.ndjson` convention so Graphify can ingest cleanly:

| File | Schema |
|------|--------|
| `raw/tinder/swipes/YYYY-MM.ndjson` | `{ts, rec_id, person_id, name, decision: "like"\|"pass", filter_pass: bool, why}` |
| `raw/tinder/matches/YYYY-MM.ndjson` | `{ts, match_id, person_id, name, age, distance_mi, bio, photos, schools, jobs, interests, raw_profile}` (full Tinder match shape) |
| `raw/tinder/threads/YYYY-MM.ndjson` | `{ts, match_id, person_id, message_id, direction: "in"\|"out", text, sent_at}` (one line per message) |
| `raw/tinder/sent/YYYY-MM.ndjson` | `{ts, match_id, text, mode: "auto"\|"hitl", draft_id, lint_score}` |
| `raw/.ingest-log/tinder.watermark` | last processed `last_activity_date` from match scraping |

Outbound queue files (`04-outbound/{pending,approved}/`) carry context inline:

```
04-outbound/pending/2026-04-28T1342-<match-id>.md
---
match_id: <hex>
person: <name>
created: <iso>
draft_id: <uuid>
lint: pass
mode: hitl
expires: <iso + 6h>
---
## Thread context (last 6 messages)
**her** ...
**you** ...

## Drafted reply
<the message>

## Why this draft
<one-line rationale from the model>
```

To approve: `./bin/tinder approve <id>` or just edit the message text and `./bin/tinder send <id>`.

## Cross-workspace dependencies

- **Reads `raw/imessage/YYYY-MM.ndjson`** to detect if a Tinder match has moved to iMessage and whether she's been replying. Phone-number lookup uses macOS Contacts via `osascript` directly (TODO: switch to graphify when the dedicated Apple Contacts ingest workspace is built).
- **Writes nothing outside `raw/tinder/` and `04-outbound/`.**

## Auto-send vs HITL split

| Type | Mode | Why |
|------|------|-----|
| First-message opener on new match | auto | Templated per `opener-playbook.md`, low taste required |
| Re-engagement nudge after iMessage silence (5+ days) | auto | Short, one-shot, low-stakes |
| Reply where she sent something substantive | HITL | Taste call, escalation, escalation timing |
| Anything matching `voice-lint.mjs` failure | HITL | Forces human review of voice-rule violations |
| Anything past message #6 in the thread | HITL | Move toward number/date — high stakes |

## Detection ladder (halt and log on any)

1. Arkose CAPTCHA iframe present -> halt; alert user; wait for manual solve
2. Face Check selfie prompt -> halt; alert user; in-person resolution required
3. Rate-limit banner -> halt; wait 6 hours minimum
4. Login wall / session expired -> halt; alert user; manual login in chrome profile
5. Zero matches in 7 days while swiping -> assume soft shadowban; halt; alert user
6. Selector self-check fails on startup -> halt; run `selector-check.mjs` interactively

State file: `~/.quantum/tinder/.halt` — presence of this file blocks all sessions until removed.

## Learnings (agent-drafted, user-approved)

<!-- Stage decide.mjs may propose additions to this section based on:
     - Which message patterns led to number-close
     - Which times of day yielded highest reply rate
     - Selector drift events (record when a selector broke and what the fix was)
     - Detection ladder firings (what triggered, what we changed) -->

### Time-of-day reply patterns

_(empty, agent will populate)_

### Selector drift log

_(empty, agent will populate as selectors change)_

### Detection events

_(empty, agent will populate when halts fire)_

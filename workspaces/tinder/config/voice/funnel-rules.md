# Funnel Rules

Thresholds that drive stage 03 nudge/archive logic, stage 04 escalation, and stage 07 archive sweeps. Read by stages 03, 04, 07.

---

## Reply / Nudge Rules (stage 03)

| Rule | Value |
|------|-------|
| Silence window before nudge | 24 hours |
| Max nudge attempts before archive | 6 |
| Nudge message length | 1 sentence, lightest possible touch |
| Never unmatch | Archive is the max de-escalation |

### Nudge Ladder

- Attempt 1–2: light topical callback
- Attempt 3–4: low-stakes direct question
- Attempt 5–6: brief re-engagement, no pressure
- Attempt 7: do not send. Transition to `archived`.

## Number-Close Rules (stage 04)

| Rule | Value |
|------|-------|
| Hard cap: messages | 7 back-and-forth turns |
| Hard cap: time | 4 days of thread activity |
| Signal-triggered trigger | 3 or more receptivity signals (see below) |
| Cap-triggered trigger | Either hard cap hit and no number yet |
| Approach | Plan-first, number-as-logistics (see `escalation-skill.md` Layer B) |

Signal if you can, cap if you must. Never let cap elapse without an attempt.

If she declines or dodges, mark per-person state as `declined-number` and follow the Layer B dodge-recovery in `escalation-skill.md`. Do not re-ask.

### Receptivity Checklist (A6)

Before a signal-triggered close, confirm at least **3 of 5**:

1. She is asking questions back.
2. Her messages match or exceed yours in length.
3. Reply times under 1 hour during waking hours.
4. Emojis or exclamation points are warming.
5. She volunteered a personal detail unprompted.

3 or more -> high-probability close. 2 or fewer -> either wait for the cap or let the match fade.

## Date-Propose Rules (stage 04)

| Rule | Value |
|------|-------|
| Trigger | Number acquired (either just given or already on file) |
| Venue source | `shared/date-venues.md` |
| Day options | Propose 2–3 specific days, not open-ended |
| Time specificity | Specific time window (e.g., "wed or thurs evening") not vague ("sometime") |

## Archive Rules (stage 03 → stage 07)

| Rule | Value |
|------|-------|
| Trigger for archive | 6 unreplied nudge attempts OR she asked to stop |
| Archive state | `current-stage: archived` in `wiki/entities/<person>.md` |
| Unmatching | Never -- archive is the hard floor |

## Archive Revisit (stage 07)

| Rule | Value |
|------|-------|
| Revisit eligibility | `last-contact` >= 14 days ago AND `archive-attempts` < 2 |
| Revisit draft | Must include a callback hook to a specific prior topic |
| Revisit response window | 7 days -- if no reply, increment `archive-attempts`, return to archived |
| Permanent archive | After 2 failed revisits, transition to `permanent-archive`. No more sweeps. |

## Success Criteria

A thread is "won" when:

1. Phone number acquired
2. Date scheduled (venue + day + time all confirmed)

Neither alone counts. Success is the conjunction.

Wiki logs the transition when both conditions land. Date outcomes (happened / rescheduled / no-show / canceled) are recorded via `date-log` trigger.

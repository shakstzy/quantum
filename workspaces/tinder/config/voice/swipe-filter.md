# Swipe Filter

Cap-based filter for stage 02 swipe. Read by stage 02 only.

No ML ranking. No attractiveness scoring. No ambiguity.

---

## Inclusion Rules

Right-swipe if **all** of these are true:

1. Age >= 19
2. Age <= 26
3. Distance <= 70 miles

## Exclusion Rules

Left-swipe if **any** of these are true:

1. Age < 19
2. Age > 26
3. Distance > 70 miles
4. Profile missing age (Tinder sometimes hides -- treat as left)
5. Profile missing distance (treat as left)

## No Other Filters

- No filter on photos
- No filter on bio content
- No filter on interests / prompts
- No filter on verification badge

The agent does not look at any signal beyond age + distance. This is intentional and keeps the swipe layer fast and un-opinionated.

## Batch Behavior

- Batch size: 75 per `swipe` invocation
- Max batches per day: 3 (without explicit user override)
- On Arkose, Face Check, rate-limit, or login wall: halt immediately. Write halt file. Do not retry.

## Override Mechanism

To run a larger batch or change the filter for one session, pass args to the `swipe` trigger. Not implemented in v1.

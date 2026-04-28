# Selector verification

Tinder ships layout changes without notice. Selectors in `config/selectors.json` will rot.

## Run

```
./bin/tinder selector-check
```

This launches the browser, walks `/app/recs`, `/app/matches`, and the first thread, and tries each selector + its alts. Output:

```
OK   rec_card                 [class*='recCard']
OK   like_button              button[aria-label='Like']
FAIL thread_send              no candidate matched
```

`OK` selectors get their `last_verified` date stamped to today in `selectors.json`.

## When a selector fails

1. Open the same browser (the one patchright launched) and devtools.
2. Find the element. Pick a stable selector (prefer `data-testid` > `aria-label` > class fragment > tag chain).
3. Edit `config/selectors.json`:
   - Update `selector` with the new value.
   - Move the old one to `alt[]` so we have a fallback if Tinder reverts.
   - Reset `last_verified: null`.
4. Re-run `./bin/tinder selector-check` to confirm.

## Rule

Re-verify before any production run if the last_verified date is more than 7 days old. The bot's startup `ensureSelectorsHealthy()` hard-fails if critical selectors don't resolve, so a drift will halt the next session anyway.

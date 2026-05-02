# Selector verification

Selectors live in `config/selectors.json`. They drift when Bumble ships UI changes. Run verification:

1. Initial discovery (after first login):
   ```
   cd workspaces/bumble/bot
   node scripts/discover-dom.mjs
   ```
   Reads candidate queries against the live surface, dumps a survey + screenshots + HTML to `.dev-fixtures/<ts>/`. Read the survey JSON, pick winning selectors, hand-edit `config/selectors.json`.

2. Routine verification (after a 7+ day gap):
   ```
   node scripts/selector-check.mjs
   ```
   Walks the configured selectors against the live surface. Stamps `last_verified` on passes. Logs failures.

3. When something breaks mid-session:
   ```
   node scripts/diag.mjs
   ```
   Per-surface DOM survey + screenshots + which configured selectors resolve. Read the `diag.json` and patch `config/selectors.json`.

## Discovery output layout

```
bot/.dev-fixtures/<YYYY-MM-DDTHH-mm-ss>/
  discover-dom.json        # survey of candidate selectors per surface
  network.ndjson           # observed XHR/fetch URLs (NO bodies, NO headers)
  network-summary.json     # url -> count
  encounters.png           # screenshot
  app.html                 # HTML dump of the swipe surface
  ...
```

Throwaway: delete `.dev-fixtures/` after the answers are wired into `config/selectors.json` and `src/bumble/*.mjs`. `diag.mjs` is the durable self-heal entry point.

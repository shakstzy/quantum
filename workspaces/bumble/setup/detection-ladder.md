# Detection ladder

When any signal below fires, the bot writes a halt file at `~/.quantum/bumble/.halt` and stops. All scheduled sessions short-circuit until the halt is cleared.

| Signal | What you do |
|--------|-------------|
| `detection:turnstile_iframe` | Cloudflare Turnstile. Open the chrome profile, solve manually. Then `rm ~/.quantum/bumble/.halt`. |
| `detection:photo_verify_modal` | Bumble is asking for photo verification. Do it via the official iOS/Android Bumble app on your real phone. Then `rm ~/.quantum/bumble/.halt`. |
| `detection:rate_limit_banner` | Wait minimum 6 hours. Then `rm ~/.quantum/bumble/.halt`. |
| `detection:login_wall` | Run `node scripts/login.mjs`, log in manually, then `rm ~/.quantum/bumble/.halt`. |
| `detection:account_restriction_banner` | "Unusual activity detected" - Bumble's most serious signal. Stop everything. Investigate before clearing. |
| `mode_not_date:<mode>` | Bot is on BFF or Bizz mode. Switch to Date in the UI manually. Then `rm ~/.quantum/bumble/.halt`. |
| `selectors_broken:<list>` | Bumble shipped a layout change. Run `node scripts/diag.mjs`, fix broken entries in `config/selectors.json`, then clear halt. |

## Soft signals (not auto-halted, but watch via Gemini's P1 #5)

- **Ghosted matches**: matches reliably disappear within 10-15 minutes of formation. This is Bumble's shadowban signature. Run `node scripts/status.mjs` and inspect.
- **Silent message failures**: a send completes but the message doesn't render in the thread on the next pull. Indicates server-side suppression.
- **Zero matches in 7 days while swiping**: assume soft shadowban; halt manually.
- **Right-swipe ratio rising above 60%**: filter is too loose; tighten in `config/filter.json` or `config/voice/swipe-filter.md`.

## Halt file mechanics

- Path: `~/.quantum/bumble/.halt`
- Content: ISO timestamp + reason
- Read by: every script's `abortIfHalted()` on startup
- Cleared by: `rm ~/.quantum/bumble/.halt`

## When in doubt

Halt. The cost of a missed day is zero. The cost of an irreversible permaban is total.

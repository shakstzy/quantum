# Detection ladder

When any of these fire, the bot writes a halt file at `~/.quantum/tinder/.halt` and stops. All scheduled sessions short-circuit until the halt is cleared.

| Signal | What you do |
|--------|-------------|
| `detection:arkose_iframe` | Open the chrome profile, solve the puzzle manually. Then `./bin/tinder unhalt`. |
| `detection:face_check_prompt` | Tinder is asking for a selfie video. Do it in person via the official Tinder iOS/Android app on your real phone. Then `./bin/tinder unhalt`. |
| `detection:rate_limit_banner` | Wait minimum 6 hours. Then `./bin/tinder unhalt`. |
| `detection:login_wall` | Run `./bin/tinder selector-check`, log in manually, then `./bin/tinder unhalt`. |
| `selectors_broken:<list>` | Tinder shipped a layout change. Run `./bin/tinder selector-check`, fix the broken entries in `config/selectors.json`, then `./bin/tinder unhalt`. |

## Soft signals (not auto-halted, but watch)

- **Zero matches in 7 days while swiping**  -  assume soft shadowban. Run `./bin/tinder halt` manually. Don't burn more swipes. Investigate: try a re-photo cycle, change account info, etc. The status command will surface a warning when this triggers (TODO: not yet wired in v0.1).
- **Right-swipe ratio rising above 60%**  -  `swipe.mjs` will sample down within filter to keep it ≤50%. If you find it consistently capping out, your filter is too loose.

## Halt file mechanics

- Path: `~/.quantum/tinder/.halt`
- Content: ISO timestamp + reason
- Read by: every script's `abortIfHalted()` on startup
- Cleared by: `./bin/tinder unhalt`

## When in doubt

Halt. The cost of a missed day is zero. The cost of an irreversible permaban is total.

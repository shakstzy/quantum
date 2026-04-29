# Login walkthrough

There is no programmatic login. Ever. Programmatic auth is a known burn signal.

## Flow

1. `cd workspaces/tinder && ./bin/tinder selector-check` from the QUANTUM repo.
2. The patched Chromium opens. You'll see the Tinder marketing page or the login wall.
3. Click **Log in**. Choose **phone number** as the method  -  Google/Facebook OAuth adds fingerprint surfaces.
4. Enter your number, get the SMS code, paste it.
5. If Arkose CAPTCHA appears, solve it manually. The script idles while waiting.
6. Once you reach `/app/recs`, the script proceeds with selector verification and exits.
7. From now on, sessions reuse the persisted profile.

## When you'll need to log in again

- Tinder rotates session tokens on a schedule. Expect a re-login every 1-3 weeks.
- If detection scripts fire `login_wall`, the bot halts and notifies you (if `QUANTUM_SELF_PHONE` is set). Run `./bin/tinder selector-check` and log in again, then `./bin/tinder unhalt`.

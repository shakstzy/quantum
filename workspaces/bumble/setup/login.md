# Login walkthrough

There is no programmatic login. Programmatic auth is a known burn signal.

## Flow

1. From the QUANTUM repo: `cd workspaces/bumble/bot && node scripts/login.mjs`
2. The patched Chrome opens. Warmup loads google.com briefly, then navigates to bumble.com/get-started.
3. Click **Quick sign in** OR **Continue with other methods**, then choose **phone number**. Avoid Google/Facebook/Apple OAuth - extra fingerprint surfaces.
4. Enter your number, get the SMS code, paste it.
5. If Cloudflare Turnstile appears, solve it manually. The script idles while waiting.
6. If photo-verification is requested, do it via the real Bumble iOS/Android app on your phone. NOT in the bot.
7. Once you reach the post-auth surface (encounters / matches / profile), close the window. Profile persists at `.profile/`.

## When you'll need to log in again

- Bumble rotates session tokens on a schedule. Expect re-login every 1-3 weeks.
- If detection scripts fire `login_wall`, the bot halts. Run `node scripts/login.mjs` and log in again, then `rm ~/.quantum/bumble/.halt`.

# Chrome profile setup

The bot uses a dedicated patchright Chromium profile at `workspaces/tinder/.profile/`. This profile is gitignored and Tinder-only  -  never use it for personal browsing or it'll fingerprint as a real human's mixed-purpose browser, then suddenly start swiping at 12:30pm sharp every day.

## One-time setup

1. From `workspaces/tinder/`:

   ```
   cd bot
   npm install
   ```

   Postinstall runs `patchright install chromium`, which downloads the patched Chromium binary.

2. Confirm the deps are healthy:

   ```
   ./bin/tinder self-check
   ```

   You'll see warnings about `.profile/` not existing yet (expected) and `QUANTUM_SELF_PHONE` (set if you want HITL push notifications to yourself).

3. First launch  -  opens the browser empty:

   ```
   ./bin/tinder selector-check
   ```

   Patchright starts, opens tinder.com, and you'll land on the login wall. **This is when you log in.** Do everything manually:

   - Click "Log in"
   - Use your phone number (don't use Google/Facebook OAuth  -  fewer fingerprint surfaces)
   - Solve any Arkose if it appears
   - Once you're on `/app/recs`, the script will detect it, run selector verification, and exit.

4. The profile is now persisted in `.profile/`. Future runs reuse it.

## Re-login

If the script halts with `detection:login_wall`, just rerun `./bin/tinder selector-check` and log in again.

## DO NOT

- Don't open this profile in regular Chrome
- Don't import bookmarks, extensions, or sync settings
- Don't manually visit other sites in this profile
- Don't copy cookies from your personal Tinder account into this profile (account history matters)

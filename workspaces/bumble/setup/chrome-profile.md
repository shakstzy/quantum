# Chrome profile

Patchright drives a real Chrome (channel: 'chrome'), not bundled Chromium. The profile lives at `workspaces/bumble/.profile/` (gitignored).

- One process at a time. `profile.mjs` acquires a lockfile before launch; concurrent sessions are rejected with `profile_locked`.
- Locale: en-US. Timezone: America/Chicago. Viewport: 1440x900.
- Args: `--disable-blink-features=AutomationControlled` + the standard isolate-origins disable.

If Chrome itself isn't installed where patchright expects, run `npx patchright install chrome` from `bot/` (postinstall handles this on first `npm install`).

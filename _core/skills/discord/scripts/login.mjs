// login.mjs -- one-time visible browser login to discord.com.
// User signs in manually (email + password + 2FA or QR). Script watches for a
// valid session via /users/@me probe, then closes. Cookies persist in the
// profile dir; runtime verbs reuse them.

import { launchContext, waitForSignedIn, tripBreaker } from './browser.mjs';

export async function runLogin({ force = false } = {}) {
  console.error('[discord] Opening visible Chrome. Sign in to discord.com (email + password + 2FA or QR).');
  console.error('[discord] Profile: ~/.quantum/chrome-profiles/discord/ (persistent; cookies survive restart).');
  console.error('[discord] ToS note: this operates your real account; Discord bans user-account automation. Burner account recommended.');

  const ctx = await launchContext({ force, visible: true });
  try {
    await ctx.page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.error('[discord] Waiting up to 15 minutes for signed-in session...');
    let me;
    try {
      me = await waitForSignedIn(ctx.page, { timeoutMs: 15 * 60 * 1000, probeEveryMs: 3000 });
    } catch (e) {
      tripBreaker();
      console.error(`[discord] ${e.message}. Try \`node scripts/run.mjs login\` again.`);
      process.exitCode = 2;
      return;
    }
    console.error(`[discord] Signed in as ${me.username} (id=${me.id}, email=${me.email || 'n/a'}).`);
    console.error('[discord] Cookies persisted. Runtime verbs reuse this session automatically.');
  } finally {
    await ctx.close();
  }
}

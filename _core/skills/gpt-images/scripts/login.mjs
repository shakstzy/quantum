// login.mjs -- one-time visible browser login to chatgpt.com.
// Adithya signs in manually. Script polls /api/auth/session until a user
// object appears, then closes. Cookies persist in the profile dir.

import { launchContext, waitForSignedIn } from './browser.mjs';

export async function runLogin({ force = false } = {}) {
  console.error('[gpt-images] Opening visible Chrome. Sign in to chatgpt.com.');
  console.error('[gpt-images] Profile: ~/.quantum/chrome-profiles/chatgpt/ (persistent; cookies survive restart).');
  console.error('[gpt-images] Note: this drives your real ChatGPT plan. Use within ToS; account at your own risk.');

  const ctx = await launchContext({ force, visible: true });
  try {
    await ctx.page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.error('[gpt-images] Waiting up to 15 minutes for signed-in session...');
    let sess;
    try {
      sess = await waitForSignedIn(ctx, { timeoutMs: 15 * 60 * 1000, probeEveryMs: 3000 });
    } catch (e) {
      // Login timeout = user took too long. Not a bot-detection signal, so
      // do not trip the breaker. Real bot-detection (Cloudflare challenge,
      // CAPTCHA persistence) is detected separately at runtime.
      console.error(`[gpt-images] ${e.message}. Try \`node scripts/run.mjs login\` again.`);
      process.exitCode = 2;
      return;
    }
    const u = sess.user || {};
    console.error(`[gpt-images] Signed in as ${u.email || u.name || u.id || 'unknown user'}.`);
    console.error('[gpt-images] Cookies persisted. Future runs reuse this session automatically.');
  } finally {
    await ctx.close();
  }
}

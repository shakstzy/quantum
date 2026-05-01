// login.mjs -- one-time visible browser login to grok.com.
// Adithya signs in (recommended: Sign in with X for X Premium-linked access).
// Script polls a session probe until the user object appears, then closes.

import { launchContext, waitForSignedIn, detectChallenge, tripBreaker } from './browser.mjs';

export async function runLogin({ force = false } = {}) {
  console.error('[grok-web] Opening visible Chrome. Sign in to grok.com.');
  console.error('[grok-web] Tip: use "Sign in with X" so your X Premium plan is linked.');
  console.error('[grok-web] Profile: ~/.quantum/chrome-profiles/grok/ (persistent; cookies survive restart).');
  console.error('[grok-web] Note: this drives grok.com programmatically. Use within ToS; account at your own risk.');

  const ctx = await launchContext({ force, visible: true });
  try {
    await ctx.page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Early challenge probe -- if Cloudflare/Turnstile is in front of even
    // the landing page, trip the breaker before the user wastes time.
    const challenge = await detectChallenge(ctx.page);
    if (challenge) {
      tripBreaker(`login-challenge:${challenge}`);
      console.error(`[grok-web] grok.com served a ${challenge} challenge before login. Breaker tripped.`);
      console.error('[grok-web] Wait for the challenge to clear in the visible window and retry, or run --force after manual sign-in.');
    }

    console.error('[grok-web] Waiting up to 15 minutes for signed-in session...');
    let sess;
    try {
      sess = await waitForSignedIn(ctx, { timeoutMs: 15 * 60 * 1000, probeEveryMs: 3000, debug: true });
    } catch (e) {
      // Timeout = user didn't sign in. Not a bot-detection signal -- DO NOT
      // trip the breaker for a UX timeout.
      console.error(`[grok-web] ${e.message}. Try \`node scripts/run.mjs login\` again.`);
      process.exitCode = 2;
      return;
    }
    const who = sess.email || sess.user?.email || sess.name || sess.user?.name || sess.id || sess.user?.id || 'unknown';
    console.error(`[grok-web] Signed in as ${who}.`);
    console.error(`[grok-web] Auth probe matched: ${sess._probe_url}`);
    console.error('[grok-web] Cookies persisted. Future runs reuse this session automatically.');
  } finally {
    await ctx.close();
  }
}

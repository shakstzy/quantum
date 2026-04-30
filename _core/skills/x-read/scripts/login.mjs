// login.mjs -- one-time visible browser login to x.com.
// User signs in manually. Script waits for an authenticated GraphQL request
// (with both bearer + CSRF headers) AND a 2xx response, then closes.
// Cookies persist in the profile dir; runtime verbs reuse them.

import { launchContext, waitForAuthSignal, tripBreaker, isAuthChallengeUrl, detectDomChallenge } from './browser.mjs';

export async function runLogin({ force = false } = {}) {
  console.error('[x-read] Opening visible Chrome. Sign in to x.com (handle/email + password + 2FA).');
  console.error('[x-read] Profile: ~/.quantum/chrome-profiles/x/ (persistent; cookies survive restart).');
  console.error('[x-read] ToS note: this drives a real X account programmatically. Read-only, low-volume, but still surface for enforcement. Burner recommended for high-volume use; v1 is intended for occasional thread reads on your main.');

  const ctx = await launchContext({ force, visible: true });
  let success = false;
  try {
    await ctx.page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.error('[x-read] Waiting up to 15 minutes for an authenticated GraphQL response (bearer + CSRF + 2xx)...');
    let signal;
    try {
      signal = await waitForAuthSignal(ctx, { timeoutMs: 15 * 60 * 1000, probeEveryMs: 1500 });
    } catch (e) {
      tripBreaker('login-wait-error');
      console.error(`[x-read] ${e.message}.`);
      process.exitCode = 2;
      return;
    }
    if (!signal) {
      const finalUrl = ctx.page.url();
      const dom = await detectDomChallenge(ctx.page).catch(() => null);
      if (isAuthChallengeUrl(finalUrl) || dom) {
        tripBreaker(`login-challenge:${dom || finalUrl}`);
        console.error(`[x-read] Login appears stuck (${dom ? `dom:${dom}` : `url:${finalUrl}`}). Breaker tripped (single-strike).`);
      } else {
        console.error(`[x-read] No authenticated GraphQL response observed within 15 minutes (page at ${finalUrl}).`);
      }
      process.exitCode = 2;
      return;
    }
    success = true;
    const headerCount = Object.keys(signal.template.headers || {}).length;
    console.error(`[x-read] Authenticated. Captured op "${signal.op}" with bearer + csrf (+ ${headerCount - 2} other headers). Cookies persisted; runtime verbs reuse this session automatically.`);
  } finally {
    await ctx.close();
  }
  if (!success) process.exitCode = process.exitCode || 2;
}

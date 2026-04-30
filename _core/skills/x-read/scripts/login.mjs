// login.mjs -- one-time visible browser login to x.com.
// User signs in manually. Script watches for the X client to emit an
// authenticated GraphQL call (Viewer or equivalent), then closes.
// Cookies persist in the profile dir; runtime verbs reuse them.

import { launchContext, waitForAuthSignal, tripBreaker, isAuthChallengeUrl } from './browser.mjs';

export async function runLogin({ force = false } = {}) {
  console.error('[x-read] Opening visible Chrome. Sign in to x.com (email/handle + password + 2FA).');
  console.error('[x-read] Profile: ~/.quantum/chrome-profiles/x/ (persistent; cookies survive restart).');
  console.error('[x-read] ToS note: this drives a real X account programmatically. Read-only, low-volume, but still surface for enforcement. Burner recommended for high-volume use; v1 is intended for occasional thread reads on your main.');

  const ctx = await launchContext({ force, visible: true });
  try {
    await ctx.page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.error('[x-read] Waiting up to 15 minutes for signed-in session (an authenticated GraphQL call must fire from the X client)...');
    let template;
    try {
      template = await waitForAuthSignal(ctx, { timeoutMs: 15 * 60 * 1000, probeEveryMs: 1500 });
    } catch (e) {
      tripBreaker('login-wait-error');
      console.error(`[x-read] ${e.message}.`);
      process.exitCode = 2;
      return;
    }
    if (!template) {
      const finalUrl = ctx.page.url();
      if (isAuthChallengeUrl(finalUrl)) {
        tripBreaker('login-challenge-url');
        console.error(`[x-read] Login appears stuck at ${finalUrl}. Breaker tripped (single-strike policy on Premium account).`);
      } else {
        console.error(`[x-read] No authenticated GraphQL call observed within 15 minutes (page at ${finalUrl}).`);
      }
      process.exitCode = 2;
      return;
    }
    console.error(`[x-read] Authenticated. Captured op "${template.url.match(/\/graphql\/[^\/]+\/([^?]+)/)?.[1] || 'unknown'}" with bearer + csrf + ${Object.keys(template.headers).length} headers.`);
    console.error('[x-read] Cookies persisted to profile. Runtime verbs reuse this session automatically.');
  } finally {
    await ctx.close();
  }
}

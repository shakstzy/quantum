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
    await ctx.page.goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.error('[x-read] Visible Chrome should be open. Sign in there.');
    console.error('[x-read] Polling for auth_token + ct0 cookies (and as fallback an authenticated GraphQL response). Up to 15 minutes.');
    let signal;
    try {
      signal = await waitForAuthSignal(ctx, {
        timeoutMs: 15 * 60 * 1000,
        probeEveryMs: 1500,
        onProgress: ({ elapsedMs, pageUrl }) => {
          console.error(`[x-read] still waiting (${Math.round(elapsedMs/1000)}s, page=${pageUrl}). Sign in at the Chrome window.`);
        }
      });
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
        console.error(`[x-read] Login appears stuck (${dom ? `dom:${dom}` : `url:${finalUrl}`}). Breaker tripped (single-strike). If you didn't actually sign in, run \`reset-breaker\` then \`login\` again.`);
      } else {
        console.error(`[x-read] No auth signal within 15 minutes (page at ${finalUrl}). Did you finish signing in at the visible Chrome window?`);
      }
      process.exitCode = 2;
      return;
    }
    success = true;
    if (signal.kind === 'cookie') {
      console.error(`[x-read] Authenticated via cookie signal (auth_token + ct0 present). Cookies persisted; runtime verbs reuse this session automatically.`);
    } else {
      const headerCount = Object.keys(signal.template.headers || {}).length;
      console.error(`[x-read] Authenticated via GraphQL signal: op "${signal.op}" with bearer + csrf (+ ${headerCount - 2} other headers). Cookies persisted; runtime verbs reuse this session automatically.`);
    }
  } finally {
    await ctx.close();
  }
  if (!success) process.exitCode = process.exitCode || 2;
}

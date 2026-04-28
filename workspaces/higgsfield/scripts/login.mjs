// login.mjs -- one-time visible-browser Clerk login into the dedicated profile.
// User completes login manually; skill confirms session and exits.

import { launchContext } from './browser.mjs';
import { verifyUaChConsistency } from './fingerprint.mjs';
import { waitForClerkReady } from './jwt.mjs';

export async function runLogin() {
  console.log('[higgsfield] Opening visible Chrome. Sign in to higgsfield.ai with Google / Apple / Microsoft / email.');
  console.log('[higgsfield] Profile: ~/.quantum/chrome-profiles/higgsfield/');
  console.log('[higgsfield] ToS note: automated access may violate Higgsfield ToS. Use a burner account for heavy production use.');

  // Login requires a visible window; force-override the off-screen default.
  process.env.HF_VISIBLE = '1';
  const ctx = await launchContext({ headless: false, force: true });
  try {
    await ctx.page.goto('https://higgsfield.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // UA-CH sanity check
    const ua = await verifyUaChConsistency(ctx.page);
    if (!ua.ok) console.warn(`[higgsfield] UA-CH check warning: ${ua.reason}`);

    console.log('[higgsfield] Waiting up to 15 minutes for you to complete login...');
    // Poll for a signed-in signal. First ensure Clerk is loaded, then check session.
    const deadline = Date.now() + 15 * 60 * 1000;
    let authed = false;
    while (Date.now() < deadline) {
      const check = await ctx.page.evaluate(async () => {
        try {
          if (!window.Clerk) return { why: 'no-clerk-yet' };
          if (!window.Clerk.loaded) return { why: 'clerk-booting' };
          if (!window.Clerk.session) return { why: 'no-session' };
          const t = await window.Clerk.session.getToken();
          if (!t) return { why: 'no-token' };
          const r = await fetch('https://fnf.higgsfield.ai/user', { headers: { authorization: 'Bearer ' + t } });
          if (r.ok) return { ok: true, status: r.status };
          return { why: `user-api-${r.status}` };
        } catch (e) { return { why: 'exception:' + (e && e.message || e) }; }
      });
      if (check.ok) { authed = true; break; }
      // Print a status update every 30s so user can see it's alive
      if ((Math.floor((Date.now() - (deadline - 15 * 60 * 1000)) / 1000) % 30) === 0) {
        process.stdout.write(`.`);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    process.stdout.write('\n');

    if (!authed) {
      console.error('[higgsfield] Timed out waiting for login. Try again with `node scripts/run.mjs login`.');
      process.exitCode = 2;
      return;
    }

    // Pull wallet info to confirm
    const info = await ctx.page.evaluate(async () => {
      const t = await window.Clerk?.session?.getToken();
      const r = await fetch('https://fnf.higgsfield.ai/user', { headers: { authorization: 'Bearer ' + t } });
      const j = await r.json();
      return { email: j.email, plan_type: j.plan_type, subscription_credits: j.subscription_credits, has_unlim: j.has_unlim, workspace_id: j.workspace_id };
    });
    console.log(`[higgsfield] Logged in as ${info.email} (plan: ${info.plan_type}, credits: ${info.subscription_credits}, unlim: ${info.has_unlim})`);
    console.log('[higgsfield] Profile cookies persisted. Future runs reuse this session automatically.');
  } finally {
    await ctx.close();
  }
}

// diag-list-gens.mjs -- open Higgsfield, list user's recent generations (newest first).

import { launchContext } from './browser.mjs';
import { waitForCapturedJwt, extractUserIdFromJwt } from './jwt.mjs';
import { scrapeUserAssets, openHistoryPanel } from './ui-submit.mjs';

async function main() {
  const ctx = await launchContext({ force: true, headless: false });
  try {
    const page = ctx.page;
    await page.goto('https://higgsfield.ai/ai/video', { waitUntil: 'load', timeout: 45000 });
    await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    const sub = extractUserIdFromJwt(ctx.jwtCapture.token);
    const userSub = sub?.user_id;
    console.log('[diag] user_id =', userSub);
    const userSubstr = userSub.replace(/^user_/, '');
    await openHistoryPanel(page);
    await page.waitForTimeout(4000);
    const all = await scrapeUserAssets(page, userSubstr);
    console.log(`\n[diag] ${all.length} user assets in History (newest first):`);
    all.slice(0, 15).forEach((a, i) => {
      console.log(`  #${i} ts=${a.timestamp} ext=${a.ext} uuid=${a.uuid}`);
      console.log(`     ${a.cdn.slice(0, 160)}`);
    });
    await page.screenshot({ path: '/tmp/hf-history-list.png', fullPage: false });
    console.log('\n[diag] screenshot /tmp/hf-history-list.png');

    // Also read current wallet via /user endpoint (page.request, known working)
    const t = ctx.jwtCapture.token;
    if (t) {
      try {
        const r = await page.request.get('https://fnf.higgsfield.ai/user', { headers: { authorization: 'Bearer ' + t } });
        const j = await r.json();
        console.log(`[diag] wallet: sub_credits=${j.subscription_credits} has_unlim=${j.has_unlim}`);
      } catch (e) { console.log('[diag] wallet fetch failed:', e.message); }
    }
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

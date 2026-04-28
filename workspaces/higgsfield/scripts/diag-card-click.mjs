// Click the History card (parent of thumbnail img) to trigger mp4 load.

import { launchContext } from './browser.mjs';
import { waitForCapturedJwt, extractUserIdFromJwt } from './jwt.mjs';
import { openHistoryPanel } from './ui-submit.mjs';

const TARGET_TS = '20260421_200237';

async function main() {
  const ctx = await launchContext({ force: true, headless: false });
  const newMp4s = new Set();
  const newFnf = new Set();

  ctx.context.on('request', req => {
    try {
      const u = new URL(req.url());
      if (u.hostname === 'cdn.higgsfield.ai' && /\.(mp4|webm|mov)/i.test(u.pathname)) newMp4s.add(u.href);
      if (u.hostname === 'fnf.higgsfield.ai') {
        if (/generations|gens|asset|media|video|history/i.test(u.pathname)) newFnf.add(`${req.method()} ${u.pathname}`);
      }
    } catch (_) {}
  });

  try {
    const page = ctx.page;
    await page.goto('https://higgsfield.ai/ai/video', { waitUntil: 'load', timeout: 45000 });
    await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    const sub = extractUserIdFromJwt(ctx.jwtCapture.token);
    await openHistoryPanel(page);
    await page.waitForTimeout(3000);

    // Reset observed URLs AFTER navigation baseline
    newMp4s.clear();
    newFnf.clear();

    // Click the CARD-level ancestor of the thumbnail with our ts
    const clickResult = await page.evaluate((ts) => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const target = imgs.find(i => (i.src || '').includes(ts));
      if (!target) return { clicked: false, reason: 'img not found' };
      // Walk up to a reasonable card-level element
      let node = target;
      for (let i = 0; i < 8; i++) {
        if (!node.parentElement) break;
        node = node.parentElement;
        const tag = node.tagName;
        const cls = (node.className || '').toString();
        if (tag === 'A' || tag === 'BUTTON' || node.getAttribute?.('role') === 'button' || /card|tile|group|cursor-pointer/i.test(cls)) {
          node.click();
          return { clicked: true, via: `${tag}.${cls.slice(0, 40)}`, size: node.getBoundingClientRect() };
        }
      }
      target.parentElement?.click();
      return { clicked: true, via: 'img-parent-fallback' };
    }, TARGET_TS);
    console.log('[diag] click:', JSON.stringify(clickResult));

    // Wait 10s for preview to load
    for (let t = 2; t <= 14; t += 2) {
      await page.waitForTimeout(2000);
      const snap = await page.evaluate((ts) => {
        const vids = Array.from(document.querySelectorAll('video'));
        const ours = vids.map(v => ({ src: v.src, currentSrc: v.currentSrc, poster: v.poster }))
          .filter(v => (v.src || '').includes(ts) || (v.currentSrc || '').includes(ts) || (v.poster || '').includes(ts));
        return { total: vids.length, ours };
      }, TARGET_TS);
      console.log(`[diag] t+${t}s videos=${snap.total} ours=${snap.ours.length}`);
      if (snap.ours.length) {
        snap.ours.forEach(v => {
          console.log('  OUR VIDEO: src=', v.src);
          console.log('             currentSrc=', v.currentSrc);
          console.log('             poster=', v.poster);
        });
        break;
      }
    }

    console.log(`\n[diag] mp4 URLs triggered since card click (${newMp4s.size}):`);
    [...newMp4s].forEach(u => console.log('  ' + u));
    console.log(`\n[diag] interesting fnf calls since card click (${newFnf.size}):`);
    [...newFnf].forEach(u => console.log('  ' + u));

    await page.screenshot({ path: '/tmp/hf-card-click.png' });
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

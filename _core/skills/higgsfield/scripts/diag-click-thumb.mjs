// diag-click-thumb.mjs -- click the newest user-owned video thumbnail in History and
// observe what mp4 URL the video player mounts.

import { launchContext } from './browser.mjs';
import { waitForCapturedJwt, extractUserIdFromJwt } from './jwt.mjs';
import { openHistoryPanel } from './ui-submit.mjs';

const TARGET_THUMB_TS = '20260421_200237'; // our gen's timestamp-in-url

async function main() {
  const ctx = await launchContext({ force: true, headless: false });
  try {
    const page = ctx.page;

    // Capture all new responses on cdn.higgsfield.ai to see mp4 URLs as they load
    const mp4s = new Set();
    ctx.context.on('request', req => {
      try {
        const u = new URL(req.url());
        if (u.hostname === 'cdn.higgsfield.ai' && /\.(mp4|webm|mov)(\?|$)/i.test(u.pathname)) {
          mp4s.add(u.href);
        }
      } catch (_) {}
    });

    await page.goto('https://higgsfield.ai/ai/video', { waitUntil: 'load', timeout: 45000 });
    await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    const sub = extractUserIdFromJwt(ctx.jwtCapture.token);
    const userSubstr = sub.user_id.replace(/^user_/, '');
    await openHistoryPanel(page);
    await page.waitForTimeout(4000);

    // Click the thumbnail IMG or its parent card whose src contains our target timestamp
    const clicked = await page.evaluate((needleTs) => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const target = imgs.find(i => (i.src || '').includes(needleTs));
      if (!target) return { clicked: false, reason: 'thumbnail img with our timestamp not found' };
      // Click its nearest clickable ancestor (usually a card div or link)
      let node = target;
      while (node && node !== document.body) {
        if (node.tagName === 'BUTTON' || node.tagName === 'A' || node.getAttribute('role') === 'button' || /cursor-pointer/.test(node.className || '')) {
          node.click();
          return { clicked: true, via: node.tagName, src: target.src };
        }
        node = node.parentElement;
      }
      target.click();
      return { clicked: true, via: 'img-directly', src: target.src };
    }, TARGET_THUMB_TS);
    console.log('[diag] click result:', JSON.stringify(clicked));

    // Wait for video element with OUR ts to mount and load
    for (let t = 2; t <= 30; t += 2) {
      await page.waitForTimeout(2000);
      const ourVideo = await page.evaluate((ts) => {
        const vids = Array.from(document.querySelectorAll('video'));
        const matches = vids
          .map(v => ({ src: v.src, currentSrc: v.currentSrc, poster: v.poster, hasOurTs: (v.outerHTML || '').includes(ts) }))
          .filter(v => v.src || v.currentSrc);
        return matches;
      }, TARGET_THUMB_TS);
      const ours = ourVideo.find(v => (v.src || '').includes(TARGET_THUMB_TS) || (v.currentSrc || '').includes(TARGET_THUMB_TS) || (v.poster || '').includes(TARGET_THUMB_TS));
      console.log(`[diag] t+${t}s video_count=${ourVideo.length} found_ours=${!!ours}`);
      if (ours) {
        console.log(`  OUR VIDEO: src=${ours.src}`);
        console.log(`             currentSrc=${ours.currentSrc}`);
        console.log(`             poster=${ours.poster}`);
        break;
      }
    }
    console.log(`\n[diag] all mp4/webm/mov URLs observed this session (${mp4s.size}):`);
    [...mp4s].slice(0, 20).forEach(u => console.log('  ' + u));
    await page.screenshot({ path: '/tmp/hf-thumb-click.png' });
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

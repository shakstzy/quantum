// Find all <video> in main content area, trigger playback, capture mp4 URLs

import { launchContext } from './browser.mjs';
import { waitForCapturedJwt, extractUserIdFromJwt } from './jwt.mjs';
import { openHistoryPanel } from './ui-submit.mjs';

async function main() {
  const ctx = await launchContext({ force: true, headless: false });
  const userVideoUrls = new Set();
  try {
    const page = ctx.page;
    ctx.context.on('request', req => {
      try {
        const u = new URL(req.url());
        if (u.hostname === 'cdn.higgsfield.ai' && /user_37Irm4La4SK15PTpuJwrieuZyR2/.test(u.pathname)) {
          userVideoUrls.add(`${req.method()} ${u.href}`);
        }
      } catch (_) {}
    });

    await page.goto('https://higgsfield.ai/ai/video', { waitUntil: 'load', timeout: 45000 });
    await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    await openHistoryPanel(page);
    await page.waitForTimeout(3000);

    // Dump all <video> including their outerHTML excerpt
    const vidList = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('video')).map((v, idx) => {
        const r = v.getBoundingClientRect();
        const sources = Array.from(v.querySelectorAll('source')).map(s => ({ src: s.src, type: s.type }));
        return {
          idx, src: v.src || '', currentSrc: v.currentSrc || '', poster: v.poster || '',
          sources,
          xywh: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
          outerLen: v.outerHTML.length,
          outerFirst300: v.outerHTML.slice(0, 300).replace(/\s+/g, ' ')
        };
      });
    });
    console.log(`[diag] ${vidList.length} <video> elements:`);
    vidList.forEach(v => {
      console.log(`  #${v.idx} xywh=${v.xywh} src=${v.src.slice(0,80)} currentSrc=${v.currentSrc.slice(0,80)}`);
      if (v.sources.length) v.sources.forEach(s => console.log(`    <source> src=${s.src.slice(0,120)}`));
    });

    // Call .play() on all videos and see what URLs get fetched
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('video')).forEach(v => {
        try { v.muted = true; v.play?.().catch(() => {}); } catch (_) {}
      });
    });
    await page.waitForTimeout(8000);

    // Re-check video srcs
    const afterPlay = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('video')).map(v => ({
        src: v.src, currentSrc: v.currentSrc,
        sources: Array.from(v.querySelectorAll('source')).map(s => s.src)
      }));
    });
    console.log('\n[diag] video srcs AFTER .play():');
    afterPlay.forEach((v, i) => {
      if (v.src || v.currentSrc || v.sources.length) {
        console.log(`  #${i} src=${v.src?.slice(0,120)} currentSrc=${v.currentSrc?.slice(0,120)}`);
        v.sources.forEach(s => console.log(`    <source> ${s.slice(0,140)}`));
      }
    });

    console.log(`\n[diag] user-owned URLs observed on the network (${userVideoUrls.size}):`);
    [...userVideoUrls].forEach(u => console.log('  ' + u));
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

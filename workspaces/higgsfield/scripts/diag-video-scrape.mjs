// diag-video-scrape.mjs -- find ALL video-related URLs in the History DOM.

import { launchContext } from './browser.mjs';
import { waitForCapturedJwt, extractUserIdFromJwt } from './jwt.mjs';
import { openHistoryPanel } from './ui-submit.mjs';

async function main() {
  const ctx = await launchContext({ force: true, headless: false });
  try {
    const page = ctx.page;
    await page.goto('https://higgsfield.ai/ai/video', { waitUntil: 'load', timeout: 45000 });
    await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    const sub = extractUserIdFromJwt(ctx.jwtCapture.token);
    const userSub = sub?.user_id;
    const userSubstr = userSub.replace(/^user_/, '');
    console.log('[diag] user_id =', userSub);

    await openHistoryPanel(page);
    await page.waitForTimeout(5000);

    const report = await page.evaluate((needle) => {
      const videos = Array.from(document.querySelectorAll('video')).map(v => {
        const sources = Array.from(v.querySelectorAll('source')).map(s => s.src);
        return {
          src: v.src,
          poster: v.poster,
          sources,
          hasUserAttr: v.outerHTML.includes(needle),
          currentSrc: v.currentSrc
        };
      });
      const allLinks = Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.includes(needle));
      // Scan raw HTML for cloudfront URLs containing our user_
      const bodyHtml = document.body.innerHTML;
      const urlRe = /https:\/\/[\w.-]+\/user_[a-zA-Z0-9_]+\/[^"'\s)]+/g;
      const matches = [...new Set([...bodyHtml.matchAll(urlRe)].map(m => m[0]))].filter(u => u.includes(needle));
      return { videoElements: videos, matchingLinks: allLinks.slice(0, 15), htmlUrlMatches: matches.slice(0, 30) };
    }, userSubstr);
    console.log(`\n[diag] <video> elements: ${report.videoElements.length}`);
    report.videoElements.forEach((v, i) => {
      console.log(`  #${i} src=${v.src?.slice(0, 100)} currentSrc=${v.currentSrc?.slice(0, 100)}`);
      console.log(`      poster=${v.poster?.slice(0, 100)}`);
      v.sources.forEach(s => console.log(`      <source> ${s.slice(0, 120)}`));
    });
    console.log(`\n[diag] matching <a href>: ${report.matchingLinks.length}`);
    report.matchingLinks.forEach(h => console.log(`  ${h.slice(0, 160)}`));
    console.log(`\n[diag] ALL user-owned URLs in HTML (${report.htmlUrlMatches.length}):`);
    report.htmlUrlMatches.forEach(u => console.log(`  ${u.slice(0, 180)}`));
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

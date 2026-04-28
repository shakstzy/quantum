// diag-video-pickers.mjs -- dump duration/aspect/resolution picker option labels
import { launchContext } from './browser.mjs';
import { selectVideoModel } from './video.mjs';

const URL = 'https://higgsfield.ai/ai/video?model=seedance-2-0-fast';

async function main() {
  const ctx = await launchContext({ force: false, headless: false });
  try {
    const page = ctx.page;
    await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(6000);
    try { await selectVideoModel(page, 'Seedance 2.0 Fast'); } catch (_) {}
    await page.waitForTimeout(2000);
    // Dump anything that looks like a picker pill (button or div with short text)
    const data = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]').forEach(el => {
        const t = (el.innerText || '').trim();
        if (!t || t.length > 30) return;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 14) return;
        if (r.x > 600) return; // left config column only
        out.push({ tag: el.tagName, text: t.replace(/\n/g, ' | '), xywh: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      });
      return out;
    });
    console.log(`[diag] left-column pills: ${data.length}`);
    data.forEach(d => console.log(`  ${d.tag} xywh=${d.xywh} text="${d.text}"`));
    // Also try opening any picker that has 's' or 'sec' or duration-shaped text
    const durLike = data.filter(d => /^\d+\s*(s|sec|second)\b/i.test(d.text) || /^\d+\.?\d*s$/.test(d.text));
    console.log(`[diag] duration-shaped: ${durLike.length}`);
    durLike.forEach(d => console.log(`  text="${d.text}" at ${d.xywh}`));
    await page.screenshot({ path: '/tmp/hf-video-pickers.png' });
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });

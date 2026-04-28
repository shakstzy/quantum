// diag-duration-dropdown.mjs -- click duration pill, dump dropdown option labels
import { launchContext } from './browser.mjs';

const URL = 'https://higgsfield.ai/ai/video?model=seedance-2-0-fast';

async function main() {
  const ctx = await launchContext({ force: false, headless: false });
  try {
    const page = ctx.page;
    await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(7000);
    // Find duration pill (text matches \d+s, in left column)
    const pill = await page.evaluateHandle(() => {
      const all = Array.from(document.querySelectorAll('button, [role="button"]'));
      return all.find(el => {
        const t = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        return /^\d+\.?\d*s$/.test(t) && r.x < 600 && r.width > 30;
      });
    });
    const el = pill.asElement ? pill.asElement() : null;
    if (!el) { console.log('[diag] no duration pill'); return; }
    const rect = await el.evaluate(e => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; });
    console.log('[diag] duration pill at', rect);
    await el.click();
    await page.waitForTimeout(1500);
    // Dump everything visible nearby that could be an option
    const opts = await page.evaluate(([px, py]) => {
      const out = [];
      document.querySelectorAll('*').forEach(el => {
        const t = (el.innerText || '').trim();
        if (!t || t.length > 30) return;
        const r = el.getBoundingClientRect();
        if (r.width < 15 || r.height < 14) return;
        // Within ~400px of the pill
        const dx = (r.x + r.width / 2) - (px + 50);
        const dy = (r.y + r.height / 2) - (py + 20);
        if (Math.hypot(dx, dy) > 400) return;
        // Filter to leaf-ish elements
        if (el.children.length > 3) return;
        out.push({ tag: el.tagName, role: el.getAttribute('role'), text: t.replace(/\n/g, ' | '), xywh: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      });
      // Dedupe by text+xy
      const seen = new Set(); const uniq = [];
      for (const o of out) {
        const k = `${o.text}@${o.xywh[0]},${o.xywh[1]}`;
        if (seen.has(k)) continue; seen.add(k); uniq.push(o);
      }
      return uniq;
    }, [rect[0], rect[1]]);
    console.log(`[diag] candidates near duration pill: ${opts.length}`);
    opts.forEach(o => console.log(`  ${o.tag}[${o.role||''}] xywh=${o.xywh} text="${o.text}"`));
    await page.screenshot({ path: '/tmp/hf-duration-dropdown.png' });
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });

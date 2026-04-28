// diag-cinema-buttons.mjs -- inspect cinema page Generate button structure
import { launchContext } from './browser.mjs';

const URL = 'https://higgsfield.ai/cinema-studio?cinema-project-id=new';

async function main() {
  const ctx = await launchContext({ force: false, headless: false });
  try {
    const page = ctx.page;
    await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(8000);
    const result = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('button, [role="button"]').forEach(el => {
        const t = (el.innerText || '').trim();
        if (!/generate/i.test(t)) return;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        // walk up parents
        const parents = [];
        let p = el.parentElement;
        for (let i = 0; i < 4 && p; i++) {
          parents.push({ tag: p.tagName, role: p.getAttribute('role'), cls: (p.className || '').toString().slice(0, 80) });
          p = p.parentElement;
        }
        out.push({
          tag: el.tagName,
          role: el.getAttribute('role'),
          text: t.slice(0, 60),
          xywh: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          area: Math.round(r.width * r.height),
          disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
          html: el.outerHTML.slice(0, 200),
          parents,
        });
      });
      return out;
    });
    console.log('[diag] generate-like buttons:', result.length);
    result.forEach((b, i) => {
      console.log(`#${i} ${b.tag}[${b.role}] xywh=${b.xywh} area=${b.area} disabled=${b.disabled} text="${b.text}"`);
      console.log(`   html: ${b.html}`);
      b.parents.forEach((p, j) => console.log(`   parent[${j}]: ${p.tag}[${p.role}] cls="${p.cls}"`));
    });
    await page.screenshot({ path: '/tmp/hf-cinema-dom.png', fullPage: false });
    console.log('[diag] screenshot at /tmp/hf-cinema-dom.png');
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });

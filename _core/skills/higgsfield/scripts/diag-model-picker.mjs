// diag-model-picker.mjs -- click "Select model" and scout the resulting dropdown/modal.

import { launchContext } from './browser.mjs';

async function main() {
  const ctx = await launchContext({ force: true, headless: false });
  try {
    const page = ctx.page;
    await page.goto('https://higgsfield.ai/ai/video', { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(5000);

    // Find the "Select model" label and its enclosing clickable element
    const target = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const t = (el.innerText || '').trim();
        if (t === 'Select model' || /^Select model/i.test(t)) {
          // Walk up to find a clickable ancestor (button, div with onClick, etc)
          let cur = el;
          while (cur && cur !== document.body) {
            if (cur.tagName === 'BUTTON' || cur.getAttribute('role') === 'button' || cur.className?.includes?.('cursor-pointer') || cur.className?.includes?.('button')) {
              const r = cur.getBoundingClientRect();
              return { tag: cur.tagName, role: cur.getAttribute('role'), cls: (cur.className || '').toString().slice(0, 150), xywh: { x: r.x, y: r.y, w: r.width, h: r.height }, text: (cur.innerText || '').trim().slice(0, 80) };
            }
            cur = cur.parentElement;
          }
          // If no clickable ancestor, just return the element itself
          const r = el.getBoundingClientRect();
          return { tag: el.tagName, role: el.getAttribute('role'), cls: (el.className || '').toString().slice(0, 150), xywh: { x: r.x, y: r.y, w: r.width, h: r.height }, text: t.slice(0, 80) };
        }
      }
      return null;
    });
    console.log('[diag] Select-model target:', JSON.stringify(target, null, 2));
    if (!target) return;

    // Click center of bounding box
    const cx = target.xywh.x + target.xywh.w / 2;
    const cy = target.xywh.y + target.xywh.h / 2;
    console.log(`[diag] clicking at (${cx}, ${cy})...`);
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(2000);

    // Dump the state after click -- look for modal/dropdown/menu with model names
    const after = await page.evaluate(() => {
      // Look for common model names appearing as text in newly-shown elements
      const names = ['Seedance 2.0 Fast', 'Seedance 2.0', 'Kling 3.0', 'Kling 2.6', 'Veo 3.1', 'Veo 3', 'Wan 2.7', 'Sora 2', 'Minimax', 'Hailuo'];
      const found = [];
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        for (const n of names) {
          if (t === n || (t.startsWith(n) && t.length < n.length + 50)) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              found.push({ name: n, text: t.slice(0, 80), tag: el.tagName, cls: (el.className || '').toString().slice(0, 100), xywh: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
              break;
            }
          }
        }
      }
      return { modalOpened: found.length > 0, found };
    });
    console.log('[diag] AFTER click - model buttons/labels found:');
    after.found.forEach(f => console.log(`  "${f.text}" -> tag=${f.tag} xywh=(${f.xywh.x},${f.xywh.y} ${f.xywh.w}x${f.xywh.h}) cls=${f.cls?.slice(0, 60)}`));

    await page.screenshot({ path: '/tmp/hf-model-picker.png' });
    console.log('[diag] screenshot /tmp/hf-model-picker.png');
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

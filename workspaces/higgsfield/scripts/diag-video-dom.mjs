// diag-video-dom.mjs -- scout video page DOM to find prompt textbox and Generate button.

import { launchContext } from './browser.mjs';

const URL = 'https://higgsfield.ai/ai/video?model=seedance-2-0-fast';

async function main() {
  const ctx = await launchContext({ force: false, headless: false });
  try {
    const page = ctx.page;
    await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(6000);
    const scout = await page.evaluate(() => {
      const results = { inputs: [], generate: [] };
      document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [contenteditable=""], div[role="textbox"]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          results.inputs.push({
            tag: el.tagName, role: el.getAttribute('role'), placeholder: el.getAttribute('placeholder'),
            contentEditable: el.contentEditable, cls: (el.className || '').toString().slice(0, 100),
            xywh: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`
          });
        }
      });
      document.querySelectorAll('button, [role="button"]').forEach(el => {
        const r = el.getBoundingClientRect();
        const t = (el.innerText || '').toLowerCase();
        if (/generate|create|render|start/.test(t) && r.width > 0 && r.height > 0) {
          results.generate.push({
            text: el.innerText.trim().slice(0, 50),
            tag: el.tagName, role: el.getAttribute('role'),
            cls: (el.className || '').toString().slice(0, 100),
            xywh: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`
          });
        }
      });
      return { url: location.href, ...results };
    });
    console.log('[diag] url =', scout.url);
    console.log(`\n[diag] INPUT CANDIDATES (${scout.inputs.length}):`);
    scout.inputs.forEach((i, k) => console.log(`  #${k} <${i.tag}> role="${i.role}" placeholder="${i.placeholder}" contentEditable=${i.contentEditable} xywh=${i.xywh}\n     cls=${i.cls}`));
    console.log(`\n[diag] GENERATE BUTTONS (${scout.generate.length}):`);
    scout.generate.forEach((b, k) => console.log(`  #${k} text="${b.text}" tag=${b.tag} role=${b.role} xywh=${b.xywh}\n     cls=${b.cls}`));

    await page.screenshot({ path: '/tmp/hf-video-dom.png', fullPage: false }).catch(() => {});
    console.log('\n[diag] screenshot at /tmp/hf-video-dom.png');
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

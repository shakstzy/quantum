// diag-dom.mjs -- scout DOM to find prompt textbox and Generate button selectors.
// NO POST, zero 403 risk.

import { launchContext } from './browser.mjs';

const URL = 'https://higgsfield.ai/ai/image?model=nano-banana-pro';

async function main() {
  const ctx = await launchContext({ force: false, headless: false });
  try {
    const page = ctx.page;
    await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    console.log('[diag] goto complete. waiting 6s for hydration...');
    await page.waitForTimeout(6000);

    // Scout all possible input fields and button candidates
    const scout = await page.evaluate(() => {
      function snap(el) {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 150) : null,
          role: el.getAttribute('role') || null,
          placeholder: el.getAttribute('placeholder') || null,
          ariaLabel: el.getAttribute('aria-label') || null,
          name: el.getAttribute('name') || null,
          type: el.getAttribute('type') || null,
          contentEditable: el.contentEditable || null,
          text: (el.innerText || el.textContent || '').slice(0, 100).replace(/\s+/g, ' '),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          visible: r.width > 0 && r.height > 0 && window.getComputedStyle(el).visibility !== 'hidden' && window.getComputedStyle(el).display !== 'none'
        };
      }
      const results = { inputs: [], buttons: [], genCandidates: [] };
      document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [contenteditable=""], div[role="textbox"]').forEach(el => {
        results.inputs.push(snap(el));
      });
      document.querySelectorAll('button, [role="button"]').forEach(el => {
        const s = snap(el);
        if (s.visible) results.buttons.push(s);
        const t = (s.text || '').toLowerCase();
        if (/generate|create|render|go|start/.test(t) && s.visible) results.genCandidates.push(s);
      });
      return results;
    });

    console.log(`\n[diag] PROMPT INPUT CANDIDATES (${scout.inputs.length}):`);
    scout.inputs.slice(0, 10).forEach((inp, i) => {
      console.log(`  #${i} <${inp.tag}> visible=${inp.visible} placeholder="${inp.placeholder}" role="${inp.role}" contentEditable=${inp.contentEditable}`);
      console.log(`     cls: ${inp.cls}`);
      console.log(`     xywh: ${inp.x},${inp.y} ${inp.w}x${inp.h}`);
      if (inp.text) console.log(`     text: "${inp.text}"`);
    });

    console.log(`\n[diag] GENERATE BUTTON CANDIDATES (${scout.genCandidates.length}):`);
    scout.genCandidates.forEach((b, i) => {
      console.log(`  #${i} text="${b.text}" role="${b.role}" ariaLabel="${b.ariaLabel}"`);
      console.log(`     cls: ${b.cls}`);
      console.log(`     xywh: ${b.x},${b.y} ${b.w}x${b.h}`);
    });

    console.log(`\n[diag] TOTAL VISIBLE BUTTONS: ${scout.buttons.length}`);
    console.log('[diag] last 15 buttons (likely near Generate):');
    scout.buttons.slice(-15).forEach(b => console.log(`  "${b.text}" cls=${b.cls?.slice(0, 60)} xywh=${b.x},${b.y} ${b.w}x${b.h}`));

    // Try to find by text using Playwright's text selector
    const genBtnHandle = await page.$('button:has-text("Generate")').catch(() => null);
    console.log(`\n[diag] page.$('button:has-text("Generate")') matched: ${!!genBtnHandle}`);
    if (genBtnHandle) {
      const box = await genBtnHandle.boundingBox().catch(() => null);
      console.log(`[diag] generate button box:`, JSON.stringify(box));
    }

    // Try prompt box by role
    const promptTextbox = await page.$('[contenteditable="true"]').catch(() => null);
    console.log(`[diag] page.$('[contenteditable="true"]') matched: ${!!promptTextbox}`);
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

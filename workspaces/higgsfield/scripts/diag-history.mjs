// diag-history.mjs -- find where the user's completed generations live.
// The gen with job_uuid 0569fb8b... has been processing for ~10min server-side by now.

import { launchContext } from './browser.mjs';

const TARGET_UUID = '0569fb8b-4244-4f49-abef-e7b05c45b1c1';
const CANDIDATES = [
  'https://higgsfield.ai/ai/history',
  'https://higgsfield.ai/library',
  'https://higgsfield.ai/assets',
  'https://higgsfield.ai/profile',
  'https://higgsfield.ai/user',
  'https://higgsfield.ai/ai/image?model=nano-banana-pro&tab=history'
];

async function main() {
  const ctx = await launchContext({ force: false, headless: false });
  try {
    const page = ctx.page;

    // Start on /ai/image and click the "History" button in the sidebar
    console.log('[diag] loading image page, looking for History link...');
    await page.goto('https://higgsfield.ai/ai/image?model=nano-banana-pro', { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(5000);

    const historyInfo = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, [role="button"]'));
      const hist = els.filter(el => /^history$/i.test(el.innerText?.trim() || ''));
      return hist.map(el => ({
        tag: el.tagName,
        text: el.innerText.trim(),
        href: el.href || null,
        cls: el.className?.toString().slice(0, 100)
      }));
    });
    console.log('[diag] History elements found:', JSON.stringify(historyInfo, null, 2));

    // Click History
    const historyBtn = await page.$('a:has-text("History"), button:has-text("History")');
    if (historyBtn) {
      console.log('[diag] clicking History...');
      await Promise.all([
        page.waitForLoadState('load').catch(() => {}),
        historyBtn.click()
      ]);
      await page.waitForTimeout(5000);
      console.log('[diag] after click, url =', page.url());
    }

    const snap = await page.evaluate((uuid) => {
      const url = location.href;
      const imgs = Array.from(document.querySelectorAll('img'))
        .map(i => i.src).filter(s => /cloudfront|higgs\.ai|higgsfield/.test(s));
      const unique = [...new Set(imgs)];
      const matchingUuid = unique.filter(s => s.includes(uuid));
      const bodyPreview = (document.body?.innerText || '').slice(0, 500);
      return { url, totalImgs: unique.length, matchingUuid, first10: unique.slice(0, 10), bodyPreview };
    }, TARGET_UUID);
    console.log(`\n[diag] url=${snap.url}`);
    console.log(`[diag] total unique imgs=${snap.totalImgs}`);
    console.log(`[diag] imgs matching target uuid: ${snap.matchingUuid.length}`);
    snap.matchingUuid.forEach(s => console.log('    ' + s));
    console.log(`\n[diag] first 10 img urls:`);
    snap.first10.forEach(s => console.log('  ' + s));
    console.log(`\n[diag] body preview: ${snap.bodyPreview}`);

    // Also: take a full-page screenshot for visual verification
    const shotPath = '/tmp/hf-history-shot.png';
    await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
    console.log(`\n[diag] screenshot saved to ${shotPath}`);
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

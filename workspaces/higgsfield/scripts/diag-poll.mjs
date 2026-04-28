// diag-poll.mjs -- observe how the page learns about job completion.
// Look for: /jobs/<uuid> GETs by the page, SSE events, DOM changes.
// Zero 403 risk (we only observe).

import { launchContext } from './browser.mjs';

const URL = 'https://higgsfield.ai/ai/image?model=nano-banana-pro';
const TARGET_UUID = '0569fb8b-4244-4f49-abef-e7b05c45b1c1';

async function main() {
  const ctx = await launchContext({ force: false, headless: false });
  try {
    const page = ctx.page;

    page.on('response', async resp => {
      try {
        const u = new URL(resp.url());
        if (u.hostname === 'fnf.higgsfield.ai') {
          if (u.pathname.includes('/jobs/') || u.pathname.includes(TARGET_UUID)) {
            console.log(`[fnf-jobs] ${resp.status()} ${resp.request().method()} ${u.pathname}`);
          }
        }
        if (u.hostname === 'notification.higgsfield.ai') {
          console.log(`[notif] ${resp.status()} ${resp.request().method()} ${u.pathname}`);
        }
      } catch (_) {}
    });

    console.log('[diag] navigating...');
    await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    console.log('[diag] loaded. waiting 60s to observe page activity...');

    // Snapshot DOM at 15s, 30s, 45s, 60s
    for (const t of [15, 30, 45, 60]) {
      await page.waitForTimeout(15000);
      const snap = await page.evaluate((uuid) => {
        const imgs = Array.from(document.querySelectorAll('img')).map(i => ({
          src: i.src,
          alt: i.alt,
          dataset: { ...i.dataset }
        })).filter(i => /cloudfront|higgsfield|higgs\.ai/.test(i.src));
        // Try to find elements containing the job uuid
        const bodyText = document.body?.innerText || '';
        const hasUuid = bodyText.includes(uuid);
        return {
          cloudfrontImgCount: imgs.length,
          imgsFirst5: imgs.slice(0, 5),
          domHasUuid: hasUuid
        };
      }, TARGET_UUID);
      console.log(`[diag] t+${t}s: cloudfrontImgCount=${snap.cloudfrontImgCount} domHasUuid=${snap.domHasUuid}`);
      if (snap.imgsFirst5.length) {
        snap.imgsFirst5.forEach(img => console.log(`    img src=${img.src.slice(0, 120)}`));
      }
    }
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

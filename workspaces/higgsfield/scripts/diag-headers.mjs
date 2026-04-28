// diag-headers.mjs -- read the headers captured by jwtCapture to see what
// DataDome-signature fields the page is sending on fnf.higgsfield.ai requests.

import { launchContext } from './browser.mjs';

const URL = 'https://higgsfield.ai/ai/image?model=nano-banana-pro';

async function main() {
  const ctx = await launchContext({ force: true, headless: false });
  try {
    console.log('[diag] navigating to', URL);
    await ctx.page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    console.log('[diag] waiting 20s for page to make API calls...');
    await ctx.page.waitForTimeout(20000);

    console.log(`\n[diag] jwtCapture.captureCount = ${ctx.jwtCapture.captureCount}`);
    console.log(`[diag] have POST headers: ${!!ctx.jwtCapture.lastPostHeaders}`);
    console.log(`[diag] have any headers:  ${!!ctx.jwtCapture.lastAnyHeaders}`);

    const posth = ctx.jwtCapture.lastPostHeaders;
    const anyh = ctx.jwtCapture.lastAnyHeaders;

    if (posth) {
      console.log('\n=== LAST POST HEADERS ===');
      Object.entries(posth).sort().forEach(([k, v]) => {
        const val = (v || '').length > 150 ? v.slice(0, 150) + '...' : v;
        console.log(`  ${k}: ${val}`);
      });
    }

    if (anyh) {
      console.log('\n=== LAST ANY-METHOD HEADERS ===');
      Object.entries(anyh).sort().forEach(([k, v]) => {
        const val = (v || '').length > 150 ? v.slice(0, 150) + '...' : v;
        console.log(`  ${k}: ${val}`);
      });
    }

    // Look specifically for DataDome-style injected headers
    console.log('\n=== DATADOME / FINGERPRINT-SIGNATURE HEADERS ===');
    const hunt = posth || anyh || {};
    const dd = Object.entries(hunt).filter(([k]) => /dome|dd-|higgs|fingerprint/i.test(k));
    if (dd.length === 0) {
      console.log('  (NO DataDome-style injected headers — they rely purely on cookie + UA + timing)');
    } else {
      dd.forEach(([k, v]) => console.log(`  ${k}: ${v.slice(0, 100)}`));
    }
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

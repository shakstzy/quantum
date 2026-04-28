// diag.mjs -- standalone diagnostic: open page, log all network traffic, see what's happening with Clerk
import { launchContext } from './browser.mjs';

const URL = 'https://higgsfield.ai/ai/image?model=nano-banana-pro';

async function main() {
  const ctx = await launchContext({ force: true, headless: false });
  try {
    const page = ctx.page;
    page.on('response', async (resp) => {
      const url = resp.url();
      if (/clerk/i.test(url) || /fnf.higgsfield/.test(url)) {
        console.log(`[net] ${resp.status()} ${resp.request().method()} ${url.slice(0, 140)}`);
      }
    });
    page.on('requestfailed', r => console.log(`[net FAIL] ${r.url().slice(0, 140)} -- ${r.failure()?.errorText}`));
    page.on('console', msg => {
      const t = msg.type();
      if (t === 'error' || t === 'warning') console.log(`[page-${t}]`, msg.text().slice(0, 200));
    });
    page.on('pageerror', err => console.log(`[page-error] ${err.message.slice(0, 200)}`));

    console.log('[diag] navigating...');
    await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    console.log('[diag] loaded. waiting 30s to observe...');

    // Poll for Clerk every 3s
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(3000);
      const s = await page.evaluate(() => ({
        hasClerk: typeof window.Clerk !== 'undefined',
        hasLoaded: !!(window.Clerk && window.Clerk.loaded),
        // Check if Next.js has Clerk imported anywhere
        nextData: !!window.__NEXT_DATA__,
        allClerkKeys: Object.keys(window).filter(k => /clerk/i.test(k)),
        // Look for React fiber that contains Clerk
        bodyAttrs: document.body ? Array.from(document.body.attributes).map(a => a.name) : []
      }));
      console.log(`[diag] t+${(i+1)*3}s`, JSON.stringify(s));
      if (s.hasClerk && s.hasLoaded) break;
    }

    // Try directly calling the Clerk API for a fresh token
    const viaClerkApi = await page.evaluate(async () => {
      try {
        const r = await fetch('https://clerk.higgsfield.ai/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=5.125.9', {
          credentials: 'include'
        });
        const j = await r.json();
        return { status: r.status, hasClient: !!j?.client, sessionCount: j?.client?.sessions?.length };
      } catch (e) { return { error: String(e && e.message || e) }; }
    });
    console.log('[diag] direct Clerk API /v1/client:', JSON.stringify(viaClerkApi));

    // Final: try to extract JWT via whatever path works
    const final = await page.evaluate(async () => {
      if (window.Clerk?.session) {
        try {
          const t = await window.Clerk.session.getToken();
          return { via: 'window.Clerk', hasToken: !!t, tokLen: t?.length };
        } catch (e) { return { via: 'window.Clerk', error: String(e && e.message || e) }; }
      }
      return { via: 'none' };
    });
    console.log('[diag] token attempt:', JSON.stringify(final));
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

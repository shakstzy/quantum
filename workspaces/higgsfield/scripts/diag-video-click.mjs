// diag-video-click.mjs -- type prompt, click Generate on video page, log EVERYTHING.
// Goal: figure out why the video click produces no POST /jobs/* response.

import { launchContext } from './browser.mjs';
import { waitForCapturedJwt } from './jwt.mjs';

const URL = 'https://higgsfield.ai/ai/video';
const PROMPT = 'a timelapse of clouds drifting across a blue sky, cinematic, 5 seconds';

async function main() {
  const ctx = await launchContext({ force: true, headless: false });
  const events = [];

  // Context-level network observer (proven to work)
  ctx.context.on('request', req => {
    try {
      const u = new URL(req.url());
      if (u.hostname === 'fnf.higgsfield.ai' || u.hostname === 'notification.higgsfield.ai') {
        events.push({ t: Date.now(), type: 'req', method: req.method(), path: u.pathname });
      }
    } catch (_) {}
  });
  ctx.context.on('response', async resp => {
    try {
      const u = new URL(resp.url());
      if (u.hostname === 'fnf.higgsfield.ai' || u.hostname === 'notification.higgsfield.ai') {
        let body = '';
        try { body = (await resp.text()).slice(0, 300); } catch (_) {}
        events.push({ t: Date.now(), type: 'resp', status: resp.status(), method: resp.request().method(), path: u.pathname, body });
      }
    } catch (_) {}
  });

  try {
    const page = ctx.page;
    await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    console.log('[diag] loaded, waiting for JWT...');
    await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    console.log('[diag] JWT obs =', ctx.jwtCapture.captureCount);

    // BEFORE-state: currently selected model, Generate button label, any warnings
    const before = await page.evaluate(() => {
      const genBtn = Array.from(document.querySelectorAll('button')).find(b => /^generate\b/i.test((b.innerText || '').trim()) && b.getBoundingClientRect().width > 100);
      const modelLabel = Array.from(document.querySelectorAll('button')).find(b => /Seedance|Kling|Veo|Sora|Wan|Minimax/i.test(b.innerText))?.innerText?.trim();
      const textarea = document.querySelector('textarea');
      return {
        url: location.href,
        selectedModel: modelLabel || null,
        generateText: genBtn?.innerText?.trim() || null,
        generateDisabled: genBtn?.disabled ?? null,
        generateRect: genBtn ? (() => { const r = genBtn.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() : null,
        textareaPlaceholder: textarea?.placeholder || null,
        textareaValue: textarea?.value || '',
        bodyContainsError: /error|please select|required|invalid/i.test(document.body.innerText || '')
      };
    });
    console.log('[diag] BEFORE:', JSON.stringify(before, null, 2));

    // TYPE the prompt using real keyboard events (like the skill does)
    console.log('[diag] clicking textarea, clearing, typing prompt...');
    const ta = await page.$('textarea');
    if (!ta) { console.log('[diag] NO textarea -- aborting'); return; }
    await ta.click();
    await page.keyboard.down('Meta'); await page.keyboard.press('a'); await page.keyboard.up('Meta');
    await page.keyboard.press('Backspace');
    for (const ch of PROMPT) {
      await page.keyboard.type(ch, { delay: 10 + Math.random() * 30 });
    }
    await page.waitForTimeout(800);

    const afterType = await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      const genBtn = Array.from(document.querySelectorAll('button')).find(b => /^generate\b/i.test((b.innerText || '').trim()) && b.getBoundingClientRect().width > 100);
      return {
        textareaValue: ta?.value || '',
        generateText: genBtn?.innerText?.trim() || null,
        generateDisabled: genBtn?.disabled ?? null
      };
    });
    console.log('[diag] AFTER TYPE:', JSON.stringify(afterType, null, 2));

    // CLICK Generate
    const clickTime = Date.now();
    events.push({ t: clickTime, type: 'marker', label: 'CLICKING GENERATE NOW' });
    console.log('[diag] clicking Generate...');
    const clickedSel = await page.evaluate(() => {
      const genBtn = Array.from(document.querySelectorAll('button')).find(b => /^generate\b/i.test((b.innerText || '').trim()) && b.getBoundingClientRect().width > 100);
      if (!genBtn) return { error: 'no generate button' };
      genBtn.scrollIntoView({ block: 'center' });
      const r = genBtn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: genBtn.innerText, disabled: genBtn.disabled };
    });
    console.log('[diag] button resolved:', JSON.stringify(clickedSel));
    if (clickedSel.error) return;
    await page.mouse.move(clickedSel.x, clickedSel.y, { steps: 5 });
    await page.waitForTimeout(100);
    await page.mouse.click(clickedSel.x, clickedSel.y);

    console.log('[diag] clicked. observing network + DOM for 30s...');
    for (let t = 2; t <= 30; t += 2) {
      await page.waitForTimeout(2000);
      const snap = await page.evaluate(() => {
        // Find toast/alert messages
        const toasts = Array.from(document.querySelectorAll('[role="alert"], [class*="toast" i], [class*="notification" i], [class*="error" i]'))
          .map(el => (el.innerText || '').trim()).filter(Boolean).slice(0, 5);
        return {
          url: location.href,
          bodyText: (document.body?.innerText || '').slice(0, 400).replace(/\s+/g, ' '),
          toasts
        };
      });
      console.log(`[diag] t+${t}s url=${snap.url}`);
      if (snap.toasts.length) console.log('  toasts:', snap.toasts);
    }

    console.log('\n[diag] ALL fnf+notification events:');
    events.forEach(e => {
      if (e.type === 'marker') { console.log(`  --- ${e.label} --- (elapsed since click 0ms)`); return; }
      const rel = e.t - clickTime;
      if (e.type === 'req') console.log(`  [t+${rel}ms] REQ  ${e.method} ${e.path}`);
      else console.log(`  [t+${rel}ms] RESP ${e.status} ${e.method} ${e.path} body="${(e.body || '').slice(0, 80)}"`);
    });

    await page.screenshot({ path: '/tmp/hf-video-after-click.png' }).catch(() => {});
    console.log('\n[diag] screenshot /tmp/hf-video-after-click.png');
  } finally {
    await ctx.close();
  }
}
main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

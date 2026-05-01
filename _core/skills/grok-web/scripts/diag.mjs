// diag.mjs -- survey live grok.com state to discover selectors and network shapes.
// Writes:
//   01-loaded.png                screenshot after page settle
//   02-session.json              probeSession() result
//   03-composer-survey.json      candidate composers (textarea / contenteditable / role=textbox)
//   04-send-button-survey.json   candidate send buttons
//   05-model-picker-survey.json  buttons / menus that look like model pickers
//   06-mode-toggle-survey.json   Think / DeepSearch / Reason toggles
//   07-page-meta.json            url + title + first 2k chars body text
//   08-typed.png                 screenshot after typing prompt
//   09-after-submit.png          screenshot after pressing send
//   10-message-survey.json       assistant/user turn DOM shapes
//   11-network-capture.json      every network request the page made during
//                                 chat (URL, method, content-type, status, transport)
//   12-page-meta-after.json      url + title + body after submit
//   13-quota-probe.json          attempted quota endpoints + their responses
//   14-models-list.json          if model picker opened, the list of available models

import { launchContext, probeSession, attachCapture, detectChallenge } from './browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runDiag({ outDir, prompt = 'Hello, who are you?', debug = false } = {}) {
  const RUN_DIR = outDir || `/tmp/grok-web-diag-${Date.now()}`;
  await mkdir(RUN_DIR, { recursive: true });
  console.error(`[diag] writing to ${RUN_DIR}`);

  const ctx = await launchContext({ visible: false });

  // Multi-transport capture is on from the start.
  const networkLog = [];
  const wsLog = [];

  ctx.page.on('request', (req) => {
    networkLog.push({
      kind: 'request',
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      headers: redactHeaders(req.headers()),
      t: Date.now()
    });
  });
  ctx.page.on('response', async (res) => {
    try {
      networkLog.push({
        kind: 'response',
        url: res.url(),
        status: res.status(),
        contentType: res.headers()['content-type'] || null,
        t: Date.now()
      });
    } catch (_) {}
  });
  ctx.page.on('websocket', (ws) => {
    const url = ws.url();
    wsLog.push({ url, openedAt: Date.now(), frames: [] });
    const entry = wsLog[wsLog.length - 1];
    ws.on('framereceived', (data) => {
      const payload = typeof data === 'object' && data?.payload != null ? data.payload : data;
      entry.frames.push({ dir: 'in', size: typeof payload === 'string' ? payload.length : (payload?.length || 0), preview: typeof payload === 'string' ? payload.slice(0, 200) : null, t: Date.now() });
    });
    ws.on('framesent', (data) => {
      const payload = typeof data === 'object' && data?.payload != null ? data.payload : data;
      entry.frames.push({ dir: 'out', size: typeof payload === 'string' ? payload.length : 0, preview: typeof payload === 'string' ? payload.slice(0, 200) : null, t: Date.now() });
    });
    ws.on('close', () => { entry.closedAt = Date.now(); });
  });

  try {
    await ctx.page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await ctx.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    await ctx.page.screenshot({ path: join(RUN_DIR, '01-loaded.png'), fullPage: false });

    const sess = await probeSession(ctx.page);
    await writeFile(join(RUN_DIR, '02-session.json'), JSON.stringify(sess, null, 2));

    const challenge = await detectChallenge(ctx.page);
    if (challenge) {
      await writeFile(join(RUN_DIR, '00-CHALLENGE.txt'), challenge);
      console.error(`[diag] WARNING: ${challenge} detected; remaining surveys may be of the challenge page, not the app.`);
    }

    // ---- Composer survey ----
    const composerSurvey = await ctx.page.evaluate(() => {
      const out = [];
      const candidates = [
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '[data-testid*="prompt" i]',
        '[data-testid*="composer" i]',
        '[aria-label*="ask" i]',
        '[aria-label*="message" i]',
        '[placeholder*="ask" i]',
        '[placeholder*="anything" i]',
        'form textarea',
        'form [contenteditable="true"]'
      ];
      for (const sel of candidates) {
        const els = document.querySelectorAll(sel);
        out.push({
          selector: sel,
          count: els.length,
          samples: Array.from(els).slice(0, 3).map(e => ({
            tag: e.tagName,
            id: e.id || null,
            role: e.getAttribute('role'),
            ce: e.getAttribute('contenteditable'),
            testid: e.getAttribute('data-testid'),
            ariaLabel: e.getAttribute('aria-label'),
            placeholder: e.getAttribute('placeholder'),
            cls: typeof e.className === 'string' ? e.className.slice(0, 120) : '',
            visible: !!(e.offsetWidth && e.offsetHeight),
            rect: { w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height }
          }))
        });
      }
      return out;
    });
    await writeFile(join(RUN_DIR, '03-composer-survey.json'), JSON.stringify(composerSurvey, null, 2));

    // ---- Send button survey ----
    const sendSurvey = await ctx.page.evaluate(() => {
      const out = [];
      const candidates = [
        'button[type="submit"]',
        'button[aria-label*="send" i]',
        'button[aria-label*="submit" i]',
        '[data-testid*="send" i]',
        'form button:last-child',
        'button svg[aria-label*="send" i]'
      ];
      for (const sel of candidates) {
        const els = document.querySelectorAll(sel);
        out.push({
          selector: sel,
          count: els.length,
          samples: Array.from(els).slice(0, 5).map(e => ({
            tag: e.tagName,
            disabled: e.disabled,
            label: e.getAttribute('aria-label'),
            testid: e.getAttribute('data-testid'),
            text: (e.innerText || '').slice(0, 80),
            visible: !!(e.offsetWidth && e.offsetHeight)
          }))
        });
      }
      return out;
    });
    await writeFile(join(RUN_DIR, '04-send-button-survey.json'), JSON.stringify(sendSurvey, null, 2));

    // ---- Model picker + Mode toggle survey ----
    // Heuristic: look for any button whose text matches "grok" / model
    // versions, or labels mentioning "model"; also look for buttons whose
    // text is "Think" / "DeepSearch" / "Reason" (mode toggles).
    const pickerSurvey = await ctx.page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'));
      const summarize = (e) => ({
        tag: e.tagName,
        role: e.getAttribute('role'),
        label: e.getAttribute('aria-label'),
        testid: e.getAttribute('data-testid'),
        text: (e.innerText || '').trim().slice(0, 80),
        pressed: e.getAttribute('aria-pressed'),
        expanded: e.getAttribute('aria-expanded'),
        cls: typeof e.className === 'string' ? e.className.slice(0, 120) : '',
        rect: { w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height },
        visible: !!(e.offsetWidth && e.offsetHeight)
      });
      const modelLike = all.filter(e => {
        const t = (e.innerText || '').toLowerCase();
        const l = (e.getAttribute('aria-label') || '').toLowerCase();
        return /grok|model|version/.test(t) || /grok|model|version/.test(l);
      }).map(summarize);
      const modeLike = all.filter(e => {
        const t = (e.innerText || '').toLowerCase();
        const l = (e.getAttribute('aria-label') || '').toLowerCase();
        return /\bthink\b|deep ?search|reason\b|big brain|expert/.test(t) || /think|deepsearch|reason/.test(l);
      }).map(summarize);
      return { modelLike, modeLike };
    });
    await writeFile(join(RUN_DIR, '05-model-picker-survey.json'), JSON.stringify(pickerSurvey.modelLike, null, 2));
    await writeFile(join(RUN_DIR, '06-mode-toggle-survey.json'), JSON.stringify(pickerSurvey.modeLike, null, 2));

    const meta = await ctx.page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 2000)
    }));
    await writeFile(join(RUN_DIR, '07-page-meta.json'), JSON.stringify(meta, null, 2));

    // ---- Try opening the model picker (best-effort) ----
    let modelsList = null;
    if (pickerSurvey.modelLike.length > 0) {
      try {
        const opened = await ctx.page.evaluate((labelHints) => {
          const all = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'));
          for (const e of all) {
            const t = (e.innerText || '').toLowerCase();
            const l = (e.getAttribute('aria-label') || '').toLowerCase();
            if (/grok 4|grok-4|auto/.test(t) || /grok 4|grok-4|auto/.test(l) || /model/.test(l)) {
              const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
              e.dispatchEvent(ev);
              return { clicked: t || l, tag: e.tagName };
            }
          }
          return null;
        }, []);
        if (opened) {
          await new Promise(r => setTimeout(r, 1500));
          modelsList = await ctx.page.evaluate(() => {
            // After opening picker, list items are usually role=menuitem or role=option.
            const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"]'));
            return items.map(e => ({
              role: e.getAttribute('role'),
              text: (e.innerText || '').trim().slice(0, 100),
              testid: e.getAttribute('data-testid'),
              ariaLabel: e.getAttribute('aria-label'),
              ariaSelected: e.getAttribute('aria-selected'),
              visible: !!(e.offsetWidth && e.offsetHeight)
            }));
          });
          await ctx.page.keyboard.press('Escape').catch(() => {});
        }
      } catch (_) {}
    }
    await writeFile(join(RUN_DIR, '14-models-list.json'), JSON.stringify(modelsList, null, 2));

    // ---- Type prompt + send + observe ----
    const composer = await ctx.page.$('textarea, [contenteditable="true"], [role="textbox"]');
    if (composer) {
      await composer.click();
      await ctx.page.keyboard.type(prompt, { delay: 6 });
      await new Promise(r => setTimeout(r, 800));
      await ctx.page.screenshot({ path: join(RUN_DIR, '08-typed.png'), fullPage: false });

      // Try clicking a send button; fall back to Cmd+Enter then Enter.
      let submittedHow = 'none';
      try {
        const btn = await ctx.page.$('button[type="submit"], [data-testid*="send" i], button[aria-label*="send" i]');
        if (btn) { await btn.click({ timeout: 2000 }); submittedHow = 'send-button'; }
        else { await ctx.page.keyboard.press('Meta+Enter'); submittedHow = 'meta-enter'; }
      } catch (e) {
        try { await ctx.page.keyboard.press('Enter'); submittedHow = `enter-fallback (${e.message})`; }
        catch (_) {}
      }
      await writeFile(join(RUN_DIR, '08b-submit-method.txt'), submittedHow);

      await new Promise(r => setTimeout(r, 30000));
      await ctx.page.screenshot({ path: join(RUN_DIR, '09-after-submit.png'), fullPage: true });

      const messageSurvey = await ctx.page.evaluate(() => {
        const out = [];
        const candidates = [
          '[data-message-author-role="assistant"]',
          '[data-message-author-role="user"]',
          '[data-testid^="conversation-turn"]',
          '[data-testid*="message"]',
          'main article',
          'div[data-message-id]',
          '[role="article"]'
        ];
        for (const sel of candidates) {
          const els = document.querySelectorAll(sel);
          out.push({
            selector: sel,
            count: els.length,
            samples: Array.from(els).slice(0, 5).map(e => ({
              tag: e.tagName,
              testid: e.getAttribute('data-testid'),
              role: e.getAttribute('data-message-author-role') || e.getAttribute('role'),
              mid: e.getAttribute('data-message-id'),
              text: (e.innerText || '').slice(0, 300)
            }))
          });
        }
        return out;
      });
      await writeFile(join(RUN_DIR, '10-message-survey.json'), JSON.stringify(messageSurvey, null, 2));

      const metaAfter = await ctx.page.evaluate(() => ({
        url: location.href,
        title: document.title,
        bodyText: (document.body?.innerText || '').slice(0, 4000)
      }));
      await writeFile(join(RUN_DIR, '12-page-meta-after.json'), JSON.stringify(metaAfter, null, 2));
    }

    // ---- Network capture summary ----
    // Group by likely-chat URLs (POST or anything containing chat-shape paths).
    const chatLike = networkLog.filter(e => {
      if (e.method !== 'POST' && e.kind === 'request') return false;
      return /chat|message|conversation|completion|stream|generate|response/i.test(e.url || '');
    });
    await writeFile(join(RUN_DIR, '11-network-capture.json'), JSON.stringify({
      ws_streams: wsLog.map(w => ({ url: w.url, openedAt: w.openedAt, closedAt: w.closedAt, frame_count: w.frames.length, first_3_in: w.frames.filter(f => f.dir === 'in').slice(0, 3) })),
      chat_like_http: chatLike,
      total_requests: networkLog.filter(e => e.kind === 'request').length,
      total_responses: networkLog.filter(e => e.kind === 'response').length,
      all_unique_origins: Array.from(new Set(networkLog.map(e => { try { return new URL(e.url).origin; } catch { return null; } }).filter(Boolean)))
    }, null, 2));

    // ---- Quota endpoint probe ----
    const quotaCandidates = [
      'https://grok.com/rest/rate-limits',
      'https://grok.com/api/rate-limits',
      'https://grok.com/rest/usage',
      'https://grok.com/api/usage',
      'https://accounts.x.ai/api/rate-limits'
    ];
    const quotaProbe = [];
    for (const url of quotaCandidates) {
      const r = await ctx.page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } });
          const text = await r.text();
          return { url: u, status: r.status, contentType: r.headers.get('content-type'), bodyPreview: (text || '').slice(0, 800) };
        } catch (e) { return { url: u, error: e.message }; }
      }, url);
      quotaProbe.push(r);
    }
    await writeFile(join(RUN_DIR, '13-quota-probe.json'), JSON.stringify(quotaProbe, null, 2));

  } finally {
    await ctx.close();
  }
  console.log(RUN_DIR);
}

function redactHeaders(h) {
  if (!h) return h;
  const out = {};
  for (const k of Object.keys(h)) {
    if (/cookie|authorization|x-csrf|x-xsrf|set-cookie/i.test(k)) out[k] = 'REDACTED';
    else out[k] = h[k];
  }
  return out;
}

// CLI shim so `node scripts/diag.mjs` also works.
if (import.meta.url === `file://${process.argv[1]}`) {
  await runDiag({ outDir: process.argv[2], debug: process.env.GROK_WEB_DEBUG === '1' });
}

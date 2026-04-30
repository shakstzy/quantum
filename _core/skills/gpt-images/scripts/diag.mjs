#!/usr/bin/env node
// diag.mjs -- inspect chatgpt.com DOM state to debug selector drift.
// Opens chrome (off-screen), navigates to chatgpt.com, types a prompt,
// captures screenshots + DOM samples at each step.

import { launchContext, probeSession } from './browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const RUN_DIR = process.argv[2] || `/tmp/gpt-images-diag-${Date.now()}`;
await mkdir(RUN_DIR, { recursive: true });
console.error(`[diag] writing to ${RUN_DIR}`);

const ctx = await launchContext({ visible: false });
try {
  await ctx.page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ctx.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  await ctx.page.screenshot({ path: join(RUN_DIR, '01-loaded.png'), fullPage: false });

  const sess = await probeSession(ctx.page);
  await writeFile(join(RUN_DIR, '02-session.json'), JSON.stringify(sess, null, 2));

  // Survey: which composer-like elements exist?
  const composerSurvey = await ctx.page.evaluate(() => {
    const out = [];
    const candidates = [
      '#prompt-textarea',
      'textarea',
      '[contenteditable="true"]',
      '[data-testid="prompt-textarea"]',
      'div[role="textbox"]'
    ];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      out.push({ selector: sel, count: els.length, samples: Array.from(els).slice(0, 3).map(e => ({
        tag: e.tagName, id: e.id, role: e.getAttribute('role'),
        ce: e.getAttribute('contenteditable'),
        testid: e.getAttribute('data-testid'),
        cls: e.className?.slice ? e.className.slice(0, 100) : '',
        rect: { w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height }
      })) });
    }
    return out;
  });
  await writeFile(join(RUN_DIR, '03-composer-survey.json'), JSON.stringify(composerSurvey, null, 2));

  // Survey: send button candidates.
  const sendSurvey = await ctx.page.evaluate(() => {
    const out = [];
    const candidates = [
      '[data-testid="send-button"]',
      '[data-testid="composer-send-button"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Submit" i]',
      'button[type="submit"]'
    ];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      out.push({ selector: sel, count: els.length, samples: Array.from(els).slice(0, 3).map(e => ({
        tag: e.tagName, label: e.getAttribute('aria-label'),
        testid: e.getAttribute('data-testid'),
        disabled: e.disabled,
        text: (e.innerText || '').slice(0, 40)
      })) });
    }
    return out;
  });
  await writeFile(join(RUN_DIR, '04-send-button-survey.json'), JSON.stringify(sendSurvey, null, 2));

  // Page title / url / first 1000 chars of body text.
  const meta = await ctx.page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: (document.body?.innerText || '').slice(0, 2000)
  }));
  await writeFile(join(RUN_DIR, '05-page-meta.json'), JSON.stringify(meta, null, 2));

  // If composer found, type a prompt and survey what appears.
  const composer = await ctx.page.$('#prompt-textarea, [contenteditable="true"], textarea');
  if (composer) {
    await composer.click();
    await ctx.page.keyboard.type('Please generate an image: a simple red apple on a wooden table', { delay: 8 });
    await new Promise(r => setTimeout(r, 1000));
    await ctx.page.screenshot({ path: join(RUN_DIR, '06-typed.png'), fullPage: false });

    // Survey send button state RIGHT NOW.
    const sendNow = await ctx.page.evaluate(() => {
      const sels = [
        '[data-testid="send-button"]',
        '[data-testid="composer-send-button"]',
        'button[aria-label*="Send" i]',
        'button[type="submit"]'
      ];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) return { selector: sel, found: true, disabled: el.disabled, label: el.getAttribute('aria-label') };
      }
      return { found: false };
    });
    await writeFile(join(RUN_DIR, '07-send-after-type.json'), JSON.stringify(sendNow, null, 2));

    // Try clicking send button (preferred) or pressing Enter.
    let submittedHow = 'none';
    try {
      const btn = await ctx.page.$('[data-testid="send-button"], [data-testid="composer-send-button"], button[aria-label*="Send" i]');
      if (btn) { await btn.click(); submittedHow = 'send-button'; }
      else { await ctx.page.keyboard.press('Enter'); submittedHow = 'enter-key'; }
    } catch (e) {
      submittedHow = `error: ${e.message}`;
    }
    await writeFile(join(RUN_DIR, '08-submit-method.txt'), submittedHow);

    // Wait 30s and survey what messages appeared.
    await new Promise(r => setTimeout(r, 30000));
    await ctx.page.screenshot({ path: join(RUN_DIR, '09-after-30s.png'), fullPage: true });

    const messageSurvey = await ctx.page.evaluate(() => {
      const out = [];
      const candidates = [
        '[data-message-author-role="assistant"]',
        '[data-message-author-role="user"]',
        '[data-testid^="conversation-turn"]',
        'article[data-testid^="conversation-turn"]',
        'main article',
        'div[data-message-id]'
      ];
      for (const sel of candidates) {
        const els = document.querySelectorAll(sel);
        out.push({
          selector: sel,
          count: els.length,
          samples: Array.from(els).slice(0, 5).map(e => ({
            tag: e.tagName,
            testid: e.getAttribute('data-testid'),
            role: e.getAttribute('data-message-author-role'),
            mid: e.getAttribute('data-message-id'),
            text: (e.innerText || '').slice(0, 200),
            imgs: Array.from(e.querySelectorAll('img')).map(im => ({
              src: im.getAttribute('src')?.slice(0, 200),
              w: im.naturalWidth, h: im.naturalHeight
            }))
          }))
        });
      }
      return out;
    });
    await writeFile(join(RUN_DIR, '10-message-survey.json'), JSON.stringify(messageSurvey, null, 2));

    // Page meta after.
    const metaAfter = await ctx.page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 3000)
    }));
    await writeFile(join(RUN_DIR, '11-page-meta-after.json'), JSON.stringify(metaAfter, null, 2));
  }
} finally {
  await ctx.close();
}
console.log(RUN_DIR);

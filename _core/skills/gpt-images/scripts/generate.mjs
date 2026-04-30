// generate.mjs -- drive chatgpt.com to produce an image, save it locally.
// Off-screen Chrome (patchright) navigates to chatgpt.com, types the prompt
// into the composer, polls the DOM for an assistant message containing an
// <img>, downloads the full-resolution asset via context.request (which
// inherits the session cookies), saves PNG + metadata to skill-output.

import { launchContext, probeSession, tripBreaker } from './browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const COMPOSER_SELECTOR = '#prompt-textarea';
const ASSISTANT_MSG_SELECTOR = '[data-message-author-role="assistant"]';

export async function runGenerate({ prompt, force = false, debug = false, outDir, timeoutMs = 180000 }) {
  if (!prompt || !prompt.trim()) throw new Error('prompt required');

  const runId = ts() + '-' + slugify(prompt);
  const runDir = outDir || join(process.env.HOME, '.quantum/skill-output/gpt-images', runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'prompt.txt'), prompt);

  const ctx = await launchContext({ force, visible: false });
  let metadata;
  try {
    await ctx.page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    const sess = await probeSession(ctx.page);
    if (!sess || !sess.user) {
      const url = ctx.page.url();
      throw new Error(`Session expired or never logged in (page at ${url}). Run: node scripts/run.mjs login`);
    }

    // Cloudflare / bot challenge surface check.
    const challenged = await ctx.page.evaluate(() => {
      const t = document.body?.innerText || '';
      return /just a moment|verify you are human|attention required/i.test(t);
    });
    if (challenged) {
      tripBreaker('cloudflare-challenge');
      throw new Error('chatgpt.com served a Cloudflare challenge. Try again headed (`run.mjs login` then close it) or wait.');
    }

    // Wait for composer.
    let composer;
    try {
      composer = await ctx.page.waitForSelector(COMPOSER_SELECTOR, { timeout: 30000 });
    } catch (_) {
      throw new Error('Composer not found within 30s. ChatGPT UI may have changed (selector: ' + COMPOSER_SELECTOR + '). Run with --debug to inspect.');
    }

    const fullPrompt = `Please generate an image: ${prompt}`;
    await composer.click();
    await ctx.page.keyboard.type(fullPrompt, { delay: 8 });
    if (debug) process.stderr.write(`[gpt-images] typed prompt (${fullPrompt.length} chars)\n`);

    // Wait for the send button to appear (it only renders once the composer
    // has content). ChatGPT's send-button selectors have shifted; try several.
    // If none resolves within 5s, fall back to Cmd+Enter (ProseMirror submit
    // shortcut), then plain Enter as a last resort.
    const sendSelectors = [
      '[data-testid="send-button"]',
      '[data-testid="composer-send-button"]',
      'button[aria-label*="Send" i]',
      'button[data-testid*="send" i]',
      'main form button[type="submit"]'
    ];
    const sendDeadline = Date.now() + 5000;
    let clickedSend = false;
    while (Date.now() < sendDeadline && !clickedSend) {
      for (const sel of sendSelectors) {
        const btn = await ctx.page.$(sel);
        if (btn) {
          const visible = await btn.isVisible().catch(() => false);
          const enabled = await btn.isEnabled().catch(() => false);
          if (visible && enabled) {
            try {
              await btn.click({ timeout: 2000 });
              if (debug) process.stderr.write(`[gpt-images] clicked send via ${sel}\n`);
              clickedSend = true;
              break;
            } catch (_) {}
          }
        }
      }
      if (!clickedSend) await new Promise(r => setTimeout(r, 250));
    }
    if (!clickedSend) {
      if (debug) process.stderr.write('[gpt-images] no send button found, falling back to Cmd+Enter\n');
      await ctx.page.keyboard.press('Meta+Enter').catch(() => {});
      await new Promise(r => setTimeout(r, 200));
      await ctx.page.keyboard.press('Enter').catch(() => {});
    }

    // Poll for image in newest assistant message.
    const result = await waitForGeneratedImage(ctx.page, { timeoutMs, debug });

    if (result.kind !== 'ready') {
      const summary = JSON.stringify(result).slice(0, 500);
      // Capture failure-state diagnostics next to the run dir.
      try {
        await ctx.page.screenshot({ path: join(runDir, 'failure.png'), fullPage: true });
        const dom = await ctx.page.evaluate(() => ({
          url: location.href,
          title: document.title,
          bodyText: (document.body?.innerText || '').slice(0, 4000),
          assistantTurns: document.querySelectorAll('[data-message-author-role="assistant"]').length,
          userTurns: document.querySelectorAll('[data-message-author-role="user"]').length,
          articles: document.querySelectorAll('article[data-testid^="conversation-turn"]').length,
          allMessages: document.querySelectorAll('[data-message-id]').length
        }));
        await writeFile(join(runDir, 'failure-dom.json'), JSON.stringify(dom, null, 2));
      } catch (_) {}
      throw new Error(`No image produced within ${Math.round(timeoutMs/1000)}s. Last poll: ${summary}. Diag in ${runDir}/failure.png + failure-dom.json`);
    }

    if (debug) process.stderr.write(`[gpt-images] image ready: ${result.src}\n`);

    // Download via context.request -- inherits browser cookies, reuses TLS session.
    const buffer = await downloadAsset(ctx.context, result.src);
    const ext = guessExt(result.src) || 'png';
    const imgPath = join(runDir, `image-1.${ext}`);
    await writeFile(imgPath, buffer);

    metadata = {
      run_id: runId,
      prompt,
      full_prompt: fullPrompt,
      image_url: result.src,
      image_path: imgPath,
      width: result.w || null,
      height: result.h || null,
      bytes: buffer.length,
      created_at: new Date().toISOString(),
      user: sess.user?.email || sess.user?.name || sess.user?.id || null,
      page_url: ctx.page.url()
    };
    await writeFile(join(runDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

    // Stdout: just the run dir, machine-readable.
    process.stdout.write(runDir + '\n');
  } finally {
    await ctx.close();
  }
  return { runDir, metadata };
}

async function waitForGeneratedImage(page, { timeoutMs, debug }) {
  const deadline = Date.now() + timeoutMs;
  let last = { kind: 'init' };
  while (Date.now() < deadline) {
    const r = await page.evaluate((sel) => {
      // Try the canonical selector first, fall back to article-based selector
      // that survives across ChatGPT UI revisions.
      let msgs = document.querySelectorAll(sel);
      if (!msgs.length) msgs = document.querySelectorAll('article[data-testid^="conversation-turn"]');
      if (!msgs.length) msgs = document.querySelectorAll('[data-message-id]');
      const lastMsg = msgs[msgs.length - 1];
      if (!lastMsg) {
        // Surface user-turn count for diagnostics: if there's no assistant
        // message AND no user message, the submit didn't land.
        const userTurns = document.querySelectorAll('[data-message-author-role="user"]').length;
        return { kind: 'no-message', userTurns };
      }
      // Look for any img inside the assistant turn that points at a real URL.
      const imgs = Array.from(lastMsg.querySelectorAll('img'));
      // ChatGPT renders the avatar img + the generated img; pick the one with
      // oaiusercontent or files.oai or sdmnt host (generated assets).
      const candidate = imgs.find(im => {
        const s = im.getAttribute('src') || im.src || '';
        if (!s) return false;
        if (s.startsWith('data:') || s.startsWith('blob:')) return false;
        if (/oaiusercontent\.com|files\.oai|sdmntpr|sdmntp\b/.test(s)) return true;
        // Fallback: any non-data, non-blob, non-relative img larger than 100px.
        if (/^https?:\/\//.test(s) && !/avatar|ico|logo/.test(s) && (im.naturalWidth || 0) >= 100) return true;
        return false;
      }) || imgs.find(im => {
        const s = im.getAttribute('src') || im.src || '';
        return s && !s.startsWith('data:') && !s.startsWith('blob:') && /^https?:\/\//.test(s) && !/avatar|ico|logo/.test(s);
      });
      if (!candidate) {
        const text = (lastMsg.innerText || '').slice(0, 300);
        return { kind: 'no-image-yet', text };
      }
      const src = candidate.getAttribute('src') || candidate.src;
      if (!candidate.naturalWidth || !candidate.naturalHeight) {
        return { kind: 'loading', src };
      }
      return { kind: 'ready', src, w: candidate.naturalWidth, h: candidate.naturalHeight };
    }, ASSISTANT_MSG_SELECTOR);
    if (debug) process.stderr.write(`[gpt-images] poll: ${JSON.stringify(r).slice(0, 200)}\n`);
    last = r;
    if (r.kind === 'ready') return r;
    await new Promise(rs => setTimeout(rs, 2500));
  }
  return last;
}

async function downloadAsset(context, url) {
  // Patchright/Playwright: context.request shares cookies with the browser
  // context. oaiusercontent URLs are usually pre-signed; this still works.
  const res = await context.request.get(url, { timeout: 60000 });
  if (!res.ok()) throw new Error(`Image fetch failed: HTTP ${res.status()} ${res.statusText()}`);
  return await res.body();
}

function slugify(s) {
  const out = (s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return out || 'image';
}

function guessExt(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.(png|jpg|jpeg|webp|gif)$/i);
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  } catch (_) {}
  return null;
}

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

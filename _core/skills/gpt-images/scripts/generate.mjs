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
  // ChatGPT renders generated images outside the [data-message-author-role]
  // wrapper used for text turns, so search globally for img elements whose
  // src points at OpenAI's asset CDNs. Take the LAST such match (most
  // recently added). The user's prompt does NOT contain images, so any new
  // assistant-side image is the generated one.
  const deadline = Date.now() + timeoutMs;
  let last = { kind: 'init' };
  while (Date.now() < deadline) {
    const r = await page.evaluate(() => {
      const allImgs = Array.from(document.querySelectorAll('img'));
      // Filter for "looks like a generated content image" hosts.
      const generated = allImgs.filter(im => {
        const s = im.getAttribute('src') || im.src || '';
        if (!s) return false;
        if (s.startsWith('data:') || s.startsWith('blob:')) return false;
        if (!/^https?:\/\//.test(s)) return false;
        // Exclude obvious chrome (avatars, logos, sprites).
        if (/avatar|profile-pic|logo|favicon|sprite|icon\.|emoji/i.test(s)) return false;
        // Whitelist OpenAI asset hosts.
        return /oaiusercontent\.com|files\.oaiusercontent|files\.oai|sdmntpr|sdmnt[a-z]+\.openai|cdn\.openai\.com|videos\.openai|assets\.oaistatic\.com\/img/i.test(s)
          // Or any large image inline (rect width >= 200) that isn't on our exclusion list.
          || (im.getBoundingClientRect().width >= 200 && im.getBoundingClientRect().height >= 200);
      });
      if (!generated.length) {
        const userTurns = document.querySelectorAll('[data-message-author-role="user"]').length;
        return { kind: 'no-image-yet', userTurns, totalImgs: allImgs.length };
      }
      const last = generated[generated.length - 1];
      const src = last.getAttribute('src') || last.src;
      if (!last.naturalWidth || !last.naturalHeight) {
        return { kind: 'loading', src };
      }
      // Stability check: image must be >= 200px in at least one dimension.
      // Tiny tracking pixels and inline previews would slip through otherwise.
      if (Math.max(last.naturalWidth, last.naturalHeight) < 200) {
        return { kind: 'too-small', src, w: last.naturalWidth, h: last.naturalHeight };
      }
      return { kind: 'ready', src, w: last.naturalWidth, h: last.naturalHeight };
    });
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

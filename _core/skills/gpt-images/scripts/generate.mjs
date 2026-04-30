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

    // Snapshot pre-submit state: existing image src set + user-turn count.
    // Used to (a) require a NEW image (not a stale prior one), (b) verify
    // that submission actually landed.
    const preSubmit = await ctx.page.evaluate(() => {
      const root = document.querySelector('main') || document.body;
      const imgSrcs = Array.from(root.querySelectorAll('img')).map(im => im.getAttribute('src') || im.src || '').filter(Boolean);
      const userTurns = document.querySelectorAll('[data-message-author-role="user"]').length;
      return { imgSrcs, userTurns };
    });
    if (debug) process.stderr.write(`[gpt-images] pre-submit: ${preSubmit.imgSrcs.length} imgs, ${preSubmit.userTurns} user turns\n`);

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
      // Single fallback: Cmd+Enter is the canonical ProseMirror submit
      // shortcut. Plain Enter inserts a hard break in ChatGPT's editor and
      // would corrupt the prompt, so it's not safe as a backup.
      if (debug) process.stderr.write('[gpt-images] no send button found within 5s, sending Cmd+Enter\n');
      await ctx.page.keyboard.press('Meta+Enter');
    }

    // Verify the submission actually landed: user-turn count must increment
    // within 10s. If not, the click was a no-op and we'd wait the full
    // image-poll timeout for nothing.
    const submitted = await waitForUserTurnIncrement(ctx.page, preSubmit.userTurns, 10000);
    if (!submitted) {
      throw new Error(`Submit did not register: user-turn count stayed at ${preSubmit.userTurns} for 10s after click+enter. Composer click may have missed.`);
    }
    if (debug) process.stderr.write('[gpt-images] submission landed (user turn appeared)\n');

    // Poll for a NEW image (not present in preSubmit.imgSrcs).
    const result = await waitForGeneratedImage(ctx.page, { timeoutMs, debug, excludeSrcs: new Set(preSubmit.imgSrcs) });

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

    // Download + content-type/magic-byte validation.
    const { body, ext } = await downloadAsset(ctx.context, result.src);
    const imgPath = join(runDir, `image-1.${ext}`);
    await writeFile(imgPath, body);

    metadata = {
      run_id: runId,
      prompt,
      full_prompt: fullPrompt,
      image_url: redactSig(result.src),
      image_path: imgPath,
      width: result.w || null,
      height: result.h || null,
      bytes: body.length,
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

async function waitForUserTurnIncrement(page, beforeCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await page.evaluate(() => document.querySelectorAll('[data-message-author-role="user"]').length);
    if (now > beforeCount) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function waitForGeneratedImage(page, { timeoutMs, debug, excludeSrcs = new Set() }) {
  // ChatGPT renders generated images outside the [data-message-author-role]
  // wrapper used for text turns. Scope search to <main> to avoid sidebar
  // chrome / hero images, then filter to OpenAI asset hosts OR sufficiently
  // large inline images. Stability gate: require two consecutive polls with
  // the same src + naturalWidth/Height before declaring ready, so we don't
  // download a low-res placeholder that gets swapped for full-res.
  const deadline = Date.now() + timeoutMs;
  let last = { kind: 'init' };
  let stableHits = 0;
  let stableSig = '';
  while (Date.now() < deadline) {
    const r = await page.evaluate(({ excludeArr }) => {
      const exclude = new Set(excludeArr);
      const root = document.querySelector('main') || document.body;
      const allImgs = Array.from(root.querySelectorAll('img'));
      const generated = allImgs.filter(im => {
        const s = im.getAttribute('src') || im.src || '';
        if (!s) return false;
        if (exclude.has(s)) return false; // pre-submit image, not new
        if (s.startsWith('data:') || s.startsWith('blob:')) return false;
        if (!/^https?:\/\//.test(s)) return false;
        if (/avatar|profile-pic|logo|favicon|sprite|icon\.|emoji/i.test(s)) return false;
        if (/oaiusercontent\.com|files\.oaiusercontent|files\.oai|sdmntpr|sdmnt[a-z]+\.openai|cdn\.openai\.com|videos\.openai|assets\.oaistatic\.com\/img|chatgpt\.com\/backend-api\/(estuary|files)/i.test(s)) return true;
        const r = im.getBoundingClientRect();
        return r.width >= 200 && r.height >= 200;
      });
      if (!generated.length) {
        const userTurns = document.querySelectorAll('[data-message-author-role="user"]').length;
        return { kind: 'no-image-yet', userTurns, totalImgs: allImgs.length };
      }
      const last = generated[generated.length - 1];
      const src = last.getAttribute('src') || last.src;
      if (!last.naturalWidth || !last.naturalHeight) return { kind: 'loading', src };
      if (Math.max(last.naturalWidth, last.naturalHeight) < 200) {
        return { kind: 'too-small', src, w: last.naturalWidth, h: last.naturalHeight };
      }
      return { kind: 'candidate', src, w: last.naturalWidth, h: last.naturalHeight };
    }, { excludeArr: Array.from(excludeSrcs) });
    if (debug) process.stderr.write(`[gpt-images] poll: ${JSON.stringify(r).slice(0, 200)}\n`);
    last = r;
    if (r.kind === 'candidate') {
      const sig = `${r.src}|${r.w}x${r.h}`;
      if (sig === stableSig) {
        stableHits++;
        if (stableHits >= 1) {
          // Two consecutive matching polls (this is the second).
          return { kind: 'ready', src: r.src, w: r.w, h: r.h };
        }
      } else {
        stableHits = 0;
        stableSig = sig;
      }
    } else {
      stableHits = 0;
      stableSig = '';
    }
    await new Promise(rs => setTimeout(rs, 2500));
  }
  return last;
}

async function downloadAsset(context, url) {
  // Patchright/Playwright: context.request shares cookies with the browser
  // context. oaiusercontent URLs are usually pre-signed; this still works.
  const res = await context.request.get(url, { timeout: 60000 });
  if (!res.ok()) throw new Error(`Image fetch failed: HTTP ${res.status()} ${res.statusText()}`);
  const body = await res.body();
  if (!body || body.length < 512) {
    throw new Error(`Image fetch returned ${body?.length || 0} bytes, expected >= 512. Likely a challenge or empty response.`);
  }
  // Magic-byte sniff to confirm we got a real image, not an HTML challenge
  // page that returned 200.
  const ext = sniffImageMagic(body);
  if (!ext) {
    const ct = res.headers()['content-type'] || 'unknown';
    throw new Error(`Downloaded body is not a recognized image (content-type=${ct}, first bytes=${body.slice(0, 8).toString('hex')}). Likely a challenge or HTML response.`);
  }
  return { body, ext };
}

function sniffImageMagic(buf) {
  if (!buf || buf.length < 4) return null;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  // WebP: 'RIFF' .... 'WEBP'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  // GIF: 'GIF87a' or 'GIF89a'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  return null;
}

function slugify(s) {
  const out = (s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return out || 'image';
}

function redactSig(url) {
  // Strip credential-bearing query params from the saved URL so that
  // metadata.json doesn't carry a signed download credential to disk.
  try {
    const u = new URL(url);
    for (const k of ['sig', 'signature', 'X-Amz-Signature', 'token']) {
      if (u.searchParams.has(k)) u.searchParams.set(k, 'REDACTED');
    }
    return u.toString();
  } catch (_) { return url; }
}

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

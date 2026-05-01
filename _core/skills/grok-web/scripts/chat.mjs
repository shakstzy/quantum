// chat.mjs -- drive grok.com to answer a prompt, capture the response.
//
// Hybrid pattern (per Codex + Gemini P0): drive the UI for steering
// (model picker, mode toggle, prompt entry, send), but read the network
// stream for the pristine text. DOM scrape is a fallback if network
// capture didn't classify the transport.
//
// Steering primitives are intentionally loose -- selectors get tightened
// after `diag.mjs` runs against the live site. The fallbacks here are
// good enough for the smoke test.

import { launchContext, probeSession, attachCapture, detectChallenge, tripBreaker } from './browser.mjs';
import { StreamAggregator } from './stream.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Live-discovered selectors (2026-04-30 against grok.com).
// Composer is a Tiptap/ProseMirror contenteditable div. Send button starts
// disabled+invisible and becomes enabled+visible once the composer has content.
const COMPOSER_SELECTORS = [
  'div.tiptap.ProseMirror[contenteditable="true"]',
  '[contenteditable="true"]',
  'textarea'
];

const SEND_SELECTORS = [
  '[data-testid="chat-submit"]',
  'button[aria-label="Submit"]',
  'button[type="submit"]'
];

const MODEL_PICKER_SELECTOR = 'button[aria-label="Model select"]';

// Mode is unified into the model picker per the live setting
// `useModelModeSelector3: true`. Each picker option doubles as a mode toggle.
const MODE_LABELS = {
  think: ['think', 'thinking', 'expert'],
  deepsearch: ['deepsearch', 'deep search', 'research'],
  default: ['fast', 'auto']
};

// Exit codes (used by run.mjs / cron pipelines)
//   0   ok
//   2   usage / not signed in
//   3   challenge / bot-detection (breaker tripped)
//   4   shadow-ban (submit accepted, no stream)
//   5   rate-limited (quota exhausted)
//   6   selector / steering failure (couldn't find composer or send)
//   7   stream timeout
const EXIT = { OK: 0, USAGE: 2, CHALLENGE: 3, SHADOW_BAN: 4, RATE_LIMIT: 5, STEERING: 6, TIMEOUT: 7 };

export async function runChat({ prompt, model = null, mode = 'default', force = false, debug = false, outDir, timeoutMs = 240000 }) {
  if (!prompt || !prompt.trim()) throw new Error('prompt required');

  const runId = ts() + '-' + slugify(prompt);
  const runDir = outDir || join(process.env.HOME, '.quantum/skill-output/grok-web', runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'prompt.txt'), prompt);

  const ctx = await launchContext({ force, visible: false });
  const aggregator = new StreamAggregator();
  let quotaSnapshot = null;
  let chatRequestsLog = [];

  // Watchdogs
  let firstChunkAt = null;
  let lastChunkAt = null;

  try {
    await ctx.page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    const challenge = await detectChallenge(ctx.page);
    if (challenge) {
      tripBreaker(`chat-challenge:${challenge}`);
      throw exitErr(EXIT.CHALLENGE, `grok.com served a ${challenge} challenge. Run \`run.mjs login\` headed to refresh.`);
    }

    const sess = await probeSession(ctx.page);
    if (!sess) {
      throw exitErr(EXIT.USAGE, 'Session expired or never logged in. Run: node scripts/run.mjs login');
    }

    // Attach capture BEFORE submitting so we don't miss the opening frames.
    const capture = await attachCapture(ctx.page, {
      urlFilter: (url, method) => {
        // Liberal filter; classifier in browser.mjs decides what is chat vs noise.
        if (method === 'WS') return /grok\.com|x\.ai/.test(url);
        return /grok\.com|x\.ai|api\./.test(url);
      },
      debug
    });

    capture.onChatChunk(({ transport, raw, parsed }) => {
      const now = Date.now();
      if (firstChunkAt == null) firstChunkAt = now;
      lastChunkAt = now;
      if (parsed) aggregator.ingestObject(parsed);
      else if (transport === 'sse') aggregator.ingestSSE(raw);
      else if (transport === 'ndjson') aggregator.ingestNDJSONLine(raw);
      else if (transport === 'ws') {
        // Try JSON first, fall back to raw text accumulation as content.
        try { const o = JSON.parse(raw); aggregator.ingestObject(o); }
        catch { /* skip non-JSON ws frames; tokens come as JSON in known UIs */ }
      }
      if (debug) process.stderr.write(`[chat] chunk via ${transport} (text now ${aggregator.text.length} chars)\n`);
    });
    capture.onChatTerminal(({ reason }) => {
      if (debug) process.stderr.write(`[chat] terminal signal: ${reason}\n`);
      aggregator.markTransportClose(reason);
    });
    capture.onQuota((q) => {
      quotaSnapshot = q;
      if (q && q.ok === false) {
        if (debug) process.stderr.write(`[chat] quota signal: ${q.reason} waitSeconds=${q.waitSeconds}\n`);
      }
    });

    // ---- Pre-submit snapshot ----
    const preSubmit = await ctx.page.evaluate(() => {
      const turnSelectors = [
        '[data-message-author-role="user"]',
        '[data-testid^="conversation-turn"]',
        '[role="article"]'
      ];
      let userTurns = 0;
      for (const sel of turnSelectors) {
        const n = document.querySelectorAll(sel).length;
        if (n > userTurns) userTurns = n;
      }
      return { userTurns };
    });

    // ---- Steering: model + mode ----
    if (model) {
      const ok = await trySelectModel(ctx.page, model, debug);
      if (!ok) {
        if (debug) process.stderr.write(`[chat] could not pick model "${model}"; continuing with current default\n`);
      }
    }
    if (mode && mode !== 'default') {
      const ok = await tryToggleMode(ctx.page, mode, debug);
      if (!ok) {
        if (debug) process.stderr.write(`[chat] could not toggle mode "${mode}"; continuing without\n`);
      }
    }

    // ---- Compose + send ----
    const composer = await firstVisibleSelector(ctx.page, COMPOSER_SELECTORS);
    if (!composer) {
      throw exitErr(EXIT.STEERING, `Composer not found. Tried: ${COMPOSER_SELECTORS.join(', ')}. Run diag.`);
    }
    await composer.click();
    await ctx.page.keyboard.type(prompt, { delay: 6 });
    if (debug) process.stderr.write(`[chat] typed prompt (${prompt.length} chars)\n`);

    // Click send; fall back to Cmd+Enter (NEVER plain Enter -- can insert newline in contenteditable).
    let sent = false;
    const sendDeadline = Date.now() + 5000;
    while (Date.now() < sendDeadline && !sent) {
      for (const sel of SEND_SELECTORS) {
        const btn = await ctx.page.$(sel);
        if (!btn) continue;
        const visible = await btn.isVisible().catch(() => false);
        const enabled = await btn.isEnabled().catch(() => false);
        if (visible && enabled) {
          try { await btn.click({ timeout: 1500 }); sent = true; if (debug) process.stderr.write(`[chat] clicked send via ${sel}\n`); break; }
          catch (_) {}
        }
      }
      if (!sent) await new Promise(r => setTimeout(r, 200));
    }
    if (!sent) {
      if (debug) process.stderr.write('[chat] no send button; pressing Cmd+Enter\n');
      await ctx.page.keyboard.press('Meta+Enter');
    }

    // ---- Verify submission landed (user-turn increment) ----
    const submitted = await waitForUserTurnIncrement(ctx.page, preSubmit.userTurns, 10000);
    if (!submitted) {
      throw exitErr(EXIT.STEERING, `Submit did not register: user-turn count stayed at ${preSubmit.userTurns} for 10s.`);
    }
    if (debug) process.stderr.write('[chat] submission landed (user turn appeared)\n');

    // ---- Wait for stream terminal (network-first, multi-signal) ----
    const submittedAt = Date.now();
    const SHADOW_BAN_TIMEOUT = 30 * 1000;        // no chunks at all within 30s = shadow-ban
    const IDLE_TIMEOUT = 8 * 1000;                // no new chunks for 8s after first chunk = idle
    const HARD_TIMEOUT = timeoutMs;

    while (true) {
      if (aggregator.terminal) break;

      const now = Date.now();
      const elapsed = now - submittedAt;

      if (elapsed > HARD_TIMEOUT) {
        // Hard timeout. Capture failure DOM for diag.
        try {
          await ctx.page.screenshot({ path: join(runDir, 'failure.png'), fullPage: true });
          await writeFile(join(runDir, 'failure-network.json'), JSON.stringify(capture.chatRequests, null, 2));
        } catch (_) {}
        throw exitErr(EXIT.TIMEOUT, `Stream did not terminate within ${Math.round(HARD_TIMEOUT/1000)}s.`);
      }

      if (firstChunkAt == null) {
        if (elapsed > SHADOW_BAN_TIMEOUT) {
          // No stream at all. Possibly shadow-banned, possibly DOM-only response,
          // possibly classified as non-chat by our urlFilter. Try DOM fallback
          // before declaring shadow-ban.
          const domText = await scrapeAssistantText(ctx.page).catch(() => null);
          if (domText && domText.length > 20) {
            if (debug) process.stderr.write(`[chat] no stream captured, but DOM has ${domText.length} chars; using DOM fallback\n`);
            aggregator._textParts.push(domText);
            aggregator.markTransportClose('dom-fallback-no-stream');
            break;
          }
          try {
            await ctx.page.screenshot({ path: join(runDir, 'shadowban.png'), fullPage: true });
            await writeFile(join(runDir, 'shadowban-network.json'), JSON.stringify(capture.chatRequests, null, 2));
          } catch (_) {}
          throw exitErr(EXIT.SHADOW_BAN, 'Submit accepted but no stream within 30s. Possible shadow-ban or undetected transport. See shadowban.png + shadowban-network.json.');
        }
      } else {
        if (now - lastChunkAt > IDLE_TIMEOUT) {
          aggregator.markIdle();
          break;
        }
      }

      // Quota fast-fail: if we got a quota signal saying ok=false, exit early.
      if (quotaSnapshot && quotaSnapshot.ok === false) {
        try { await ctx.page.screenshot({ path: join(runDir, 'rate-limit.png'), fullPage: true }); } catch (_) {}
        throw exitErr(EXIT.RATE_LIMIT, `Rate-limited. wait_seconds=${quotaSnapshot.waitSeconds} reset_at=${quotaSnapshot.resetAt}`);
      }

      await new Promise(r => setTimeout(r, 400));
    }

    chatRequestsLog = capture.chatRequests;
    capture.stop();

    // ---- DOM-text supplement: if network text is suspiciously short, take DOM as ground truth ----
    let finalText = aggregator.text;
    let textSource = 'network';
    if (!finalText || finalText.length < 8) {
      const domText = await scrapeAssistantText(ctx.page).catch(() => null);
      if (domText && domText.length > finalText.length) {
        finalText = domText;
        textSource = 'dom-supplement';
      }
    }

    // ---- Persist outputs (REDACTED per Codex P1) ----
    await writeFile(join(runDir, 'response.md'), finalText || '');

    // metadata.json: NO cookies, NO auth headers, NO account email, NO signed
    // image URLs, NO conversation/message IDs, NO raw HAR.
    const metadata = {
      run_id: runId,
      created_at: new Date().toISOString(),
      prompt,
      requested_model: model,
      requested_mode: mode,
      response_chars: finalText.length,
      response_source: textSource,
      stream: {
        terminal_reason: aggregator.terminalReason,
        objects_seen: aggregator.objectsSeen,
        first_chunk_ms: firstChunkAt ? firstChunkAt - submittedAt : null,
        last_chunk_ms: lastChunkAt ? lastChunkAt - submittedAt : null,
        transports_seen: Array.from(new Set(chatRequestsLog.map(r => r.transport)))
      },
      citations_count: aggregator.citations.length,
      images_count: aggregator.images.length,
      quota: quotaSnapshot ? { ok: quotaSnapshot.ok, remaining: quotaSnapshot.remaining, total: quotaSnapshot.total, reset_at: quotaSnapshot.resetAt } : null,
      // intentionally omitted: cookies, auth, email, conversation_id, message_id, signed urls
    };
    if (aggregator.citations.length > 0) {
      // Citations are user-facing content; they go in metadata but URLs are not redacted (they're public refs).
      metadata.citations = aggregator.citations.map(c => ({ url: c.url, title: c.title, snippet: c.snippet ? c.snippet.slice(0, 200) : null }));
    }
    if (aggregator.images.length > 0) {
      // Image URLs are often signed -- redact query params per Codex P1.
      metadata.images = aggregator.images.map(im => ({ url: redactSig(im.url), w: im.w, h: im.h }));
    }
    await writeFile(join(runDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

    // Stdout: just the run dir.
    process.stdout.write(runDir + '\n');
  } catch (e) {
    if (e._exitCode) {
      process.stderr.write(`[grok-web] ${e.message}\n`);
      process.exitCode = e._exitCode;
    } else {
      throw e;
    }
  } finally {
    await ctx.close();
  }
}

// ---- helpers ----

async function firstVisibleSelector(page, selectors) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (!el) continue;
    const visible = await el.isVisible().catch(() => false);
    if (visible) return el;
  }
  return null;
}

async function trySelectModel(page, modelName, debug) {
  // Strategy: look for any button whose label/text contains "model" or a
  // grok version name; click; then click an option matching modelName.
  const opened = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'));
    for (const e of all) {
      const t = ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).toLowerCase();
      if (/grok|model/.test(t)) {
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        e.dispatchEvent(ev);
        return true;
      }
    }
    return false;
  });
  if (!opened) return false;
  await page.waitForTimeout(800);
  const clicked = await page.evaluate((target) => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"], button'));
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const want = norm(target);
    for (const e of items) {
      const t = norm(e.innerText || e.getAttribute('aria-label') || '');
      if (t === want || t.includes(want)) {
        e.click();
        return t;
      }
    }
    return null;
  }, modelName);
  if (debug) process.stderr.write(`[chat] model select clicked: ${clicked || '(none matched)'}\n`);
  return !!clicked;
}

async function tryToggleMode(page, mode, debug) {
  const labels = MODE_LABELS[mode] || [mode];
  const clicked = await page.evaluate((wanted) => {
    const all = Array.from(document.querySelectorAll('button, [role="button"], [role="switch"], [role="radio"]'));
    for (const e of all) {
      const t = ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).toLowerCase();
      for (const w of wanted) {
        if (t.includes(w)) {
          // Don't click if already enabled.
          const pressed = e.getAttribute('aria-pressed');
          const checked = e.getAttribute('aria-checked');
          if (pressed === 'true' || checked === 'true') return `already-on:${t.slice(0,40)}`;
          e.click();
          return `clicked:${t.slice(0,40)}`;
        }
      }
    }
    return null;
  }, labels);
  if (debug) process.stderr.write(`[chat] mode toggle: ${clicked || '(no match)'}\n`);
  return !!clicked;
}

async function waitForUserTurnIncrement(page, beforeCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await page.evaluate(() => {
      const sels = ['[data-message-author-role="user"]', '[data-testid^="conversation-turn"]', '[role="article"]'];
      let best = 0;
      for (const sel of sels) {
        const n = document.querySelectorAll(sel).length;
        if (n > best) best = n;
      }
      return best;
    });
    if (now > beforeCount) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

async function scrapeAssistantText(page) {
  return page.evaluate(() => {
    // Try common assistant-turn selectors; pick the LAST one's full text.
    const sels = [
      '[data-message-author-role="assistant"]',
      '[data-testid*="assistant"]',
      'main article:last-child',
      '[role="article"]:last-child'
    ];
    for (const sel of sels) {
      const els = document.querySelectorAll(sel);
      if (els.length) {
        const last = els[els.length - 1];
        const txt = (last.innerText || '').trim();
        if (txt) return txt;
      }
    }
    return null;
  });
}

function exitErr(code, message) {
  const e = new Error(message);
  e._exitCode = code;
  return e;
}

function slugify(s) {
  const out = (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return out || 'chat';
}

function redactSig(url) {
  try {
    const u = new URL(url);
    for (const k of ['sig', 'signature', 'X-Amz-Signature', 'token', 'tk', 'auth']) {
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

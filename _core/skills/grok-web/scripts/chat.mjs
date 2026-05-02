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

// Live picker contents (verified 2026-05-02 against grok.com):
//   Auto     - "Chooses Fast or Expert"
//   Fast     - "Quick responses"
//   Expert   - "Thinks hard"            (= what used to be Think mode)
//   Heavy    - "Team of Experts"        (= the new heavy-research tier)
//   Grok 4.3 - "(beta) Early Access"
//
// xAI removed the standalone DeepSearch mode; --mode deepsearch fails loud
// with a redirect-to-heavy message rather than picking the wrong model.
//
// Each menu item's innerText concatenates the title + tagline (e.g.
// "Expert Thinks hard"), so we list both forms as candidates -- pickFromOpenMenu
// matches via exact-then-contains, so the title alone resolves correctly.
const MODEL_ALIASES = {
  auto:        ['Auto', 'Auto Chooses Fast or Expert'],
  default:     ['Auto', 'Auto Chooses Fast or Expert'],
  fast:        ['Fast', 'Fast Quick responses'],
  expert:      ['Expert', 'Expert Thinks hard'],
  think:       ['Expert', 'Expert Thinks hard'],     // legacy alias
  thinking:    ['Expert', 'Expert Thinks hard'],     // legacy alias
  heavy:       ['Heavy', 'Heavy Team of Experts'],
  research:    ['Heavy', 'Heavy Team of Experts'],   // closest match for old "research" intent
  'grok-4.3':  ['Grok 4.3', 'Grok 4.3 (beta) Early Access'],
  'grok-4-3':  ['Grok 4.3', 'Grok 4.3 (beta) Early Access'],
  beta:        ['Grok 4.3', 'Grok 4.3 (beta) Early Access']
};

// Modes that map to a model alias above are valid; deepsearch is explicitly
// dead (removed by xAI; we fail loud rather than silently picking Heavy or Expert).
const REMOVED_MODES = new Set(['deepsearch', 'deep search', 'deep-search']);

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
      else if (transport === 'json') {
        try { aggregator.ingestObject(JSON.parse(raw)); } catch (_) {}
      } else if (transport === 'ws') {
        try { aggregator.ingestObject(JSON.parse(raw)); } catch (_) {}
      }
      if (debug) process.stderr.write(`[chat] chunk via ${transport} (text now ${aggregator.text.length} chars, terminal=${aggregator.terminal})\n`);
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

    // ---- Submission verification: page.on('request') for chat POSTs ----
    // Listening for chunks is the WRONG signal: Playwright's response.text()
    // only resolves at loadingFinished, so chunk-based "submission landed"
    // actually means "model finished generating" -- which guarantees timeout
    // for any Think/DeepSearch run >12s (Codex+Gemini round 1 P0).
    // page.on('request') fires the moment the POST headers go out; that is
    // the true "submit landed" signal.
    let submittedRequestAt = null;
    let bodyReadCompleteAt = null;
    const onRequestForSubmit = (req) => {
      const u = req.url();
      if (req.method() === 'POST' && /\/rest\/app-chat\/conversations\/(new|[^/?]+\/responses?)(\?|$)/.test(u)) {
        if (submittedRequestAt == null) submittedRequestAt = Date.now();
      }
    };
    ctx.page.on('request', onRequestForSubmit);
    capture.onChatChunk(({ transport, raw, parsed }) => {
      // First chunk seen on a chat path = body has finished downloading.
      if (bodyReadCompleteAt == null) bodyReadCompleteAt = Date.now();
    });

    // ---- Steering: unified model picker (mode is now an alias) ----
    // grok.com unified mode + model into a single picker. Resolve any
    // legacy --mode value to its model alias, then call pickModel once.
    let effectiveModel = model;
    if (mode && mode !== 'default') {
      if (REMOVED_MODES.has(mode.toLowerCase())) {
        throw exitErr(EXIT.USAGE,
          'DeepSearch was removed from grok.com (verified 2026-05-02). Use --model heavy ' +
          '(multi-expert "Team of Experts" tier) for deep research, or --model expert for grok-3 thinking.');
      }
      // mode → model alias (think→Expert, heavy→Heavy, etc.) -- explicit --model wins.
      if (!effectiveModel) effectiveModel = mode;
    }
    if (effectiveModel) {
      const matched = await pickModel(ctx.page, effectiveModel, debug);
      if (!matched) {
        const available = Object.keys(MODEL_ALIASES).filter(k => !['default','think','thinking','beta','grok-4-3','research'].includes(k)).join(', ');
        throw exitErr(EXIT.STEERING,
          `Could not select model "${effectiveModel}". Picker may have changed. ` +
          `Available aliases: ${available}. Run \`run.mjs diag\` to inspect.`);
      }
      // Heavy / Grok 4.3 / etc. may be gated by SuperGrok Heavy subscription.
      // When gated, picking the menu item opens a Radix [role=dialog] upgrade
      // modal that covers the entire viewport. Detect it and fail loud --
      // otherwise the next composer.click() blocks for 30s on intercepted
      // pointer events. (Live-observed 2026-05-02 with --model heavy.)
      const upgradeText = await detectUpgradeModal(ctx.page);
      if (upgradeText) {
        await dismissDialog(ctx.page);
        throw exitErr(EXIT.USAGE,
          `Model "${effectiveModel}" requires a higher-tier xAI subscription on this account. ` +
          `grok.com opened an upgrade dialog. Use --model expert (top tier on current plan) ` +
          `or fast/auto. Dialog excerpt: "${upgradeText.slice(0, 140)}..."`);
      }
      if (debug) process.stderr.write(`[chat] selected model: ${matched}\n`);
    }

    // ---- Compose + send ----
    const composer = await firstVisibleSelector(ctx.page, COMPOSER_SELECTORS);
    if (!composer) {
      throw exitErr(EXIT.STEERING, `Composer not found. Tried: ${COMPOSER_SELECTORS.join(', ')}. Run diag.`);
    }
    await composer.click();
    await ctx.page.keyboard.type(prompt, { delay: 6 });
    if (debug) process.stderr.write(`[chat] typed prompt (${prompt.length} chars)\n`);
    const submittedAt = Date.now();

    // The submit button starts disabled+invisible and only enables once the
    // composer has content. Wait up to 8s for it to flip; then click.
    // Fall back to Cmd+Enter (NEVER plain Enter -- inserts newline in Tiptap).
    let sent = false;
    const sendDeadline = Date.now() + 8000;
    while (Date.now() < sendDeadline && !sent) {
      for (const sel of SEND_SELECTORS) {
        const btn = await ctx.page.$(sel);
        if (!btn) continue;
        const visible = await btn.isVisible().catch(() => false);
        const enabled = await btn.isEnabled().catch(() => false);
        if (visible && enabled) {
          try { await btn.click({ timeout: 2000 }); sent = true; if (debug) process.stderr.write(`[chat] clicked send via ${sel}\n`); break; }
          catch (_) {}
        }
      }
      if (!sent) await new Promise(r => setTimeout(r, 250));
    }
    if (!sent) {
      if (debug) process.stderr.write('[chat] send button never enabled; pressing Cmd+Enter\n');
      await ctx.page.keyboard.press('Meta+Enter');
    }

    // ---- Verify submission landed (chat POST request observed) ----
    const verifyDeadline = Date.now() + 12000;
    while (Date.now() < verifyDeadline && submittedRequestAt == null) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (submittedRequestAt == null) {
      throw exitErr(EXIT.STEERING, 'Submit did not register: no chat POST request observed within 12s. Composer click may have missed.');
    }
    if (debug) process.stderr.write(`[chat] submission landed (POST observed at +${submittedRequestAt - submittedAt}ms)\n`);

    // ---- Wait for stream terminal (network-first, multi-signal) ----
    // grok streams the entire conversations/new response in one shot
    // (Playwright's response.text() resolves only after loadingFinished),
    // so the first network chunk lands AFTER the model is fully done.
    // Shadow-ban window covers slowest realistic case: DeepSearch + Think.
    const SHADOW_BAN_TIMEOUT = 90 * 1000;
    const IDLE_TIMEOUT = 12 * 1000;
    const HARD_TIMEOUT = timeoutMs;

    while (true) {
      if (aggregator.terminal) break;

      const now = Date.now();
      const elapsed = now - submittedAt;

      if (elapsed > HARD_TIMEOUT) {
        // Hard timeout. Capture failure DOM for diag.
        try {
          await ctx.page.screenshot({ path: join(runDir, 'failure.png'), fullPage: true });
          await writeFile(join(runDir, 'failure-network.json'), JSON.stringify(redactRequestList(capture.chatRequests), null, 2));
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
            await writeFile(join(runDir, 'shadowban-network.json'), JSON.stringify(redactRequestList(capture.chatRequests), null, 2));
          } catch (_) {}
          throw exitErr(EXIT.SHADOW_BAN, `Submit accepted but no stream within ${Math.round(SHADOW_BAN_TIMEOUT/1000)}s. Possible shadow-ban or undetected transport. See shadowban.png + shadowban-network.json.`);
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
    ctx.page.off('request', onRequestForSubmit);

    // ---- Pick final text source ----
    // Trust the network text whenever the stream terminated via a confirmed
    // signal from the chat path (json-terminal = isSoftStop / modelResponse;
    // http-loadingFinished from the chat URL). Use DOM scrape only when the
    // network parser yielded nothing (transport not classified, idle timeout,
    // or shadow-ban-but-DOM-has-content fallback path).
    let finalText = aggregator.text;
    let textSource = 'network';
    if (!finalText) {
      const domText = await scrapeAssistantText(ctx.page).catch(() => null);
      if (domText) {
        finalText = domText;
        textSource = 'dom-fallback';
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
        // submitted_to_request_ms = how long after click the POST headers
        //   went out. Real network latency to the chat backend.
        // body_complete_ms = how long after click until the response body
        //   finished downloading (= model done generating, since grok streams
        //   the whole NDJSON in one shot and Playwright's response.text()
        //   only resolves at loadingFinished). NOT first-chunk latency.
        submitted_to_request_ms: submittedRequestAt ? submittedRequestAt - submittedAt : null,
        body_complete_ms: bodyReadCompleteAt ? bodyReadCompleteAt - submittedAt : null,
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

// Live-discovered: model picker is `button[aria-label="Model select"]`,
// currently shows the active model name as text (e.g. "Fast"). Clicking opens
// a menu of [role="menuitem"] / [role="option"] entries. Per
// `useModelModeSelector3: true`, the same picker handles BOTH model and mode
// selection, so trySelectModel and tryToggleMode use the same picker.
async function openModelPicker(page, debug) {
  const btn = await page.$(MODEL_PICKER_SELECTOR);
  if (!btn) {
    if (debug) process.stderr.write('[chat] model picker not found\n');
    return false;
  }
  await btn.click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(600);
  return true;
}

async function pickFromOpenMenu(page, candidates, debug) {
  const result = await page.evaluate((wanted) => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"]'));
    const visible = items.filter(e => e.offsetWidth > 0 && e.offsetHeight > 0);
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const labels = visible.map(e => norm(e.innerText || e.getAttribute('aria-label') || ''));
    for (const w of wanted) {
      const target = norm(w);
      // Exact match first, then contains.
      let idx = labels.findIndex(l => l === target);
      if (idx === -1) idx = labels.findIndex(l => l.includes(target));
      if (idx !== -1) {
        visible[idx].click();
        return { matched: labels[idx] };
      }
    }
    return { matched: null, available: labels.slice(0, 20) };
  }, candidates);
  if (debug) process.stderr.write(`[chat] picker pick: ${JSON.stringify(result)}\n`);
  return result.matched || null;
}

// Unified model selection. Accepts either a real picker label ("Heavy") or
// an alias ("think", "research", "beta"). Returns the matched label string,
// or null if the picker didn't have it.
//
// Recovery: if the menu opens but no label matches, we MUST close the picker
// before returning -- otherwise the open menu portal overlays the composer
// and the next composer.click() blocks on `<html> intercepts pointer events`
// for the full 30s default timeout. (Hit live 2026-05-02 with --mode deepsearch.)
async function pickModel(page, modelName, debug) {
  const lower = (modelName || '').toLowerCase().trim();
  const candidates = MODEL_ALIASES[lower] || [modelName];
  if (!await openModelPicker(page, debug)) return null;
  const matched = await pickFromOpenMenu(page, candidates, debug);
  if (!matched) {
    if (debug) process.stderr.write(`[chat] no menu match for "${modelName}"; force-closing picker\n`);
    await ensurePickerClosed(page, debug);
  } else {
    await waitForPickerClosed(page, debug);
  }
  return matched;
}

// Detect the SuperGrok upgrade modal that grok.com opens after selecting a
// gated tier (Heavy, Grok 4.3 beta on plans without entitlement). The dialog
// is a Radix [role=dialog][data-state=open] with paywall copy. Returns a
// short excerpt of the dialog text if open, else null.
async function detectUpgradeModal(page) {
  return await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"][data-state="open"]');
    if (!d) return null;
    const text = (d.innerText || '').replace(/\s+/g, ' ').trim();
    // Match SuperGrok / SuperGrok Heavy / Grok plan upgrade copy.
    if (/upgrade to supergrok|world's most powerful|near-unlimited usage|current plan/i.test(text)) {
      return text;
    }
    return null;
  }).catch(() => null);
}

// Dismiss a Radix dialog with Escape. Safe here (unlike round-1 P2): we
// call this only after deciding to abort the run, so there's no composer
// typing in flight to clip. Closes any modal blocking the viewport.
async function dismissDialog(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

// Idempotently make sure the picker is closed. If aria-expanded is still true,
// click the picker button again (which natively toggles closed). Never use
// Escape (round 1 P2: clips composer typing) or synthetic body click.
async function ensurePickerClosed(page, debug) {
  const open = await page.evaluate(sel =>
    document.querySelector(sel)?.getAttribute('aria-expanded') === 'true',
    MODEL_PICKER_SELECTOR
  ).catch(() => false);
  if (!open) return;
  await page.click(MODEL_PICKER_SELECTOR, { timeout: 2000 }).catch(() => {});
  await waitForPickerClosed(page, debug);
}

// After picking from the menu, the picker animates closed (~200-500ms in
// most React/headlessui transitions). If we proceed to composer.click()
// during that window, the click may land on the still-open menu overlay
// instead of the composer, leaving the composer unfocused -- subsequent
// keyboard.type() fires into the wrong target and the prompt is lost.
// Live-observed 2026-04-30 with --mode think on a 240-char prompt.
//
// Fix: poll aria-expanded on the picker button until it flips to false,
// up to 1500ms. Never use Escape (round 1 P2: clips typing) or synthetic
// body mousedown (round 1 P2 from Gemini: can hit router/logo).
async function waitForPickerClosed(page, debug) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const open = await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      return btn?.getAttribute('aria-expanded') === 'true';
    }, MODEL_PICKER_SELECTOR).catch(() => false);
    if (!open) return;
    await page.waitForTimeout(80);
  }
  if (debug) process.stderr.write('[chat] picker still expanded after 1500ms wait; proceeding anyway\n');
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

// Redact UUIDs and rid= query params from network capture URLs before writing
// to failure / shadow-ban diagnostic JSON files. Per Codex+Gemini round 1 P1:
// raw chatRequests carry the conversation UUID in path segments and a `rid=`
// response-id query param, which the metadata.json policy explicitly omits;
// the failure paths must enforce the same.
function redactRequestList(reqs) {
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  return (reqs || []).map(r => ({
    ...r,
    url: typeof r.url === 'string'
      ? r.url.replace(uuidRe, 'UUID').replace(/([?&]rid=)[^&]+/gi, '$1REDACTED')
      : r.url
  }));
}

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

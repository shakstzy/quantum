// browser.mjs -- patchright launcher + multi-transport network capture for grok.com.
//
// Mirrors gpt-images for profile/breaker/pidfile mechanics. Adds a CDP-backed
// capture layer so chat.mjs can subscribe to fetch streams, SSE, and
// WebSocket frames without hardcoding any specific endpoint path. (Per Codex
// P0: do not assume SSE; treat transport as unknown and capture all three.)

import { chromium } from 'patchright';
import { chmod, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE_DIR = process.env.GROK_WEB_PROFILE_DIR
  || `${process.env.HOME}/.quantum/chrome-profiles/grok`;
const PIDFILE = join(PROFILE_DIR, '.skill.pid');
const BREAKER_FILE = join(PROFILE_DIR, '.breaker.json');

export function getProfileDir() { return PROFILE_DIR; }

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function acquirePidfile() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(PIDFILE, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      process.on('exit', releasePidfile);
      process.on('SIGINT', () => { releasePidfile(); process.exit(130); });
      process.on('SIGTERM', () => { releasePidfile(); process.exit(143); });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const old = parseInt(readFileSync(PIDFILE, 'utf8').trim(), 10);
        if (old && isAlive(old)) {
          throw new Error(`Profile locked by pid ${old}. Wait or kill it.`);
        }
        unlinkSync(PIDFILE);
      } catch (inner) {
        if (inner.message?.startsWith('Profile locked')) throw inner;
      }
    }
  }
  throw new Error('Could not acquire pidfile after 2 attempts.');
}

function releasePidfile() {
  try {
    if (existsSync(PIDFILE) && readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) {
      unlinkSync(PIDFILE);
    }
  } catch (_) {}
}

export function readBreaker() {
  if (!existsSync(BREAKER_FILE)) return { state: 'healthy', flagged_at: null, count_24h: 0, events: [] };
  try { return JSON.parse(readFileSync(BREAKER_FILE, 'utf8')); }
  catch (_) { return { state: 'healthy', flagged_at: null, count_24h: 0, events: [] }; }
}

export function writeBreaker(next) {
  writeFileSync(BREAKER_FILE, JSON.stringify(next, null, 2));
}

// Single-strike breaker: any auth challenge / cloudflare / captcha trips
// straight to halted. Codex P0: do not soften this.
export function tripBreaker(reason = 'unknown') {
  const now = Date.now();
  const b = readBreaker();
  const events = (b.events || []).filter(e => now - (e.t || e) < 24 * 3600 * 1000);
  events.push({ t: now, reason });
  const next = {
    state: 'halted',
    flagged_at: new Date(now).toISOString(),
    count_24h: events.length,
    events
  };
  writeBreaker(next);
  return next;
}

export function breakerAllowsLaunch(force = false) {
  if (force) return { ok: true, forced: true };
  const b = readBreaker();
  if (b.state === 'halted') {
    const elapsed = Date.now() - new Date(b.flagged_at).getTime();
    if (elapsed < 24 * 3600 * 1000) {
      return { ok: false, reason: 'breaker-halted', breaker: b };
    }
    writeBreaker({ state: 'healthy', flagged_at: null, count_24h: 0, events: [] });
  }
  return { ok: true, forced: false };
}

// visible=true for login (user must see it to sign in).
// visible=false runs Chrome off-screen so it doesn't steal focus, but is NOT
// headless -- grok.com likely flags pure headless via Cloudflare Turnstile.
export async function launchContext({ force = false, visible = false } = {}) {
  const check = breakerAllowsLaunch(force);
  if (!check.ok) {
    const err = new Error(`Circuit breaker HALT active since ${check.breaker.flagged_at}. 24h cooldown. Override with --force (strongly discouraged).`);
    err.code = 'BREAKER_HALTED';
    throw err;
  }

  await mkdir(PROFILE_DIR, { recursive: true });
  try { await chmod(PROFILE_DIR, 0o700); } catch (_) {}
  acquirePidfile();

  const windowArgs = visible
    ? []
    : ['--window-position=-2400,-2400', '--window-size=1440,900'];

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
      '--restore-last-session=false',
      ...windowArgs
    ]
  });

  const page = context.pages()[0] || await context.newPage();
  for (const p of context.pages()) {
    if (p !== page && p.url() === 'about:blank') {
      try { await p.close(); } catch (_) {}
    }
  }

  return {
    context,
    page,
    async close() {
      try { await context.close(); } finally { releasePidfile(); }
    }
  };
}

// ---------------------------------------------------------------------------
// Multi-transport network capture
// ---------------------------------------------------------------------------
// Subscribes to:
//   - page.on('response')  -> classify by content-type + body for SSE/NDJSON/JSON
//   - page.on('websocket') -> capture frames for the duration of the WS
//   - CDP Network.responseReceived for streamed fetch responses (raw chunks
//     are not exposed by Playwright's response.body() while a stream is open;
//     CDP gives loadingFinished + raw events as a fallback signal).
//
// Caller passes filter functions to decide which traffic is "the chat stream":
//   urlFilter(url, method, requestHeaders) -> bool   (request-side gate)
//   classify(response, body) -> 'chat' | 'quota' | null   (response-side gate)
//
// The returned `Capture` object exposes:
//   onChatChunk(cb)     -- cb({transport, raw, parsed})
//   onChatTerminal(cb)  -- cb({reason})
//   onQuota(cb)         -- cb(parsedRateLimit)
//   chatRequests        -- array of {url, method, status, transport, startedAt, endedAt}
//   stop()              -- detach all listeners
//
// chat.mjs combines these into a StreamAggregator from stream.mjs.

import { parseSSEChunk } from './stream.mjs';

export async function attachCapture(page, { urlFilter = () => true, debug = false } = {}) {
  const chatChunkCbs = [];
  const chatTerminalCbs = [];
  const quotaCbs = [];
  const chatRequests = [];

  const onChunk = (transport, raw, parsed) => {
    for (const cb of chatChunkCbs) {
      try { cb({ transport, raw, parsed }); } catch (e) {
        if (debug) process.stderr.write(`[capture] chunk cb threw: ${e.message}\n`);
      }
    }
  };
  const onTerminal = (reason) => {
    for (const cb of chatTerminalCbs) {
      try { cb({ reason }); } catch (e) {
        if (debug) process.stderr.write(`[capture] terminal cb threw: ${e.message}\n`);
      }
    }
  };
  const onQuota = (q) => {
    for (const cb of quotaCbs) {
      try { cb(q); } catch (e) {
        if (debug) process.stderr.write(`[capture] quota cb threw: ${e.message}\n`);
      }
    }
  };

  // ---- HTTP fetch / SSE / NDJSON via page.on('response') ----
  // For streaming responses, Playwright doesn't expose chunk-by-chunk reads.
  // We do best-effort: when the response settles (stream ends), grab the
  // full body and replay it through parseSSEChunk + line-split. For
  // streaming UX, the WebSocket path is often the real channel anyway.

  const responseHandler = async (response) => {
    try {
      const req = response.request();
      const url = response.url();
      const method = req.method();
      if (!urlFilter(url, method, req.headers())) return;

      const status = response.status();
      const headers = response.headers();
      const ct = headers['content-type'] || '';
      const startedAt = Date.now();

      // Quota endpoint (live-confirmed): POST /rest/rate-limits, JSON body
      // { remainingQueries, totalQueries, windowSizeSeconds, low/highEffortRateLimits }.
      const reqMethod = req.method();
      const isQuotaPath = /\/rest\/rate-limits\b/.test(url);
      if (isQuotaPath) {
        try {
          const body = await response.json().catch(() => null);
          if (body) {
            const { parseRateLimitJSON, parse429Response } = await import('./quota.mjs');
            const parsed = status === 429
              ? parse429Response({ status, headers, body })
              : parseRateLimitJSON(body);
            onQuota(parsed);
          }
        } catch (_) {}
      }

      // Status 429 on chat path: still emit quota.
      if (status === 429) {
        const { parse429Response } = await import('./quota.mjs');
        const body = await response.json().catch(() => null);
        onQuota(parse429Response({ status, headers, body }));
      }

      // Chat surface (live-confirmed):
      //   POST /rest/app-chat/conversations/new                  (first turn from root)
      //   POST /rest/app-chat/conversations/<id>/responses       (follow-up turn)
      // Body is NDJSON even though Content-Type says application/json.
      // GET /rest/app-chat/conversations* (listing) MUST be excluded -- that
      // returns finite JSON and would falsely terminate the aggregator.
      const isChatPath = reqMethod === 'POST' && /\/rest\/app-chat\/conversations\/(new|[^/?]+\/responses?)(\?|$)/.test(url);
      const isSSE = /text\/event-stream/i.test(ct);
      const isNDJSON = /(application\/x-ndjson|application\/jsonl|application\/stream\+json)/i.test(ct);
      if (!isChatPath && !isSSE && !isNDJSON) return;

      const transport = isSSE ? 'sse' : (isNDJSON ? 'ndjson' : (isChatPath ? 'ndjson' : 'http'));
      chatRequests.push({ url, method, status, transport, startedAt });

      // Best-effort: read the full body once finished. (Streaming UX is
      // captured by the page's own DOM updates; the network parser still
      // gets the pristine final text.) For grok the body is JSON-per-line
      // even though Content-Type says application/json.
      const text = await response.text().catch(() => null);
      if (typeof text !== 'string') return;
      const endedAt = Date.now();
      chatRequests[chatRequests.length - 1].endedAt = endedAt;

      if (isSSE) {
        for (const ev of parseSSEChunk(text)) onChunk('sse', ev, null);
      } else {
        // Try NDJSON-by-line; if there's only one line and it parses as JSON,
        // emit as a single object.
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length > 1) {
          for (const line of lines) onChunk('ndjson', line, null);
        } else if (lines.length === 1) {
          try { onChunk('json', lines[0], JSON.parse(lines[0])); }
          catch (_) { onChunk('ndjson', lines[0], null); }
        }
      }
      onTerminal(`http-loadingFinished:${response.url().slice(0, 80)}`);
    } catch (e) {
      if (debug) process.stderr.write(`[capture] response handler error: ${e.message}\n`);
    }
  };

  page.on('response', responseHandler);

  // ---- WebSocket frames ----
  // Playwright fires `websocket` events when a WS opens. Subscribe to
  // framereceived / framesent on each. Many AI chat UIs use WS for token
  // streaming, so this is often the real signal channel.
  const wsHandler = (ws) => {
    const url = ws.url();
    if (!urlFilter(url, 'WS', {})) return;
    chatRequests.push({ url, method: 'WS', status: null, transport: 'ws', startedAt: Date.now() });

    ws.on('framereceived', (data) => {
      const payload = typeof data === 'object' && data?.payload != null ? data.payload : data;
      if (typeof payload === 'string') {
        // Try JSON first; fall back to raw chunk.
        try {
          const obj = JSON.parse(payload);
          onChunk('ws', payload, obj);
        } catch (_) {
          onChunk('ws', payload, null);
        }
      } else if (payload instanceof Buffer) {
        onChunk('ws', payload.toString('utf8'), null);
      }
    });
    ws.on('close', () => {
      const r = chatRequests.find(x => x.url === url && x.transport === 'ws');
      if (r) r.endedAt = Date.now();
      onTerminal('ws-close');
    });
    ws.on('socketerror', (err) => {
      if (debug) process.stderr.write(`[capture] ws error: ${err}\n`);
    });
  };
  page.on('websocket', wsHandler);

  return {
    onChatChunk(cb) { chatChunkCbs.push(cb); },
    onChatTerminal(cb) { chatTerminalCbs.push(cb); },
    onQuota(cb) { quotaCbs.push(cb); },
    get chatRequests() { return chatRequests.slice(); },
    stop() {
      page.off('response', responseHandler);
      page.off('websocket', wsHandler);
    }
  };
}

// ---------------------------------------------------------------------------
// Session probe -- live-tested 2026-04-30 against grok.com.
//
// grok.com's web API lives at /rest/* (NOT /api/*; /api/* falls through to
// the Next.js SPA HTML shell). No /rest/me endpoint exists. We use any
// authenticated /rest/ endpoint as proof of session: a 200 JSON response
// proves cookies are valid; a 401/403 means logged out.
//
// Enrichment: read the x-userid cookie for user id, and pull /rest/user-settings
// for profile fields when available.
// ---------------------------------------------------------------------------
const AUTH_PROOF_CANDIDATES = [
  'https://grok.com/rest/user-settings',
  'https://grok.com/rest/app-chat/conversations?pageSize=1',
  'https://grok.com/rest/workspaces?pageSize=1'
];

export async function probeSession(page) {
  for (const url of AUTH_PROOF_CANDIDATES) {
    try {
      const res = await page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } });
        const text = await r.text();
        const ct = r.headers.get('content-type') || '';
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        return { status: r.status, ok: r.ok, contentType: ct, body };
      }, url);
      // Must be 200 + JSON. The Next.js SPA returns 200 + text/html which
      // would be a false positive.
      if (res.ok && /json/i.test(res.contentType) && res.body && typeof res.body === 'object') {
        const userId = await readUserIdCookie(page).catch(() => null);
        const enriched = url.includes('user-settings') ? res.body : null;
        return {
          ok: true,
          _probe_url: url,
          user_id: userId,
          email: enriched?.email || null,
          name: enriched?.displayName || enriched?.name || null,
          settings: enriched
        };
      }
      if (res.status === 401 || res.status === 403) return null;
    } catch (_) {}
  }
  return null;
}

async function readUserIdCookie(page) {
  const cookies = await page.context().cookies('https://grok.com/');
  const c = cookies.find(c => c.name === 'x-userid');
  return c?.value || null;
}

export async function waitForSignedIn(ctx, { timeoutMs = 15 * 60 * 1000, probeEveryMs = 3000, debug = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let iterations = 0;
  let lastErr = null;
  while (Date.now() < deadline) {
    iterations += 1;
    let sess = null;
    try {
      sess = await probeSession(ctx.page);
    } catch (e) {
      lastErr = e;
      if (debug) process.stderr.write(`[waitForSignedIn] iter ${iterations}: probeSession threw ${e.message}\n`);
    }
    if (sess) {
      if (debug) process.stderr.write(`[waitForSignedIn] signed in after ${iterations} iterations\n`);
      return sess;
    }
    if (debug && iterations % 10 === 0) {
      process.stderr.write(`[waitForSignedIn] iter ${iterations}, ${Math.round((deadline - Date.now())/1000)}s remaining\n`);
    }
    try {
      await new Promise((r, rj) => {
        const t = setTimeout(r, probeEveryMs);
        ctx.page.once?.('close', () => { clearTimeout(t); rj(new Error('page-closed')); });
      });
    } catch (e) {
      // page closed mid-wait. Exit cleanly with a useful error.
      throw new Error(`waitForSignedIn: page closed mid-wait (${e.message}); user likely closed Chrome window. Iterations: ${iterations}.`);
    }
  }
  throw new Error(`waitForSignedIn: timed out after ${iterations} iterations over ${Math.round(timeoutMs/1000)}s. Last probe error: ${lastErr?.message || 'none'}.`);
}

export async function detectChallenge(page) {
  try {
    return await page.evaluate(() => {
      const t = (document.body?.innerText || '').toLowerCase();
      // Cloudflare / Turnstile / captcha / X-side challenge surfaces.
      if (/just a moment|verify you are human|attention required|checking your browser/.test(t)) return 'cloudflare';
      if (/turnstile|cf-turnstile/i.test(document.documentElement?.outerHTML || '')) return 'turnstile';
      if (/captcha|are you a robot/i.test(t)) return 'captcha';
      if (/this account has been suspended|account locked/i.test(t)) return 'account-locked';
      return null;
    });
  } catch (_) {
    return null;
  }
}

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

      // Quota endpoint: heuristic match by URL path.
      const isQuotaPath = /\/(api\/)?(rate[-_]?limits?|usage|quota)(\/|\?|$)/i.test(url);
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

      // Chat-stream-shape: text/event-stream OR ndjson OR streamed json.
      const isSSE = /text\/event-stream/i.test(ct);
      const isNDJSON = /(application\/x-ndjson|application\/jsonl|application\/stream\+json)/i.test(ct);
      const isMaybeChat = isSSE || isNDJSON || /chat|message|conversation|response|completion|generate/i.test(url);
      if (!isMaybeChat) return;

      chatRequests.push({ url, method, status, transport: isSSE ? 'sse' : (isNDJSON ? 'ndjson' : 'http'), startedAt });

      // Best-effort: read the full body once finished. (Streaming UX is
      // captured by the page's own DOM updates; the network parser still
      // gets the pristine final text.)
      const text = await response.text().catch(() => null);
      if (typeof text !== 'string') return;
      const endedAt = Date.now();
      chatRequests[chatRequests.length - 1].endedAt = endedAt;

      if (isSSE) {
        for (const ev of parseSSEChunk(text)) onChunk('sse', ev, null);
      } else if (isNDJSON) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onChunk('ndjson', line, null);
        }
      } else if (/application\/json/i.test(ct)) {
        try {
          const obj = JSON.parse(text);
          onChunk('json', text, obj);
        } catch (_) {}
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
// Session probe -- best-effort across a few likely auth surfaces.
// First diag run will tell us which one grok.com actually uses; until then
// we try the most common shapes.
// ---------------------------------------------------------------------------
export async function probeSession(page) {
  const candidates = [
    'https://grok.com/api/auth/session',
    'https://grok.com/rest/auth/session',
    'https://accounts.x.ai/api/auth/session',
    'https://grok.com/api/user'
  ];
  for (const url of candidates) {
    try {
      const res = await page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } });
        const text = await r.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        return { status: r.status, ok: r.ok, body };
      }, url);
      if (res.ok && res.body && typeof res.body === 'object') {
        // Heuristic: any object with .user / .id / .email / .username
        if (res.body.user || res.body.id || res.body.email || res.body.username) {
          return { ...res.body, _probe_url: url };
        }
      }
    } catch (_) {}
  }
  return null;
}

export async function waitForSignedIn(ctx, { timeoutMs = 15 * 60 * 1000, probeEveryMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sess = await probeSession(ctx.page);
    if (sess) return sess;
    await new Promise(r => setTimeout(r, probeEveryMs));
  }
  throw new Error('waitForSignedIn: timed out waiting for valid session probe');
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

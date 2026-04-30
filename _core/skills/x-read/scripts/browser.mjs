// browser.mjs -- patchright launcher + capture of X GraphQL request templates
// AND organic response bodies.
//
// Strategy (v1):
//   - Attach a CDP listener for /i/api/graphql/* requests so we have a live
//     map of request templates (URL, headers, queryId) keyed by OperationName.
//     This is kept for future replay (cursor pagination, etc).
//   - Attach a Playwright page.on('response') listener that captures parsed
//     response bodies for the same requests, also keyed by OperationName.
//   - v1 verbs use the response-body path (zero extra HTTP from us). The
//     replay path (pageApi) is available but unused by v1.

import { chromium } from 'patchright';
import { chmod, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE_DIR = process.env.X_READ_PROFILE_DIR || `${process.env.HOME}/.quantum/chrome-profiles/x`;
const PIDFILE = join(PROFILE_DIR, '.skill.pid');
const BREAKER_FILE = join(PROFILE_DIR, '.breaker.json');

// Allowlist of GraphQL op names we'll touch. Any op outside this set is
// rejected at pageApi to keep the read-only contract auditable.
const ALLOWED_OPS = new Set(['Viewer', 'TweetDetail']);

export function getProfileDir() { return PROFILE_DIR; }

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function acquirePidfile() {
  if (existsSync(PIDFILE)) {
    const old = parseInt(readFileSync(PIDFILE, 'utf8').trim(), 10);
    if (old && isAlive(old)) {
      throw new Error(`Profile locked by pid ${old}. Wait or kill it.`);
    }
  }
  writeFileSync(PIDFILE, String(process.pid));
  process.on('exit', releasePidfile);
  process.on('SIGINT', () => { releasePidfile(); process.exit(130); });
  process.on('SIGTERM', () => { releasePidfile(); process.exit(143); });
}

function releasePidfile() {
  try {
    if (existsSync(PIDFILE) && readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) {
      unlinkSync(PIDFILE);
    }
  } catch (_) {}
}

export function readBreaker() {
  if (!existsSync(BREAKER_FILE)) return { state: 'healthy', flagged_at: null, events: [] };
  try { return JSON.parse(readFileSync(BREAKER_FILE, 'utf8')); }
  catch (_) { return { state: 'healthy', flagged_at: null, events: [] }; }
}

export function writeBreaker(next) {
  writeFileSync(BREAKER_FILE, JSON.stringify(next, null, 2));
}

// Single-strike halt. Adithya's main is X Premium; one challenge already
// represents account-risk we don't want to compound.
export function tripBreaker(reason) {
  const now = Date.now();
  const b = readBreaker();
  const events = (b.events || []).filter(t => now - t.at < 24 * 3600 * 1000);
  events.push({ at: now, reason: reason || 'unspecified' });
  const next = {
    state: 'halted',
    flagged_at: new Date(now).toISOString(),
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
    writeBreaker({ state: 'healthy', flagged_at: null, events: [] });
  }
  return { ok: true, forced: false };
}

// visible=true for login, false for runtime verbs.
export async function launchContext({ force = false, visible = false } = {}) {
  const check = breakerAllowsLaunch(force);
  if (!check.ok) {
    const err = new Error(`Circuit breaker HALT active since ${check.breaker.flagged_at}. 24h cooldown. Override with --force (strongly discouraged on a Premium account).`);
    err.code = 'BREAKER_HALTED';
    throw err;
  }

  await mkdir(PROFILE_DIR, { recursive: true });
  try { await chmod(PROFILE_DIR, 0o700); } catch (_) {}
  acquirePidfile();

  // Wrap entire setup in a single try/catch so any throw between
  // launchPersistentContext and CDP wiring releases the pidfile and tears
  // down a partially-constructed context. Round 2 finding IMP-13.
  let context, page, cdp;
  try {
    const windowArgs = visible
      ? []
      : ['--window-position=-2400,-2400', '--window-size=1440,900'];

    context = await chromium.launchPersistentContext(PROFILE_DIR, {
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

    page = await context.newPage();
    for (const p of context.pages()) {
      if (p !== page && p.url() === 'about:blank') {
        try { await p.close(); } catch (_) {}
      }
    }
  } catch (e) {
    if (context) { try { await context.close(); } catch (_) {} }
    releasePidfile();
    throw e;
  }

  // Template map (request side) and response map (body side), both keyed by
  // OperationName. Last-write-wins for templates (refresh on every request);
  // response map is one-shot per op per launch (we only need the first).
  const templates = new Map();
  const responses = new Map();
  const responseWaiters = new Map(); // op -> [resolve...]

  function isXGraphqlUrl(url) {
    return /^https?:\/\/(x|twitter)\.com\/i\/api\/graphql\/[^\/]+\/[^?]+/.test(url);
  }
  function parseOpFromUrl(url) {
    const m = url.match(/\/i\/api\/graphql\/([^\/]+)\/([^?]+)/);
    return m ? { queryId: m[1], op: m[2] } : null;
  }

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (e) => {
    try {
      const req = e?.request;
      if (!req) return;
      const url = req.url || '';
      if (!isXGraphqlUrl(url)) return;
      const parsed = parseOpFromUrl(url);
      if (!parsed) return;
      templates.set(parsed.op, {
        method: req.method,
        url,
        queryId: parsed.queryId,
        headers: { ...req.headers },
        postData: req.postData ?? null,
        capturedAt: Date.now()
      });
    } catch (_) {}
  });

  // Response capture via Playwright. Buffer the JSON body for the first
  // matching response per op. Resolve any waiters.
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!isXGraphqlUrl(url)) return;
      const parsed = parseOpFromUrl(url);
      if (!parsed) return;
      // Only capture the first response per op. If callers want a fresh one,
      // they must navigate again.
      if (responses.has(parsed.op)) return;
      let body = null;
      let parseErr = null;
      try {
        const text = await resp.text();
        try { body = text ? JSON.parse(text) : null; }
        catch (e) { body = text; parseErr = e.message; }
      } catch (e) {
        parseErr = e.message;
      }
      const captured = {
        op: parsed.op,
        queryId: parsed.queryId,
        url,
        status: resp.status(),
        ok: resp.ok(),
        rateLimit: {
          limit: resp.headers()['x-rate-limit-limit'] || null,
          remaining: resp.headers()['x-rate-limit-remaining'] || null,
          reset: resp.headers()['x-rate-limit-reset'] || null
        },
        body,
        parseError: parseErr,
        capturedAt: Date.now()
      };
      responses.set(parsed.op, captured);
      const waiters = responseWaiters.get(parsed.op) || [];
      responseWaiters.delete(parsed.op);
      for (const w of waiters) w(captured);
    } catch (_) {
      // Swallow; never let response listener crash the run.
    }
  });

  return {
    context,
    page,
    cdp,
    getTemplate: (op) => templates.get(op) || null,
    getResponse: (op) => responses.get(op) || null,
    listCapturedOps: () => Array.from(templates.keys()),
    listCapturedResponses: () => Array.from(responses.keys()),
    // Wait for the first organic response for `op`. Returns the captured
    // entry or null on timeout. Resolves immediately if already captured.
    async waitForResponse(op, { timeoutMs = 30000 } = {}) {
      const existing = responses.get(op);
      if (existing) return existing;
      return await new Promise(resolve => {
        const arr = responseWaiters.get(op) || [];
        const timer = setTimeout(() => {
          const filtered = (responseWaiters.get(op) || []).filter(f => f !== handler);
          if (filtered.length) responseWaiters.set(op, filtered); else responseWaiters.delete(op);
          resolve(null);
        }, timeoutMs);
        const handler = (entry) => { clearTimeout(timer); resolve(entry); };
        arr.push(handler);
        responseWaiters.set(op, arr);
      });
    },
    async close() {
      try { await context.close(); } finally { releasePidfile(); }
    }
  };
}

// Wait until the named operation's TEMPLATE has been captured at least once.
// (Distinct from waitForResponse, which waits for the body.)
export async function waitForTemplate(ctx, opName, { timeoutMs = 30000, probeEveryMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = ctx.getTemplate(opName);
    if (t) return t;
    await new Promise(r => setTimeout(r, probeEveryMs));
  }
  return null;
}

// Wait for an authenticated GraphQL response from any auth-shaped op. Used
// by login as the session-ready signal.
//
// Auth-ready definition:
//   - An expected op fires (Viewer / AccountSettings / HomeTimeline /
//     HomeLatestTimeline / NotificationsTimeline)
//   - Status is 2xx
//   - The captured TEMPLATE has BOTH `authorization` and `x-csrf-token`
//     headers (Codex round-1: bearer alone is not sufficient evidence of
//     a working CSRF state for replay)
export async function waitForAuthSignal(ctx, { timeoutMs = 15 * 60 * 1000, probeEveryMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const candidates = ['Viewer', 'AccountSettings', 'HomeTimeline', 'HomeLatestTimeline', 'NotificationsTimeline'];
  while (Date.now() < deadline) {
    for (const op of candidates) {
      const tpl = ctx.getTemplate(op);
      const resp = ctx.getResponse(op);
      if (!tpl || !resp) continue;
      const hdrs = tpl.headers || {};
      const hasAuth = !!(hdrs.authorization || hdrs.Authorization);
      const hasCsrf = !!(hdrs['x-csrf-token'] || hdrs['X-Csrf-Token'] || hdrs['X-CSRF-Token']);
      if (hasAuth && hasCsrf && resp.ok) return { op, template: tpl, response: resp };
    }
    await new Promise(r => setTimeout(r, probeEveryMs));
  }
  return null;
}

// Replay a captured GraphQL request from inside the x.com page context.
// v1 verbs DO NOT use this path; they parse the organic response captured
// by waitForResponse. pageApi is kept for v2 (cursor pagination, etc).
//
// Method MUST be GET. Op name MUST be in ALLOWED_OPS. URL host MUST be
// x.com or twitter.com and path MUST be /i/api/graphql/<queryId>/<opName>.
export async function pageApi(page, opName, template, { variables = null } = {}) {
  if (!template) {
    throw new Error(`pageApi: no template for op "${opName}". Run session warm-up first.`);
  }
  if (!ALLOWED_OPS.has(opName)) {
    throw Object.assign(new Error(`E_OP_NOT_ALLOWED: op "${opName}" is not in the read-only allowlist`), { code: 'E_OP_NOT_ALLOWED' });
  }
  if (template.method !== 'GET') {
    throw Object.assign(new Error(`E_METHOD_NOT_ALLOWED: op "${opName}" was captured as ${template.method}, only GET is allowed`), { code: 'E_METHOD_NOT_ALLOWED' });
  }
  let urlObj;
  try { urlObj = new URL(template.url); } catch { throw new Error(`pageApi: malformed template URL`); }
  const okHost = urlObj.hostname === 'x.com' || urlObj.hostname === 'twitter.com';
  const okPath = new RegExp(`^/i/api/graphql/[^/]+/${opName}$`).test(urlObj.pathname);
  if (!okHost || !okPath) {
    throw new Error(`pageApi: template URL ${template.url} does not match expected /i/api/graphql/<queryId>/${opName} on x.com/twitter.com`);
  }

  if (variables) {
    let captured = {};
    try { captured = JSON.parse(urlObj.searchParams.get('variables') || '{}'); } catch (_) {}
    const merged = { ...captured, ...variables };
    urlObj.searchParams.set('variables', JSON.stringify(merged));
  }
  const replayUrl = urlObj.toString();

  // Filter to app-level headers we're allowed to set via fetch(). Browser
  // forbids setting cookie/host/origin/referer/sec-* etc. on cross-origin
  // fetch (well, x.com fetch from x.com is same-origin; even so, browser
  // overrides these). credentials:'include' brings cookies. We keep only
  // the X-specific decoration we actually need.
  const KEEP = new Set([
    'authorization',
    'x-csrf-token',
    'x-twitter-auth-type',
    'x-twitter-active-user',
    'x-twitter-client-language',
    'x-client-transaction-id',
    'x-client-uuid',
    'accept'
  ]);
  const headers = {};
  for (const [k, v] of Object.entries(template.headers || {})) {
    if (KEEP.has(k.toLowerCase())) headers[k] = v;
  }

  return await page.evaluate(async ({ replayUrl, headers }) => {
    const r = await fetch(replayUrl, { method: 'GET', credentials: 'include', headers });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    const rl = {
      limit: r.headers.get('x-rate-limit-limit'),
      remaining: r.headers.get('x-rate-limit-remaining'),
      reset: r.headers.get('x-rate-limit-reset')
    };
    return { status: r.status, ok: r.ok, body: json, rateLimit: rl };
  }, { replayUrl, headers });
}

// Convert X's Unix-epoch x-rate-limit-reset to seconds-from-now (uncapped).
// Per docs: x-rate-limit-reset is seconds since epoch, NOT a relative wait.
// Source: https://docs.x.com/resources/fundamentals/rate-limits
export function rateLimitResetSeconds(resetHeader) {
  if (!resetHeader) return 0;
  const reset = parseInt(resetHeader, 10);
  if (!Number.isFinite(reset)) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.max(0, reset - nowSec);
}

// What we'd actually sleep — capped at 5 minutes regardless of header.
export function rateLimitSleepMs(resetHeader) {
  return Math.min(rateLimitResetSeconds(resetHeader), 300) * 1000;
}

// URL-based challenge detection.
export function isAuthChallengeUrl(url) {
  if (!url) return false;
  return /\/i\/flow\/(login|account_access)/.test(url)
    || /\/account\/access(_revoked)?/.test(url)
    || /\/account\/locked/.test(url);
}

// DOM-based challenge detection. Run after warm-up nav settles. Returns a
// short string label if a challenge is on screen, else null. Best-effort —
// any locator failure returns null (not a challenge).
export async function detectDomChallenge(page) {
  const probes = [
    { sel: 'iframe[src*="arkoselabs"]', label: 'arkose-iframe' },
    { sel: 'iframe[src*="funcaptcha"]', label: 'funcaptcha-iframe' },
    { sel: '[data-testid="LoginForm_Login_Button"]', label: 'login-form' },
    { sel: '[data-testid="ocfEnterTextTextInput"]', label: 'ocf-text-challenge' },
    { sel: '[data-testid="confirmation_sheet_confirm"]', label: 'confirmation-sheet' }
  ];
  for (const p of probes) {
    try {
      const count = await page.locator(p.sel).count();
      if (count > 0) return p.label;
    } catch (_) { /* ignore */ }
  }
  return null;
}

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
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// Profile dir, pidfile, and breaker file are runtime-evaluated so the
// --profile <name> flag (resolved into X_READ_PROFILE_DIR by run.mjs)
// takes effect on every call. Don't bake at module-load — that breaks
// multi-account support.
export function getProfileDir() {
  return process.env.X_READ_PROFILE_DIR || `${process.env.HOME}/.quantum/chrome-profiles/x`;
}
function getPidfile() { return join(getProfileDir(), '.skill.pid'); }
function getBreakerFile() { return join(getProfileDir(), '.breaker.json'); }

// Allowlist of GraphQL op names we'll touch via replay (pageApi). Any op
// outside this set is rejected to keep the read-only contract auditable.
// v1 verbs use organic-response capture instead of pageApi, so this list
// only matters for v2 cursor pagination work. Read-only ops only.
const ALLOWED_OPS = new Set([
  'TweetDetail',
  'UserByScreenName',
  'UserTweets',
  'Bookmarks',
  'accountOverviewQuery',
  'SearchTimeline',
  'HomeTimeline',
  'UsersByRestIds'
]);

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function acquirePidfile() {
  const pidfile = getPidfile();
  // Atomic acquire: O_EXCL fails if the file exists. No TOCTOU race vs a
  // concurrent run on the same profile.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(pidfile, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      process.on('exit', releasePidfile);
      process.on('SIGINT', () => { releasePidfile(); process.exit(130); });
      process.on('SIGTERM', () => { releasePidfile(); process.exit(143); });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Stale-pidfile recovery: read the existing pid; if dead, clear it
      // and retry once.
      const old = parseInt(readFileSync(pidfile, 'utf8').trim(), 10);
      if (old && isAlive(old)) {
        throw new Error(`Profile locked by pid ${old}. Wait or kill it.`);
      }
      try { unlinkSync(pidfile); } catch (_) {}
    }
  }
  throw new Error(`Could not acquire pidfile ${pidfile} after stale cleanup`);
}

function releasePidfile() {
  try {
    const pidfile = getPidfile();
    if (existsSync(pidfile) && readFileSync(pidfile, 'utf8').trim() === String(process.pid)) {
      unlinkSync(pidfile);
    }
  } catch (_) {}
}

export function readBreaker() {
  const f = getBreakerFile();
  if (!existsSync(f)) return { state: 'healthy', flagged_at: null, events: [] };
  try { return JSON.parse(readFileSync(f, 'utf8')); }
  catch (_) { return { state: 'healthy', flagged_at: null, events: [] }; }
}

export function writeBreaker(next) {
  writeFileSync(getBreakerFile(), JSON.stringify(next, null, 2));
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

  const profileDir = getProfileDir();
  await mkdir(profileDir, { recursive: true });
  try { await chmod(profileDir, 0o700); } catch (_) {}
  acquirePidfile();

  // Wrap entire setup in a single try/catch so any throw between
  // launchPersistentContext and CDP wiring releases the pidfile and tears
  // down a partially-constructed context. Round 2 finding IMP-13.
  let context, page, cdp;
  try {
    const windowArgs = visible
      ? []
      : ['--window-position=-2400,-2400', '--window-size=1440,900'];

    context = await chromium.launchPersistentContext(profileDir, {
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

  try {
    cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
  } catch (e) {
    try { await context.close(); } catch (_) {}
    releasePidfile();
    throw e;
  }
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

  // Response capture. Synchronously claim the per-op slot, then dispatch
  // body-fetch as a fire-and-forget IIFE so the listener returns instantly.
  // Awaiting text() inside the listener serializes same-page responses
  // (Playwright runs response handlers sequentially per page), which
  // gates concurrent ops like UserTweets behind UserByScreenName.
  // Globally trips the breaker on 401/403 from any captured op so a
  // side-op failure halts the run before we burn more requests.
  page.on('response', (resp) => {
    const url = resp.url();
    if (!isXGraphqlUrl(url)) return;
    const parsed = parseOpFromUrl(url);
    if (!parsed) return;
    const status = resp.status();
    if (status === 401 || status === 403) {
      tripBreaker(`background-response-${status}:${parsed.op}`);
    }
    if (responses.has(parsed.op)) return;
    responses.set(parsed.op, { op: parsed.op, queryId: parsed.queryId, url, status, ok: resp.ok(), pending: true });
    (async () => {
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
        status,
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
    })().catch(() => { /* never let the body fetch crash the run */ });
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
    // entry or null on timeout. Resolves immediately if already captured
    // (skips placeholder entries that are still awaiting body parse).
    async waitForResponse(op, { timeoutMs = 30000 } = {}) {
      const existing = responses.get(op);
      if (existing && !existing.pending) return existing;
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

// Wait for an authenticated session signal. Two parallel strategies:
//   (a) auth_token cookie appears in the context (the deterministic signal -
//       X sets this cookie the moment login completes, regardless of which
//       GraphQL op fires next).
//   (b) An auth-shaped GraphQL response is captured with bearer + csrf
//       headers and 2xx status (a stronger signal that the session also
//       supports replay; useful but slower and op-name-fragile).
// Either strategy resolving wins. Login flow uses this as the "you're in"
// signal. onProgress is called every probe so callers can heartbeat.
export async function waitForAuthSignal(ctx, { timeoutMs = 15 * 60 * 1000, probeEveryMs = 1000, onProgress = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  const candidates = ['Viewer', 'AccountSettings', 'HomeTimeline', 'HomeLatestTimeline', 'NotificationsTimeline'];
  let lastProgress = 0;
  while (Date.now() < deadline) {
    // Strategy A: cookie-based.
    try {
      const cookies = await ctx.context.cookies();
      const authTok = cookies.find(c => c.name === 'auth_token' && /(\.|^)x\.com|twitter\.com/.test(c.domain));
      const ct0 = cookies.find(c => c.name === 'ct0' && /(\.|^)x\.com|twitter\.com/.test(c.domain));
      if (authTok && ct0) {
        return { kind: 'cookie', authToken: 'present', ct0: 'present' };
      }
    } catch (_) { /* cookie read can race during navigation; ignore */ }

    // Strategy B: captured GraphQL response.
    for (const op of candidates) {
      const tpl = ctx.getTemplate(op);
      const resp = ctx.getResponse(op);
      if (!tpl || !resp) continue;
      const hdrs = tpl.headers || {};
      const hasAuth = !!(hdrs.authorization || hdrs.Authorization);
      const hasCsrf = !!(hdrs['x-csrf-token'] || hdrs['X-Csrf-Token'] || hdrs['X-CSRF-Token']);
      if (hasAuth && hasCsrf && resp.ok) return { kind: 'graphql', op, template: tpl, response: resp };
    }

    if (onProgress && Date.now() - lastProgress > 30000) {
      try { onProgress({ elapsedMs: Date.now() - (deadline - timeoutMs), pageUrl: ctx.page.url() }); } catch (_) {}
      lastProgress = Date.now();
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

  const result = await page.evaluate(async ({ replayUrl, headers }) => {
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
  // Round 2 finding CRIT-2: pageApi must enforce single-strike breaker on
  // auth failures so v2 callers can't accidentally hammer an expired session.
  if (result.status === 401 || result.status === 403) {
    tripBreaker(`pageApi-${result.status}:${opName}`);
  }
  return result;
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

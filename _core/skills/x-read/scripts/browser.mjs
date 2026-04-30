// browser.mjs -- patchright launcher + CDP capture of FULL X GraphQL request
// templates. Used by login (visible) and runtime verbs (off-screen).
//
// Auth strategy: we never construct request headers ourselves. We attach a CDP
// Network listener BEFORE navigating to x.com. For every request to
// /i/api/graphql/<queryId>/<OperationName>, we record the method, URL, full
// header bag, and post body. After the page settles we have a live "template
// map" keyed by OperationName. To run our own auth'd call we look up the
// captured template, swap in our variables, and replay the request via
// page.evaluate(fetch) from inside the x.com origin so the browser signs it
// with the same Client Hints / cookies the page already uses.
//
// Differences from the discord skill:
//   - X needs many more decorated headers (x-client-transaction-id,
//     x-twitter-auth-type, x-twitter-active-user, x-twitter-client-language,
//     bearer, csrf, sec-ch-*) so we capture and replay full templates instead
//     of just one Authorization header.
//   - No storage-state snapshot/restore. Discord's pattern resurrects stale
//     ct0 cookies on X and breaks CSRF. We let Chrome's own cookie store own
//     persistence.
//   - GET-only at the helper layer. pageApi rejects any other method.
//   - Single-strike breaker (Adithya's account is X Premium; fail closed).

import { chromium } from 'patchright';
import { chmod, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE_DIR = process.env.X_READ_PROFILE_DIR || `${process.env.HOME}/.quantum/chrome-profiles/x`;
const PIDFILE = join(PROFILE_DIR, '.skill.pid');
const BREAKER_FILE = join(PROFILE_DIR, '.breaker.json');

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

// Single strike halts. Adithya's main is Premium; one captcha/checkpoint
// already represents account-risk we don't want to compound.
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

  // Open a fresh page rather than reusing the about:blank tab; init scripts
  // and cookie state apply more reliably to new pages (Playwright #28692).
  const page = await context.newPage();
  for (const p of context.pages()) {
    if (p !== page && p.url() === 'about:blank') {
      try { await p.close(); } catch (_) {}
    }
  }

  // Template map keyed by OperationName. Updated every time the X client
  // emits a /i/api/graphql/* request. Last-write-wins per op.
  const templates = new Map();

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (e) => {
    try {
      const req = e?.request;
      if (!req) return;
      const url = req.url || '';
      // Match both x.com and twitter.com; X migrated but old paths persist in
      // some flows.
      if (!/https?:\/\/(x|twitter)\.com\/i\/api\/graphql\//.test(url)) return;
      // /i/api/graphql/<queryId>/<OperationName>?<query>
      const m = url.match(/\/i\/api\/graphql\/([^\/]+)\/([^?]+)/);
      if (!m) return;
      const queryId = m[1];
      const operationName = m[2];
      templates.set(operationName, {
        method: req.method,
        url,
        queryId,
        headers: { ...req.headers },
        postData: req.postData ?? null,
        capturedAt: Date.now()
      });
    } catch (_) {}
  });

  return {
    context,
    page,
    cdp,
    getTemplate: (op) => templates.get(op) || null,
    listCapturedOps: () => Array.from(templates.keys()),
    async close() {
      try { await context.close(); } finally { releasePidfile(); }
    }
  };
}

// Wait until the named operation has been captured at least once.
export async function waitForTemplate(ctx, opName, { timeoutMs = 30000, probeEveryMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = ctx.getTemplate(opName);
    if (t) return t;
    await new Promise(r => setTimeout(r, probeEveryMs));
  }
  return null;
}

// Wait until any auth-shaped GraphQL request has been captured. Used by the
// login flow as a session-ready signal.
export async function waitForAuthSignal(ctx, { timeoutMs = 15 * 60 * 1000, probeEveryMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // X may emit Viewer, AccountSettings, HomeTimeline, or NotificationsTimeline
  // depending on the route. Any of them with an authorization header counts.
  const candidates = ['Viewer', 'AccountSettings', 'HomeTimeline', 'HomeLatestTimeline', 'NotificationsTimeline'];
  while (Date.now() < deadline) {
    for (const op of candidates) {
      const t = ctx.getTemplate(op);
      if (t && (t.headers.authorization || t.headers.Authorization)) return t;
    }
    await new Promise(r => setTimeout(r, probeEveryMs));
  }
  return null;
}

// Replay a captured GraphQL request from inside the x.com page context. We
// deep-merge new variables into the captured ones, preserving features and
// fieldToggles exactly as the page sent them.
//
// method MUST be 'GET'. Anything else is rejected at this layer to enforce
// the read-only contract documented in rules/read-only.md.
export async function pageApi(page, opName, template, { variables = null } = {}) {
  if (!template) {
    throw new Error(`pageApi: no template for op "${opName}". Run session warm-up first.`);
  }
  if (template.method !== 'GET') {
    // The captured template's method is whatever X emitted. Most read ops are
    // GET; some are POST. We refuse non-GET to keep the skill read-only even
    // if X someday switches a read op to POST. Caller must explicitly handle.
    throw Object.assign(new Error(`E_METHOD_NOT_ALLOWED: op "${opName}" was captured as ${template.method}, only GET is allowed`), { code: 'E_METHOD_NOT_ALLOWED' });
  }

  // Build replay URL. Captured URL has variables/features/fieldToggles in the
  // querystring for GET ops. We parse, merge variables, leave the rest alone.
  const u = new URL(template.url);
  if (variables) {
    let captured = {};
    try { captured = JSON.parse(u.searchParams.get('variables') || '{}'); } catch (_) {}
    const merged = { ...captured, ...variables };
    u.searchParams.set('variables', JSON.stringify(merged));
  }
  const replayUrl = u.toString();

  // Headers we replay: drop browser-managed pseudo-headers (CDP sometimes
  // surfaces these and the fetch API rejects them). Keep everything else
  // including bearer, csrf, x-client-transaction-id, x-twitter-* decorations.
  const banned = new Set([':method', ':path', ':scheme', ':authority', 'host', 'content-length', 'connection']);
  const headers = {};
  for (const [k, v] of Object.entries(template.headers)) {
    const lk = k.toLowerCase();
    if (banned.has(lk)) continue;
    headers[k] = v;
  }

  return await page.evaluate(async ({ replayUrl, headers }) => {
    const r = await fetch(replayUrl, { method: 'GET', credentials: 'include', headers });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    // Surface x-rate-limit-* headers so caller can react if X exposes them.
    const rl = {
      limit: r.headers.get('x-rate-limit-limit'),
      remaining: r.headers.get('x-rate-limit-remaining'),
      reset: r.headers.get('x-rate-limit-reset')
    };
    return { status: r.status, ok: r.ok, body: json, rateLimit: rl };
  }, { replayUrl, headers });
}

// Convert X's Unix-epoch x-rate-limit-reset to a clamped sleep in ms.
// Per docs: x-rate-limit-reset is seconds since epoch, NOT a relative wait.
// We convert and cap at 5 minutes to avoid pathological waits.
export function rateLimitSleepMs(resetHeader) {
  if (!resetHeader) return 0;
  const reset = parseInt(resetHeader, 10);
  if (!Number.isFinite(reset)) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const wait = Math.max(0, reset - nowSec);
  return Math.min(wait, 300) * 1000;
}

// Detect login/checkpoint URL patterns. Used by login flow + runtime probes.
export function isAuthChallengeUrl(url) {
  if (!url) return false;
  return /\/i\/flow\/(login|account_access)/.test(url)
    || /\/account\/access(_revoked)?/.test(url)
    || /\/account\/locked/.test(url);
}

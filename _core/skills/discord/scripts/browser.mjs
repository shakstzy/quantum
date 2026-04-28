// browser.mjs -- patchright persistent-context launcher.
// Used by BOTH login (visible) and runtime verbs (off-screen). Auth comes
// from cookies in the profile dir + a CDP Network listener that captures the
// Authorization header from outgoing requests on the wire (sees Service
// Worker traffic, unlike window-level fetch monkeypatch).

import { chromium } from 'patchright';
import { chmod, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE_DIR = process.env.DISCORD_PROFILE_DIR || `${process.env.HOME}/.quantum/chrome-profiles/discord`;
const PIDFILE = join(PROFILE_DIR, '.skill.pid');
const BREAKER_FILE = join(PROFILE_DIR, '.breaker.json');
const STORAGE_STATE = join(PROFILE_DIR, '.storage-state.json');

export function getProfileDir() { return PROFILE_DIR; }
export function getStorageStatePath() { return STORAGE_STATE; }

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
  if (!existsSync(BREAKER_FILE)) return { state: 'healthy', flagged_at: null, count_24h: 0, events: [] };
  try { return JSON.parse(readFileSync(BREAKER_FILE, 'utf8')); }
  catch (_) { return { state: 'healthy', flagged_at: null, count_24h: 0, events: [] }; }
}

export function writeBreaker(next) {
  writeFileSync(BREAKER_FILE, JSON.stringify(next, null, 2));
}

export function tripBreaker() {
  const now = Date.now();
  const b = readBreaker();
  const events = (b.events || []).filter(t => now - t < 24 * 3600 * 1000);
  events.push(now);
  const next = {
    state: events.length >= 2 ? 'halted' : 'flagged',
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

// Restore cookies that launchPersistentContext drops (Playwright bug #36139).
// Session cookies (no Expires/Max-Age) are not reliably persisted across
// runs even when userDataDir is set. We snapshot context.storageState() at
// close time and re-inject on next launch.
async function restoreStorageState(context) {
  if (!existsSync(STORAGE_STATE)) return;
  try {
    const state = JSON.parse(readFileSync(STORAGE_STATE, 'utf8'));
    if (state.cookies && state.cookies.length) {
      await context.addCookies(state.cookies);
    }
  } catch (e) {
    process.stderr.write(`[discord] warning: could not restore storage state: ${e.message}\n`);
  }
}

async function snapshotStorageState(context) {
  try {
    const state = await context.storageState();
    writeFileSync(STORAGE_STATE, JSON.stringify(state, null, 2));
  } catch (e) {
    process.stderr.write(`[discord] warning: could not snapshot storage state: ${e.message}\n`);
  }
}

// visible=true for login (user needs to see it); false for runtime (off-screen).
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

  await restoreStorageState(context);

  // Open a FRESH page rather than reusing the restored about:blank tab; init
  // scripts and cookie state apply more reliably to new pages
  // (Playwright #28692).
  const page = await context.newPage();
  // Close the about:blank tab patchright opens by default to keep the
  // surface to one tab.
  for (const p of context.pages()) {
    if (p !== page && p.url() === 'about:blank') {
      try { await p.close(); } catch (_) {}
    }
  }

  // CDP listener for Authorization header capture. Network.requestWillBeSent
  // fires for every request the browser actually emits, including those
  // initiated by the Service Worker. This is the durable replacement for the
  // old window.fetch monkeypatch.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  let capturedToken = null;
  let lastCaptureAt = 0;
  cdp.on('Network.requestWillBeSent', (e) => {
    try {
      const url = e?.request?.url || '';
      if (url.indexOf('discord.com/api/') === -1) return;
      const headers = e.request.headers || {};
      const auth = headers.Authorization || headers.authorization;
      if (auth && typeof auth === 'string' && auth.length > 20) {
        capturedToken = auth;
        lastCaptureAt = Date.now();
      }
    } catch (_) {}
  });

  return {
    context,
    page,
    cdp,
    getCapturedToken: () => capturedToken,
    getLastCaptureAt: () => lastCaptureAt,
    async close() {
      try { await snapshotStorageState(context); } catch (_) {}
      try { await context.close(); } finally { releasePidfile(); }
    }
  };
}

// Wait until the CDP listener captures an Authorization header bound for
// discord.com/api/*. Returns the token or null on timeout.
export async function waitForCapturedToken(ctx, { timeoutMs = 60 * 1000, probeEveryMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tok = ctx.getCapturedToken();
    if (tok) return tok;
    await new Promise(r => setTimeout(r, probeEveryMs));
  }
  return null;
}

// Wait until signed in. Captures token via CDP, then verifies with /users/@me.
export async function waitForSignedIn(ctx, { timeoutMs = 15 * 60 * 1000, probeEveryMs = 2000 } = {}) {
  const tok = await waitForCapturedToken(ctx, { timeoutMs, probeEveryMs });
  if (!tok) throw new Error('waitForSignedIn: no Authorization header captured within timeout');
  const res = await pageApi(ctx.page, 'GET', '/api/v9/users/@me', { token: tok });
  if (!res.ok) throw new Error(`waitForSignedIn: /users/@me returned ${res.status}`);
  return res.body;
}

// Executes a Discord REST call from inside the page context, supplying the
// Authorization header captured by CDP. Request originates from real Chrome
// on discord.com: real TLS/JA3, real Client Hints, real origin.
export async function pageApi(page, method, path, { body, query, token } = {}) {
  return await page.evaluate(async ({ method, path, body, query, hasBody, token }) => {
    if (!token) return { status: 0, ok: false, body: { code: 'NO_TOKEN', message: 'Authorization header not captured yet; Discord client has not made a request' } };
    let url = path;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    const headers = { 'Authorization': token };
    if (hasBody) headers['Content-Type'] = 'application/json';
    const init = { method, credentials: 'include', headers };
    if (hasBody) init.body = JSON.stringify(body);
    const r = await fetch(url, init);
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, ok: r.ok, body: json };
  }, { method, path, body, query, hasBody: body !== undefined, token });
}

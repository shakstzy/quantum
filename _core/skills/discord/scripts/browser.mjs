// browser.mjs -- patchright persistent-context launcher.
// Used by BOTH login (visible) and runtime verbs (off-screen). Cookies in the
// profile dir authenticate every navigation. Authorization header is captured
// at page level via init script when Discord's own client makes API calls.

import { chromium } from 'patchright';
import { chmod, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE_DIR = process.env.DISCORD_PROFILE_DIR || `${process.env.HOME}/.quantum/chrome-profiles/discord`;
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

  await context.addInitScript(() => {
    try {
      const origFetch = window.fetch;
      window.fetch = function(...args) {
        try {
          const req = new Request(args[0], args[1]);
          const auth = req.headers && req.headers.get && req.headers.get('authorization');
          if (auth && auth.length > 20 && req.url && req.url.indexOf('discord.com/api/') !== -1) {
            window.__quantumDiscordToken = auth;
          }
        } catch (_) {}
        return origFetch.apply(this, args);
      };
      const origSet = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        try {
          if (typeof name === 'string' && name.toLowerCase() === 'authorization' && typeof value === 'string' && value.length > 20) {
            window.__quantumDiscordToken = value;
          }
        } catch (_) {}
        return origSet.apply(this, arguments);
      };
    } catch (_) {}
  });

  const page = context.pages()[0] || await context.newPage();

  return {
    context,
    page,
    async close() {
      try { await context.close(); } finally { releasePidfile(); }
    }
  };
}

// Poll window.__quantumDiscordToken (set by the init script when Discord's own
// client makes an authenticated API call). Returns the captured token string,
// or null on timeout.
export async function waitForCapturedToken(page, { timeoutMs = 15 * 60 * 1000, probeEveryMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tok = await page.evaluate(() => window.__quantumDiscordToken || null).catch(() => null);
    if (tok && typeof tok === 'string' && tok.length > 20) return tok;
    await new Promise(r => setTimeout(r, probeEveryMs));
  }
  return null;
}

// Wait until the current page's Discord session is signed in. Returns /users/@me
// body on success, throws on timeout. Relies on the init-script token capture.
export async function waitForSignedIn(page, { timeoutMs = 15 * 60 * 1000, probeEveryMs = 2000 } = {}) {
  const tok = await waitForCapturedToken(page, { timeoutMs, probeEveryMs });
  if (!tok) throw new Error('waitForSignedIn: no Authorization header captured within timeout');
  const res = await pageApi(page, 'GET', '/api/v9/users/@me');
  if (!res.ok) throw new Error(`waitForSignedIn: /users/@me returned ${res.status}`);
  return res.body;
}

// Executes a Discord REST call from inside the page context, reusing the
// Authorization header captured from Discord's own client. Request originates
// from real Chrome on discord.com: real TLS/JA3, real Client Hints, real origin.
export async function pageApi(page, method, path, { body, query } = {}) {
  return await page.evaluate(async ({ method, path, body, query, hasBody }) => {
    const token = window.__quantumDiscordToken;
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
  }, { method, path, body, query, hasBody: body !== undefined });
}

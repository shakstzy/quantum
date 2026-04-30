// browser.mjs -- patchright persistent-context launcher for chatgpt.com.
// Mirrors the discord skill: persistent profile dir holds session cookies,
// pidfile prevents concurrent runs on same profile, breaker halts after
// repeated bot-detection signals.

import { chromium } from 'patchright';
import { chmod, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE_DIR = process.env.GPT_IMAGES_PROFILE_DIR
  || `${process.env.HOME}/.quantum/chrome-profiles/chatgpt`;
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

export function tripBreaker(reason = 'unknown') {
  const now = Date.now();
  const b = readBreaker();
  const events = (b.events || []).filter(e => now - (e.t || e) < 24 * 3600 * 1000);
  events.push({ t: now, reason });
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

async function restoreStorageState(context) {
  if (!existsSync(STORAGE_STATE)) return;
  try {
    const state = JSON.parse(readFileSync(STORAGE_STATE, 'utf8'));
    if (state.cookies && state.cookies.length) {
      await context.addCookies(state.cookies);
    }
  } catch (e) {
    process.stderr.write(`[gpt-images] warning: could not restore storage state: ${e.message}\n`);
  }
}

async function snapshotStorageState(context) {
  try {
    const state = await context.storageState();
    writeFileSync(STORAGE_STATE, JSON.stringify(state, null, 2));
  } catch (e) {
    process.stderr.write(`[gpt-images] warning: could not snapshot storage state: ${e.message}\n`);
  }
}

// visible=true for login (user needs to see it).
// visible=false runs Chrome off-screen so it does not steal focus, but is NOT
// headless — chatgpt.com aggressively flags headless traffic.
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

  const page = await context.newPage();
  for (const p of context.pages()) {
    if (p !== page && p.url() === 'about:blank') {
      try { await p.close(); } catch (_) {}
    }
  }

  return {
    context,
    page,
    async close() {
      try { await snapshotStorageState(context); } catch (_) {}
      try { await context.close(); } finally { releasePidfile(); }
    }
  };
}

// Probe /api/auth/session to confirm logged-in user. Returns {email,user,...}
// on success; null if logged out or session invalid.
export async function probeSession(page) {
  try {
    const res = await page.evaluate(async () => {
      const r = await fetch('https://chatgpt.com/api/auth/session', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      const text = await r.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: r.status, ok: r.ok, body };
    });
    if (!res.ok) return null;
    if (!res.body || !res.body.user) return null;
    return res.body;
  } catch (_) {
    return null;
  }
}

// Wait until probeSession returns a valid user object.
export async function waitForSignedIn(ctx, { timeoutMs = 15 * 60 * 1000, probeEveryMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sess = await probeSession(ctx.page);
    if (sess && sess.user) return sess;
    await new Promise(r => setTimeout(r, probeEveryMs));
  }
  throw new Error('waitForSignedIn: timed out waiting for valid /api/auth/session');
}

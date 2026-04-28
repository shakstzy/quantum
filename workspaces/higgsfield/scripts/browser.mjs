// browser.mjs -- patchright persistent-context launcher with stealth init scripts
// Exposes a single `launchContext()` that returns { context, page, close }.

import { chromium } from 'patchright';
import { buildInitScript } from './fingerprint.mjs';
import { attachJwtCapture } from './jwt.mjs';
import { chmod, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE_DIR = process.env.HF_PROFILE_DIR || `${process.env.HOME}/.quantum/chrome-profiles/higgsfield`;
const PIDFILE = join(PROFILE_DIR, '.skill.pid');
const BREAKER_FILE = join(PROFILE_DIR, '.breaker.json');

function seededInt() {
  // New integer seed per session; persisted for one session only
  return Math.floor(Math.random() * 0x7fffffff);
}

export function getProfileDir() { return PROFILE_DIR; }

function acquirePidfile() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  // Atomic create (O_EXCL). Two simultaneous launches: only one wins.
  let fd;
  try {
    fd = openSync(PIDFILE, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Existing pidfile: alive -> refuse; dead -> reclaim atomically by unlink+retry.
    const old = parseInt(readFileSync(PIDFILE, 'utf8').trim(), 10);
    if (old && isAlive(old)) {
      throw new Error(`Profile locked by pid ${old}. Wait for it to finish or kill it.`);
    }
    try { unlinkSync(PIDFILE); } catch (_) {}
    fd = openSync(PIDFILE, 'wx'); // if this races and EEXISTs, surface it
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  process.on('exit', releasePidfile);
  process.on('SIGINT', () => { releasePidfile(); process.exit(130); });
  process.on('SIGTERM', () => { releasePidfile(); process.exit(143); });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function releasePidfile() {
  try {
    if (existsSync(PIDFILE) && readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) {
      unlinkSync(PIDFILE);
    }
  } catch (_) {}
}

export function readBreaker() {
  if (!existsSync(BREAKER_FILE)) return { state: 'healthy', flagged_at: null, count_24h: 0 };
  try { return JSON.parse(readFileSync(BREAKER_FILE, 'utf8')); }
  catch (_) { return { state: 'healthy', flagged_at: null, count_24h: 0 }; }
}

export function writeBreaker(next) {
  writeFileSync(BREAKER_FILE, JSON.stringify(next, null, 2));
}

export function trigger403Breaker() {
  const now = Date.now();
  const b = readBreaker();
  // Clean out events older than 24h
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
    // Cooldown elapsed; reset breaker
    writeBreaker({ state: 'healthy', flagged_at: null, count_24h: 0, events: [] });
  }
  return { ok: true, forced: false };
}

export async function launchContext({ force = false, headless = false } = {}) {
  const check = breakerAllowsLaunch(force);
  if (!check.ok) {
    const err = new Error(`Circuit breaker HALT active since ${check.breaker.flagged_at}. 24h cooldown. Override with --force (strongly discouraged) or solve captcha on higgsfield.ai from your normal browser and then --reset-breaker.`);
    err.code = 'BREAKER_HALTED';
    throw err;
  }

  await mkdir(PROFILE_DIR, { recursive: true });
  try { await chmod(PROFILE_DIR, 0o700); } catch (_) {}
  acquirePidfile();

  const proxy = process.env.HF_PROXY ? parseProxy(process.env.HF_PROXY) : undefined;
  if (proxy && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(proxy.server || '')) {
    // Best-effort sanity: most datacenter proxies resolve to non-RFC1918, so this isn't a strong check.
    // We still let it through. But we refuse obvious VPN providers by name if set.
  }
  if (proxy && /\.(nordvpn|expressvpn|mullvad|surfshark|protonvpn|privateinternetaccess|cyberghost|ipvanish|vyprvpn|torguard)\b/i.test(proxy.server || '')) {
    throw new Error('HF_PROXY points at a consumer VPN domain. DataDome blocks datacenter VPN IPs wholesale; this is worse than no proxy. Use a residential proxy or tether instead.');
  }

  const seed = seededInt();
  const initScript = buildInitScript(seed);
  const stealthOn = process.env.HF_STEALTH !== '0';

  // DataDome needs a real window (headless is flagged), but we can push the
  // window off-screen so it doesn't steal focus or clutter the desktop. Set
  // HF_VISIBLE=1 to override (useful for `login` and debugging). Login code
  // paths should pass visible: true to force this override.
  const forceVisible = process.env.HF_VISIBLE === '1';
  const windowArgs = forceVisible
    ? []
    : ['--window-position=-2400,-2400', '--window-size=1440,900'];

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    proxy,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
      '--restore-last-session=false',
      ...windowArgs
    ]
  });

  if (stealthOn) {
    await context.addInitScript(initScript);
  } else {
    console.log('[higgsfield] stealth init script DISABLED (HF_STEALTH=0)');
  }

  // Trap 403 from fnf.higgsfield.ai globally; on hit, kill the datadome cookie and trip breaker.
  context.on('response', async (resp) => {
    try {
      const u = new URL(resp.url());
      if (u.hostname !== 'fnf.higgsfield.ai' && u.hostname !== 'higgsfield.ai') return;
      if (resp.status() !== 403) return;
      // Delete the datadome cookie immediately. Try both with and without leading-dot domain
      // since Playwright versions differ in how they normalize the stored domain.
      await context.clearCookies({ name: 'datadome' }).catch(() => {});
      const b = trigger403Breaker();
      console.error(`[breaker] 403 detected from ${u.hostname} -> breaker state=${b.state} count_24h=${b.count_24h}`);
    } catch (_) {}
  });

  const page = context.pages()[0] || await context.newPage();
  // Track mouse position (used by bezier helper)
  await page.evaluate(() => {
    window.__lastMouseX = 100;
    window.__lastMouseY = 100;
    window.addEventListener('mousemove', e => { window.__lastMouseX = e.clientX; window.__lastMouseY = e.clientY; });
  });

  // Attach JWT capture listener: intercepts every outgoing request to fnf.higgsfield.ai
  // and pulls out the Bearer token so we can reuse it for our own API calls.
  const jwtCapture = attachJwtCapture(context);

  return {
    context,
    page,
    seed,
    jwtCapture,
    async close() {
      try { await context.close(); } finally { releasePidfile(); }
    }
  };
}

function parseProxy(urlStr) {
  const u = new URL(urlStr);
  return {
    server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined
  };
}

// Detect captcha in the page DOM (used as a circuit-breaker signal)
export async function hasCaptchaInDom(page) {
  try {
    const found = await page.evaluate(() => {
      const sel = [
        'iframe[src*="geo.captcha-delivery.com"]',
        'iframe[src*="captcha-delivery.com"]',
        'iframe[src*="ct.captcha-delivery.com"]',
        'div[class*="datadome"]',
        'body *:has-text("You have been blocked")'
      ];
      return sel.some(s => { try { return !!document.querySelector(s); } catch (_) { return false; } });
    });
    return !!found;
  } catch (_) {
    return false;
  }
}

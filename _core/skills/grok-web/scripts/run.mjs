#!/usr/bin/env node
// run.mjs -- grok-web CLI dispatcher.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..');
const NODE_MODULES = join(SKILL_ROOT, 'node_modules');
const PROFILE_DIR = process.env.GROK_WEB_PROFILE_DIR || `${process.env.HOME}/.quantum/chrome-profiles/grok`;
const DEBUG = process.env.GROK_WEB_DEBUG === '1';

function die(msg, code = 1) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code);
}

function ensureDeps() {
  if (existsSync(join(NODE_MODULES, 'patchright'))) return;
  console.error('[grok-web] First run: installing patchright + Chrome (~300MB, 2-3 minutes).');
  const r = spawnSync('npm', ['install'], { cwd: SKILL_ROOT, stdio: 'inherit' });
  if (r.status !== 0) die('npm install failed');
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
        else { flags[key] = true; }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function login(argv) {
  ensureDeps();
  const { runLogin } = await import('./login.mjs');
  await runLogin({ force: !!argv.flags.force });
}

async function whoami() {
  ensureDeps();
  const { launchContext, probeSession } = await import('./browser.mjs');
  const ctx = await launchContext({ visible: false });
  try {
    await ctx.page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const sess = await probeSession(ctx.page);
    if (!sess) die('[grok-web] not signed in. Run: node scripts/run.mjs login', 3);
    console.log(JSON.stringify({
      ok: true,
      user_id: sess.user_id || null,
      email: sess.email || null,
      name: sess.name || null,
      probe_url: sess._probe_url || null,
      settings_keys: sess.settings && typeof sess.settings === 'object' ? Object.keys(sess.settings) : null
    }, null, 2));
  } finally { await ctx.close(); }
}

async function chat(argv) {
  ensureDeps();
  const prompt = argv.positional.join(' ').trim();
  if (!prompt) die('Usage: chat "<prompt>" [--model <name>] [--mode default|think|deepsearch] [--debug] [--out <dir>] [--timeout <ms>] [--force]');
  const { runChat } = await import('./chat.mjs');
  const timeoutMs = argv.flags.timeout ? parseInt(argv.flags.timeout, 10) : 240000;
  await runChat({
    prompt,
    model: argv.flags.model || null,
    mode: argv.flags.mode || 'default',
    force: !!argv.flags.force,
    debug: !!argv.flags.debug || DEBUG,
    outDir: argv.flags.out || undefined,
    timeoutMs
  });
}

async function quota(argv) {
  ensureDeps();
  const { launchContext, probeSession } = await import('./browser.mjs');
  const ctx = await launchContext({ visible: false });
  try {
    await ctx.page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const sess = await probeSession(ctx.page);
    if (!sess) die('[grok-web] not signed in. Run: node scripts/run.mjs login', 3);
    // Try common quota paths. First diag run will pin the right one.
    const candidates = [
      'https://grok.com/rest/rate-limits',
      'https://grok.com/api/rate-limits',
      'https://grok.com/rest/usage',
      'https://grok.com/api/usage'
    ];
    let raw = null;
    let pickedUrl = null;
    for (const url of candidates) {
      const res = await ctx.page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } });
          const text = await r.text();
          let body = null;
          try { body = text ? JSON.parse(text) : null; } catch { body = text; }
          return { status: r.status, ok: r.ok, body };
        } catch (e) { return { error: e.message }; }
      }, url);
      if (res?.ok && res.body && typeof res.body === 'object') { raw = res.body; pickedUrl = url; break; }
    }
    if (!raw) die('[grok-web] could not locate a rate-limit endpoint. Run diag to discover.', 4);
    const { parseRateLimitJSON } = await import('./quota.mjs');
    const effort = argv.flags.effort || null;
    const parsed = parseRateLimitJSON(raw, { effort });
    console.log(JSON.stringify({ ...parsed, _source_url: pickedUrl }, null, 2));
  } finally { await ctx.close(); }
}

async function diag(argv) {
  ensureDeps();
  const { runDiag } = await import('./diag.mjs');
  await runDiag({ outDir: argv.flags.out || `/tmp/grok-web-diag-${Date.now()}`, prompt: argv.flags.prompt || 'Hello, who are you?', debug: !!argv.flags.debug || DEBUG });
}

async function status() {
  const { readBreaker, getProfileDir } = await import('./browser.mjs');
  const dir = getProfileDir();
  const pidfilePath = join(dir, '.skill.pid');
  const pid = existsSync(pidfilePath) ? parseInt(readFileSync(pidfilePath, 'utf8').trim(), 10) : null;
  const b = readBreaker();
  const cookiesPath = join(dir, 'Default', 'Cookies');
  console.log(JSON.stringify({
    profile_dir: dir,
    active_pid: pid,
    breaker: b,
    cookies_db: existsSync(cookiesPath) ? 'present' : 'missing'
  }, null, 2));
}

async function resetBreaker() {
  const { writeBreaker } = await import('./browser.mjs');
  writeBreaker({ state: 'healthy', flagged_at: null, count_24h: 0, events: [] });
  console.error('[grok-web] breaker reset to healthy.');
}

const VERBS = { login, whoami, chat, quota, diag, status, 'reset-breaker': resetBreaker };

function printHelp() {
  console.error(`grok-web skill CLI

Usage:
  node scripts/run.mjs <verb> [args...]

Verbs:
  login                            One-time visible browser login. Sign in to grok.com (Sign in with X recommended).
  whoami                           Confirm session (probes a few likely auth endpoints).
  chat "<prompt>"                  Drive grok.com to answer. Saves response.md + metadata.json.
                                    Flags: --model <name>, --mode default|think|deepsearch,
                                           --debug, --out <dir>, --timeout <ms>, --force
  quota                            Query the current rate-limit window. Flags: --effort high|low
  diag                             Survey live UI + network. Use to discover selectors after a UI change.
                                    Flags: --prompt "<smoke prompt>", --out <dir>
  status                           Profile + cookies + breaker + pidfile state.
  reset-breaker                    Reset 24h halt after manual intervention.

Architecture:
  Off-screen Chrome (patchright) drives grok.com.
  Session cookies in ${PROFILE_DIR} authenticate requests.
  Output: ~/.quantum/skill-output/grok-web/<runId>/{response.md, metadata.json}

Env:
  GROK_WEB_PROFILE_DIR             Override profile dir (default: ~/.quantum/chrome-profiles/grok)
  GROK_WEB_DEBUG=1                 Verbose logs
`);
}

const [, , verb, ...argvRaw] = process.argv;
if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
  printHelp();
  process.exit(verb ? 0 : 2);
}
if (!VERBS[verb]) {
  console.error(`Unknown verb: ${verb}`);
  printHelp();
  process.exit(2);
}

const argv = parseArgs(argvRaw);

try {
  await VERBS[verb](argv);
} catch (e) {
  die(`[error] ${e.message}`);
}

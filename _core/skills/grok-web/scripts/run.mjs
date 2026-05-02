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
  if (!prompt) die('Usage: chat "<prompt>" [--model auto|fast|expert|heavy|grok-4.3] [--mode <legacy>] [--debug] [--out <dir>] [--timeout <ms>] [--force]');
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
    // Live-confirmed: POST /rest/rate-limits with JSON body. The site's own
    // client sends `{requestKind: "DEFAULT", modelName: "grok-3"}` — we mirror
    // that minimal shape so the response actually applies to chat use.
    // Live-confirmed (2026-05-02): grok-3 and grok-4 use separate quota
    // buckets. grok-3 covers Auto/Fast/Expert (140/2h shared); grok-4 covers
    // Heavy and Grok 4.3 beta (50/2h). Probe both unless caller pins one.
    const url = 'https://grok.com/rest/rate-limits';
    const probeBuckets = argv.flags.model
      ? [{ requestKind: 'DEFAULT', modelName: argv.flags.model }]
      : [
          { requestKind: 'DEFAULT', modelName: 'grok-3' },
          { requestKind: 'DEFAULT', modelName: 'grok-4' }
        ];
    const { parseRateLimitJSON } = await import('./quota.mjs');
    const effort = argv.flags.effort || null;
    const results = {};
    for (const body of probeBuckets) {
      const res = await ctx.page.evaluate(async ({ u, b }) => {
        try {
          const r = await fetch(u, {
            method: 'POST', credentials: 'include',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(b)
          });
          const text = await r.text();
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
          return { status: r.status, ok: r.ok, body: parsed };
        } catch (e) { return { error: e.message }; }
      }, { u: url, b: body });
      if (!res?.ok || !res.body || typeof res.body !== 'object') {
        results[body.modelName] = { ok: false, error: `status=${res?.status || 'err'} body=${JSON.stringify(res?.body || res?.error).slice(0,120)}` };
        continue;
      }
      results[body.modelName] = parseRateLimitJSON(res.body, { effort });
    }
    if (probeBuckets.length === 1) {
      console.log(JSON.stringify({ ...results[probeBuckets[0].modelName], _source_url: url, _model: probeBuckets[0].modelName }, null, 2));
    } else {
      console.log(JSON.stringify({ _source_url: url, buckets: results }, null, 2));
    }
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
                                    Flags: --model auto|fast|expert|heavy|grok-4.3 (or any picker label),
                                           --mode <legacy alias: think→Expert, deepsearch→fails loud>,
                                           --debug, --out <dir>, --timeout <ms>, --force
                                    Note (2026-05): xAI removed the standalone DeepSearch mode.
                                    Use --model heavy ("Team of Experts") for deep research.
  quota                            Query rate-limit windows. Probes both grok-3 (Auto/Fast/Expert,
                                    140/2h) and grok-4 (Heavy + Grok 4.3 beta, 50/2h) by default.
                                    Flags: --effort high|low, --model <id> to pin one bucket
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

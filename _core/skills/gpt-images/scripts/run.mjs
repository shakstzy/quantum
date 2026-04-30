#!/usr/bin/env node
// run.mjs -- gpt-images CLI dispatcher.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..');
const NODE_MODULES = join(SKILL_ROOT, 'node_modules');
const PROFILE_DIR = process.env.GPT_IMAGES_PROFILE_DIR || `${process.env.HOME}/.quantum/chrome-profiles/chatgpt`;
const DEBUG = process.env.GPT_IMAGES_DEBUG === '1';

function die(msg, code = 1) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code);
}

function ensureDeps() {
  if (existsSync(join(NODE_MODULES, 'patchright'))) return;
  console.error('[gpt-images] First run: installing patchright + Chrome (~300MB, 2-3 minutes).');
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
    await ctx.page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const sess = await probeSession(ctx.page);
    if (!sess || !sess.user) {
      die('[gpt-images] not signed in. Run: node scripts/run.mjs login', 3);
    }
    console.log(JSON.stringify({
      ok: true,
      email: sess.user.email || null,
      name: sess.user.name || null,
      id: sess.user.id || null,
      expires: sess.expires || null
    }, null, 2));
  } finally { await ctx.close(); }
}

async function generate(argv) {
  ensureDeps();
  const prompt = argv.positional.join(' ').trim();
  if (!prompt) die('Usage: generate "<prompt>" [--debug] [--out <dir>] [--timeout <ms>] [--force]');
  const { runGenerate } = await import('./generate.mjs');
  const timeoutMs = argv.flags.timeout ? parseInt(argv.flags.timeout, 10) : 180000;
  await runGenerate({
    prompt,
    force: !!argv.flags.force,
    debug: !!argv.flags.debug || DEBUG,
    outDir: argv.flags.out || undefined,
    timeoutMs
  });
}

async function status() {
  const { readBreaker, getProfileDir } = await import('./browser.mjs');
  const dir = getProfileDir();
  const pidfilePath = join(dir, '.skill.pid');
  const pid = existsSync(pidfilePath) ? parseInt(readFileSync(pidfilePath, 'utf8').trim(), 10) : null;
  const b = readBreaker();
  const cookiesPath = join(dir, 'Default', 'Cookies');
  const storage = join(dir, '.storage-state.json');
  console.log(JSON.stringify({
    profile_dir: dir,
    active_pid: pid,
    breaker: b,
    cookies_db: existsSync(cookiesPath) ? 'present' : 'missing',
    storage_state_snapshot: existsSync(storage) ? 'present' : 'missing'
  }, null, 2));
}

async function resetBreaker() {
  const { writeBreaker } = await import('./browser.mjs');
  writeBreaker({ state: 'healthy', flagged_at: null, count_24h: 0, events: [] });
  console.error('[gpt-images] breaker reset to healthy.');
}

const VERBS = { login, whoami, generate, status, 'reset-breaker': resetBreaker };

function printHelp() {
  console.error(`gpt-images skill CLI

Usage:
  node scripts/run.mjs <verb> [args...]

Verbs:
  login                            One-time visible browser login. Cookies persist to profile dir.
  whoami                           Confirm session via /api/auth/session.
  generate "<prompt>"              Drive chatgpt.com to make an image. Saves PNG + metadata.
                                    Flags: --debug, --out <dir>, --timeout <ms>, --force
  status                           Profile + cookies + breaker + pidfile state.
  reset-breaker                    Reset 24h halt after manual intervention.

Architecture:
  Off-screen Chrome (patchright) drives the chatgpt.com chat UI.
  Session cookies in ${PROFILE_DIR} authenticate requests.
  Output: ~/.quantum/skill-output/gpt-images/<runId>/{image-1.png, prompt.txt, metadata.json}

Env:
  GPT_IMAGES_PROFILE_DIR           Override profile dir (default: ~/.quantum/chrome-profiles/chatgpt)
  GPT_IMAGES_DEBUG=1               Verbose polling logs
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

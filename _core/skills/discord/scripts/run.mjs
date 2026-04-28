#!/usr/bin/env node
// run.mjs -- discord skill CLI.
// Every verb runs through a patchright-driven Chrome session on discord.com,
// executing API calls via page.evaluate(fetch). Authenticated by session
// cookies in the profile dir. Request origin, TLS fingerprint, Client Hints,
// and gateway presence all match a real browser.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..');
const NODE_MODULES = join(SKILL_ROOT, 'node_modules');
const PROFILE_DIR = process.env.DISCORD_PROFILE_DIR || `${process.env.HOME}/.quantum/chrome-profiles/discord`;

const REQUIRE_CONFIRM = process.env.QUANTUM_DISCORD_REQUIRE_CONFIRM === '1';
const DEBUG = process.env.DISCORD_DEBUG === '1';

function die(msg, code = 1) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code);
}

function ensureDeps() {
  if (existsSync(join(NODE_MODULES, 'patchright'))) return;
  console.error('[discord] First run: installing patchright + Chrome. This may take 2-3 minutes.');
  const r = spawnSync('npm', ['install'], { cwd: SKILL_ROOT, stdio: 'inherit' });
  if (r.status !== 0) die('npm install failed');
}

function requireSnowflake(val, label) {
  if (!val || typeof val !== 'string' || !/^\d{17,20}$/.test(val)) {
    die(`${label} must be a 17-20 digit numeric snowflake ID; got "${val}"`);
  }
  return val;
}

async function confirmOrAbort(summary) {
  if (!REQUIRE_CONFIRM) return;
  process.stderr.write(`${summary}\nType CONFIRM to send: `);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise(r => rl.question('', r));
  rl.close();
  if (answer.trim() !== 'CONFIRM') die('aborted', 2);
}

function readStdinSync() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
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
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// Session holder. All verbs acquire one, run their work, close it.
class DiscordSession {
  constructor(ctx, pageApi, token) {
    this.ctx = ctx;
    this.pageApi = pageApi;
    this.token = token;
    this.consecutive401s = 0;
  }
  async call(method, path, opts = {}) {
    if (DEBUG) process.stderr.write(`[discord] ${method} ${path}\n`);
    for (let attempt = 0; attempt < 4; attempt++) {
      const tok = this.ctx.getCapturedToken() || this.token;
      const res = await this.pageApi(this.ctx.page, method, path, { ...opts, token: tok });
      if (res.status === 429) {
        const retry = (res.body && res.body.retry_after) || 2;
        process.stderr.write(`[discord] 429; sleeping ${retry}s\n`);
        await new Promise(r => setTimeout(r, retry * 1000));
        continue;
      }
      if (res.status === 401) {
        this.consecutive401s++;
        if (this.consecutive401s >= 2) die('[discord] 2 consecutive 401s; token invalidated. Run: node scripts/run.mjs login', 3);
        die('[discord] 401 unauthorized. Token may be invalidated. Run: node scripts/run.mjs login', 3);
      }
      this.consecutive401s = 0;
      if (!res.ok) {
        const code = res.body && typeof res.body === 'object' ? res.body.code : undefined;
        const message = res.body && typeof res.body === 'object' ? res.body.message : res.body;
        const e = new Error(`${method} ${path} -> ${res.status}${code ? ` code=${code}` : ''}${message ? ` ${message}` : ''}`);
        e.status = res.status;
        e.code = code;
        throw e;
      }
      return res.body;
    }
    die(`[discord] ${method} ${path}: rate limited repeatedly, giving up`);
  }
  async close() { await this.ctx.close(); }
}

async function openSession() {
  ensureDeps();
  const { launchContext, pageApi, waitForCapturedToken } = await import('./browser.mjs');
  const ctx = await launchContext({ visible: false });
  try {
    await ctx.page.goto('https://discord.com/channels/@me', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    await ctx.close();
    throw e;
  }
  // CDP captures the Authorization header from the wire as Discord's client
  // makes its first authenticated call. Allow up to 60s for cold load.
  const tok = await waitForCapturedToken(ctx, { timeoutMs: 60000, probeEveryMs: 500 });
  if (!tok) {
    const finalUrl = ctx.page.url();
    await ctx.close();
    if (finalUrl.includes('/login')) {
      die(`[discord] Session expired (page redirected to ${finalUrl}). Run: node scripts/run.mjs login`, 3);
    }
    die(`[discord] No Authorization header captured within 60s (page at ${finalUrl}). Run: node scripts/run.mjs login`, 3);
  }
  const sess = new DiscordSession(ctx, pageApi, tok);
  try {
    const probe = await pageApi(ctx.page, 'GET', '/api/v9/users/@me', { token: tok });
    if (probe.status === 401) {
      await ctx.close();
      die('[discord] 401 from /users/@me with captured token. Run: node scripts/run.mjs login', 3);
    }
    if (!probe.ok) {
      await ctx.close();
      die(`[discord] Session probe failed: /users/@me returned ${probe.status}`);
    }
  } catch (e) {
    await ctx.close();
    throw e;
  }
  return sess;
}

function matchUser(users, needle) {
  const n = needle.toLowerCase();
  const exact = users.filter(u =>
    u.username?.toLowerCase() === n ||
    u.global_name?.toLowerCase() === n
  );
  if (exact.length === 1) return { match: exact[0], candidates: exact };
  const partial = users.filter(u =>
    u.username?.toLowerCase().includes(n) ||
    u.global_name?.toLowerCase().includes(n)
  );
  if (partial.length === 1) return { match: partial[0], candidates: partial };
  return { match: null, candidates: partial };
}

async function listFriends(sess) {
  const rels = await sess.call('GET', '/api/v9/users/@me/relationships');
  return rels.filter(r => r.type === 1).map(r => r.user);
}

async function resolveUser(sess, nameOrId) {
  if (/^\d{17,20}$/.test(nameOrId)) return { id: nameOrId, username: null, global_name: null };
  const friends = await listFriends(sess);
  const { match, candidates } = matchUser(friends, nameOrId);
  if (match) return match;
  if (candidates.length > 1) {
    die(`Ambiguous: "${nameOrId}" matches ${candidates.length} friends: ${candidates.map(c => c.global_name || c.username).join(', ')}`);
  }
  die(`Friend not found: "${nameOrId}". Not in your friends list. Pass a user ID instead, or add them as a friend.`);
}

async function openDmChannel(sess, userId) {
  const ch = await sess.call('POST', '/api/v9/users/@me/channels', { body: { recipient_id: userId } });
  return ch.id;
}

async function resolveTarget(sess, spec) {
  if (!spec) die('target required');
  if (/^\d{17,20}$/.test(spec)) return { channel_id: spec, kind: 'guild_channel', recipient: null };
  let needle = spec;
  if (spec.startsWith('dm:')) needle = spec.slice(3);
  else if (spec.startsWith('@')) needle = spec.slice(1);
  else die(`Unrecognized target: "${spec}". Use dm:<name>, @<name>, or a channel ID.`);
  const user = await resolveUser(sess, needle);
  const channel_id = await openDmChannel(sess, user.id);
  return { channel_id, kind: 'dm', recipient: user };
}

// Verbs.

async function whoami() {
  const sess = await openSession();
  try {
    const me = await sess.call('GET', '/api/v9/users/@me');
    console.log(JSON.stringify({
      ok: true,
      id: me.id,
      username: me.username,
      global_name: me.global_name,
      email: me.email,
      verified: me.verified,
      mfa_enabled: me.mfa_enabled
    }, null, 2));
  } finally { await sess.close(); }
}

async function friends(argv) {
  const q = (argv.positional[0] || '').toLowerCase();
  const sess = await openSession();
  try {
    const list = await listFriends(sess);
    const filtered = q
      ? list.filter(u => u.username?.toLowerCase().includes(q) || u.global_name?.toLowerCase().includes(q))
      : list;
    const out = filtered.map(u => ({
      id: u.id,
      username: u.username,
      global_name: u.global_name,
      discriminator: u.discriminator
    }));
    console.log(JSON.stringify({ query: q || null, count: out.length, friends: out }, null, 2));
  } finally { await sess.close(); }
}

async function listDms(argv) {
  const limit = Number(argv.flags.limit || 50);
  const sess = await openSession();
  try {
    const chans = await sess.call('GET', '/api/v9/users/@me/channels');
    const dms = chans
      .filter(c => c.type === 1 || c.type === 3)
      .slice(0, limit)
      .map(c => ({
        id: c.id,
        type: c.type === 1 ? 'dm' : 'group_dm',
        recipients: (c.recipients || []).map(r => ({ id: r.id, username: r.username, global_name: r.global_name })),
        last_message_id: c.last_message_id
      }));
    console.log(JSON.stringify({ count: dms.length, dms }, null, 2));
  } finally { await sess.close(); }
}

async function resolveUserVerb(argv) {
  const needle = argv.positional[0];
  if (!needle) die('Usage: resolve-user <name|id>');
  const sess = await openSession();
  try {
    const u = await resolveUser(sess, needle);
    console.log(JSON.stringify({ id: u.id, username: u.username, global_name: u.global_name }, null, 2));
  } finally { await sess.close(); }
}

async function resolveChannel(argv) {
  const needle = argv.positional[0];
  const guild = argv.flags.guild;
  if (!needle || !needle.startsWith('#')) die('Usage: resolve-channel <#name> --guild <guild-id>');
  if (!guild) die('--guild <guild-id> is required for channel resolution');
  requireSnowflake(guild, '--guild');
  const sess = await openSession();
  try {
    const chans = await sess.call('GET', `/api/v9/guilds/${guild}/channels`);
    const name = needle.slice(1).toLowerCase();
    const hit = chans.find(c => c.name?.toLowerCase() === name);
    if (!hit) die(`Channel not found: #${name} in guild ${guild}`);
    console.log(JSON.stringify({ id: hit.id, name: hit.name, type: hit.type, guild_id: guild }, null, 2));
  } finally { await sess.close(); }
}

async function dm(argv) {
  const [target, ...rest] = argv.positional;
  let text = rest.join(' ');
  if (!text && !process.stdin.isTTY) text = readStdinSync().trim();
  if (!text) die('text required (argv or stdin)');
  if (text.length > 2000) die(`message is ${text.length} chars; Discord limit is 2000`);
  const sess = await openSession();
  try {
    const t = await resolveTarget(sess, target.startsWith('dm:') || target.startsWith('@') ? target : `dm:${target}`);
    const who = t.recipient?.global_name || t.recipient?.username || t.channel_id;
    await confirmOrAbort(`DM ${who} (channel ${t.channel_id})\n${text}`);
    const msg = await sess.call('POST', `/api/v9/channels/${t.channel_id}/messages`, {
      body: { content: text, allowed_mentions: { parse: [] } }
    });
    console.log(JSON.stringify({ ok: true, channel_id: t.channel_id, message_id: msg.id, recipient: t.recipient }, null, 2));
  } finally { await sess.close(); }
}

async function send(argv) {
  const [channelId, ...rest] = argv.positional;
  if (!channelId || !/^\d{17,20}$/.test(channelId)) die('Usage: send <channel-id> <text...>   (numeric snowflake ID required; use dm for DMs)');
  let text = rest.join(' ');
  if (!text && !process.stdin.isTTY) text = readStdinSync().trim();
  if (!text) die('text required');
  if (text.length > 2000) die(`message is ${text.length} chars; Discord limit is 2000`);
  const sess = await openSession();
  try {
    await confirmOrAbort(`SEND to channel ${channelId}\n${text}`);
    const msg = await sess.call('POST', `/api/v9/channels/${channelId}/messages`, {
      body: { content: text, allowed_mentions: { parse: [] } }
    });
    console.log(JSON.stringify({ ok: true, channel_id: channelId, message_id: msg.id }, null, 2));
  } finally { await sess.close(); }
}

async function read(argv) {
  const target = argv.positional[0];
  const limit = Math.min(Number(argv.flags.limit || 50), 100);
  const sess = await openSession();
  try {
    const spec = target.startsWith('dm:') || target.startsWith('@') ? target : (/^\d{17,20}$/.test(target) ? target : `dm:${target}`);
    const t = await resolveTarget(sess, spec);
    const msgs = await sess.call('GET', `/api/v9/channels/${t.channel_id}/messages`, { query: { limit: String(limit) } });
    const out = msgs.map(m => ({
      id: m.id,
      timestamp: m.timestamp,
      author: {
        id: m.author?.id,
        username: m.author?.username,
        global_name: m.author?.global_name
      },
      content: m.content,
      ...(m.attachments?.length ? { attachments: m.attachments.map(a => ({ id: a.id, filename: a.filename, url: a.url, size: a.size })) } : {}),
      ...(m.referenced_message ? { reply_to: m.referenced_message.id } : {}),
      ...(m.edited_timestamp ? { edited_timestamp: m.edited_timestamp } : {})
    })).reverse();
    console.log(JSON.stringify({
      channel_id: t.channel_id,
      kind: t.kind,
      recipient: t.recipient ? { id: t.recipient.id, username: t.recipient.username, global_name: t.recipient.global_name } : null,
      count: out.length,
      messages: out
    }, null, 2));
  } finally { await sess.close(); }
}

async function search(argv) {
  const target = argv.positional[0];
  const query = argv.positional.slice(1).join(' ');
  if (!query) die('Usage: search <target> <query...>');
  const sess = await openSession();
  try {
    const spec = target.startsWith('dm:') || target.startsWith('@') ? target : (/^\d{17,20}$/.test(target) ? target : `dm:${target}`);
    const t = await resolveTarget(sess, spec);
    let path, q;
    if (t.kind === 'dm') {
      path = `/api/v9/channels/${t.channel_id}/messages/search`;
      q = { content: query };
    } else if (argv.flags.guild) {
      const guild = requireSnowflake(argv.flags.guild, '--guild');
      path = `/api/v9/guilds/${guild}/messages/search`;
      q = { content: query, channel_id: t.channel_id };
    } else {
      path = `/api/v9/channels/${t.channel_id}/messages/search`;
      q = { content: query };
    }
    const body = await sess.call('GET', path, { query: q });
    const hits = (body.messages || []).flat().map(m => ({
      id: m.id,
      timestamp: m.timestamp,
      channel_id: m.channel_id,
      author: { id: m.author?.id, username: m.author?.username, global_name: m.author?.global_name },
      content: m.content
    }));
    console.log(JSON.stringify({ query, total: body.total_results, count: hits.length, hits }, null, 2));
  } finally { await sess.close(); }
}

async function login(argv) {
  ensureDeps();
  const { runLogin } = await import('./login.mjs');
  await runLogin({ force: !!argv.flags.force });
}

async function status() {
  const { readBreaker, getProfileDir } = await import('./browser.mjs');
  const dir = getProfileDir();
  const pidfilePath = join(dir, '.skill.pid');
  const pid = existsSync(pidfilePath) ? parseInt(readFileSync(pidfilePath, 'utf8').trim(), 10) : null;
  const b = readBreaker();
  const cookiesPath = join(dir, 'Default', 'Cookies');
  const cookies = existsSync(cookiesPath) ? 'present' : 'missing';
  console.log(JSON.stringify({
    profile_dir: dir,
    active_pid: pid,
    breaker: b,
    cookies
  }, null, 2));
}

async function resetBreaker() {
  const { writeBreaker } = await import('./browser.mjs');
  writeBreaker({ state: 'healthy', flagged_at: null, count_24h: 0, events: [] });
  console.error('[discord] breaker reset to healthy.');
}

const VERBS = {
  whoami,
  friends,
  'list-dms': listDms,
  'resolve-user': resolveUserVerb,
  'resolve-channel': resolveChannel,
  dm,
  send,
  read,
  search,
  login,
  status,
  'reset-breaker': resetBreaker
};

function printHelp() {
  console.error(`discord skill CLI

Usage:
  node scripts/run.mjs <verb> [args...]

Verbs:
  login                           One-time visible browser login. Cookies persist to profile dir.
  whoami                          GET /users/@me via page.evaluate
  friends [query]                 List friends, optional name filter
  list-dms [--limit=N]            Open DM channels, most recent first
  resolve-user <name|id>          Friend name -> user ID
  resolve-channel <#name> --guild <id>   #name -> channel ID in a guild
  dm <name|id> <text...>          DM a friend (body via argv or stdin)
  send <channel-id> <text...>     Post to a guild channel by numeric ID
  read <target> [--limit=N]       Last N messages. target = friend name, dm:<name>, @<name>, or channel ID
  search <target> <query...>      Search messages in a DM or channel
  status                          Profile + cookies + breaker + pidfile state
  reset-breaker                   Reset 24h halt after manual intervention

Architecture:
  All API calls execute inside a real Chrome session (patchright) pointed at discord.com.
  Session cookies in ${PROFILE_DIR} authenticate requests.
  Each verb boots Chrome (~5-10s) and closes it after the call.

Env:
  DISCORD_PROFILE_DIR             Override profile dir (default: ~/.quantum/chrome-profiles/discord)
  QUANTUM_DISCORD_REQUIRE_CONFIRM=1   Require literal CONFIRM token before sends
  DISCORD_DEBUG=1                 Log request URLs
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

#!/usr/bin/env node
// slack playbook CLI. Native fetch, no deps. Token from macOS Keychain.
// Usage: node run.mjs <verb> [args...]   Verbs: whoami, send, read, search, users, channels, dm-open

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import readline from "node:readline";

const KEYCHAIN_SERVICE = "shakos-slack";
const ACCOUNT = process.env.SLACK_ACCOUNT || "eclipse-labs";
const REQUIRE_CONFIRM = process.env.SHAKOS_SLACK_REQUIRE_CONFIRM === "1";
const API = "https://slack.com/api";

function getToken() {
  try {
    return execFileSync("security", [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", ACCOUNT, "-w",
    ], { encoding: "utf8" }).trim();
  } catch {
    die(`No token in Keychain for service="${KEYCHAIN_SERVICE}" account="${ACCOUNT}".\nStore with:\n  security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${ACCOUNT} -w "xoxp-..." -U`);
  }
}

function die(msg, code = 1) {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
  process.exit(code);
}

function die429(method, channel, attempts, lastRetry) {
  die(`slack.${method} rate-limited: ${attempts} consecutive 429s on channel=${channel}; last Retry-After=${lastRetry}s. Backoff ceiling reached; caller must re-run later.`);
}

async function slack(method, params = {}, { form = false } = {}) {
  const token = getToken();
  const url = `${API}/${method}`;
  const init = {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  };
  if (form) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(params).toString();
  } else {
    init.headers["Content-Type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(params);
  }
  const res = await fetch(url, init);
  const body = await res.json();
  if (!body.ok) {
    const err = new Error(`slack.${method} failed: ${body.error}${body.response_metadata ? " " + JSON.stringify(body.response_metadata) : ""}`);
    err.body = body;
    throw err;
  }
  return body;
}

async function paginate(method, params, itemsKey, max = 1000) {
  let cursor;
  const out = [];
  for (;;) {
    const b = await slack(method, { ...params, limit: 200, ...(cursor ? { cursor } : {}) }, { form: true });
    out.push(...(b[itemsKey] || []));
    cursor = b.response_metadata?.next_cursor;
    if (!cursor || out.length >= max) break;
  }
  return out.slice(0, max);
}

async function resolveTarget(target) {
  if (!target) die("target required (#channel, @user, or ID)");
  if (/^[CDG][A-Z0-9]{8,}$/.test(target)) return target;
  if (/^U[A-Z0-9]{8,}$/.test(target)) {
    const r = await slack("conversations.open", { users: target });
    return r.channel.id;
  }
  if (target.startsWith("#")) {
    const name = target.slice(1);
    const chans = await paginate("conversations.list", { types: process.env.SLACK_CHANNEL_TYPES || "public_channel", exclude_archived: true }, "channels");
    const hit = chans.find(c => c.name === name);
    if (!hit) die(`channel not found: #${name}`);
    return hit.id;
  }
  if (target.startsWith("@")) {
    const name = target.slice(1);
    const users = await paginate("users.list", {}, "members");
    const hit = users.find(u => !u.deleted && (u.name === name || u.profile?.display_name === name || u.profile?.real_name === name));
    if (!hit) die(`user not found: @${name}`);
    const r = await slack("conversations.open", { users: hit.id });
    return r.channel.id;
  }
  die(`unrecognized target: ${target} (use #channel, @user, or ID)`);
}

async function confirmOrAbort(summary) {
  if (!REQUIRE_CONFIRM) return;
  process.stderr.write(`${summary}\nType CONFIRM to send: `);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise(r => rl.question("", r));
  rl.close();
  if (answer.trim() !== "CONFIRM") die("aborted", 2);
}

function readStdinSync() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

async function whoami() {
  const b = await slack("auth.test", {}, { form: true });
  console.log(JSON.stringify({ ok: b.ok, user: b.user, user_id: b.user_id, team: b.team, team_id: b.team_id, url: b.url, account: ACCOUNT }, null, 2));
}

async function send(argv) {
  const [target, ...rest] = argv;
  let text = rest.join(" ");
  if (!text && !process.stdin.isTTY) text = readStdinSync().trim();
  if (!text) die("text required (argv or stdin)");
  const channel = await resolveTarget(target);
  await confirmOrAbort(`SEND TO ${target} (channel ${channel})\n---\n${text}\n---`);
  const b = await slack("chat.postMessage", { channel, text, unfurl_links: false, unfurl_media: false });
  console.log(JSON.stringify({ ok: true, channel: b.channel, ts: b.ts }, null, 2));
}

async function read(argv) {
  const target = argv[0];
  const count = Number(argv.find(a => a.startsWith("--count="))?.split("=")[1] || 20);
  const channel = await resolveTarget(target);
  const b = await slack("conversations.history", { channel, limit: String(count) }, { form: true });
  const msgs = (b.messages || []).reverse().map(m => ({
    ts: m.ts,
    user: m.user || m.bot_id || m.username,
    text: m.text,
    ...(m.thread_ts && m.thread_ts !== m.ts ? { thread_ts: m.thread_ts } : {}),
    ...(m.reply_count ? { reply_count: m.reply_count } : {}),
  }));
  console.log(JSON.stringify({ channel, count: msgs.length, messages: msgs }, null, 2));
}

// Bulk cursor-paginated history. Writes NDJSON (one message per line) to stdout.
// Usage: history <target> [--oldest=<ts>] [--latest=<ts>] [--max=N]
// Rate-limit aware: respects Retry-After on 429.
async function history(argv) {
  const target = argv[0];
  const oldest = argv.find(a => a.startsWith("--oldest="))?.split("=")[1];
  const latest = argv.find(a => a.startsWith("--latest="))?.split("=")[1];
  const max = Number(argv.find(a => a.startsWith("--max="))?.split("=")[1] || Infinity);
  const channel = await resolveTarget(target);
  const token = getToken();
  let cursor;
  let fetched = 0;
  for (;;) {
    const params = new URLSearchParams({
      channel,
      limit: "200",
      ...(oldest ? { oldest } : {}),
      ...(latest ? { latest } : {}),
      ...(cursor ? { cursor } : {}),
    });
    let res, retry;
    let attempt = 0;
    for (; attempt < 5; attempt++) {
      res = await fetch(`${API}/conversations.history`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      if (res.status !== 429) break;
      retry = Number(res.headers.get("retry-after") || "5");
      process.stderr.write(`[history] 429; sleeping ${retry}s (attempt ${attempt + 1})\n`);
      await new Promise(r => setTimeout(r, retry * 1000));
    }
    if (res.status === 429) die429("conversations.history", channel, attempt, retry);
    const body = await res.json();
    if (!body.ok) die(`slack.conversations.history failed: ${body.error}`);
    for (const m of body.messages || []) {
      process.stdout.write(JSON.stringify({
        channel,
        ts: m.ts,
        user: m.user || m.bot_id || m.username,
        text: m.text || "",
        ...(m.thread_ts && m.thread_ts !== m.ts ? { thread_ts: m.thread_ts } : {}),
        ...(m.reply_count ? { reply_count: m.reply_count } : {}),
        ...(m.files ? { files: m.files.map(f => ({ id: f.id, name: f.name, mimetype: f.mimetype })) } : {}),
        ...(m.subtype ? { subtype: m.subtype } : {}),
      }) + "\n");
      fetched++;
      if (fetched >= max) return;
    }
    cursor = body.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  process.stderr.write(`[history] ${channel}: ${fetched} messages\n`);
}

async function search(argv) {
  const query = argv.join(" ");
  if (!query) die("query required");
  const b = await slack("search.messages", { query, count: "20", sort: "timestamp" }, { form: true });
  const hits = (b.messages?.matches || []).map(m => ({
    ts: m.ts,
    channel: m.channel?.name ? `#${m.channel.name}` : m.channel?.id,
    user: m.username || m.user,
    text: m.text,
    permalink: m.permalink,
  }));
  console.log(JSON.stringify({ query, total: b.messages?.total, hits }, null, 2));
}

async function users(argv) {
  const q = (argv[0] || "").toLowerCase();
  const limit = Number(argv.find(a => a.startsWith("--limit="))?.split("=")[1] || 0);  // 0 = no cap (machine-readable)
  const list = await paginate("users.list", {}, "members", 5000);
  const filtered = list
    .filter(u => !u.deleted && !u.is_bot)
    .filter(u => !q || u.name?.toLowerCase().includes(q) || u.profile?.real_name?.toLowerCase().includes(q) || u.profile?.display_name?.toLowerCase().includes(q))
    .map(u => ({ id: u.id, name: u.name, real_name: u.profile?.real_name, display_name: u.profile?.display_name, email: u.profile?.email }));
  const out = limit > 0 ? filtered.slice(0, limit) : filtered;
  console.log(JSON.stringify({ query: q || null, count: filtered.length, users: out }, null, 2));
}

async function channels(argv) {
  const q = (argv[0] || "").toLowerCase();
  const limit = Number(argv.find(a => a.startsWith("--limit="))?.split("=")[1] || 0);  // 0 = no cap
  const list = await paginate("conversations.list", { types: process.env.SLACK_CHANNEL_TYPES || "public_channel", exclude_archived: true }, "channels", 5000);
  const filtered = list
    .filter(c => !q || c.name?.toLowerCase().includes(q))
    .map(c => ({ id: c.id, name: c.name, is_private: c.is_private, is_member: c.is_member, num_members: c.num_members }));
  const out = limit > 0 ? filtered.slice(0, limit) : filtered;
  console.log(JSON.stringify({ query: q || null, count: filtered.length, channels: out }, null, 2));
}

async function dmOpen(argv) {
  const target = argv[0];
  const channel = await resolveTarget(target);
  console.log(JSON.stringify({ target, channel }, null, 2));
}

const [, , verb, ...argv] = process.argv;
const verbs = { whoami, send, read, history, search, users, channels, "dm-open": dmOpen };

if (!verb || !verbs[verb]) {
  console.error(`Usage: node run.mjs <verb> [args...]
Verbs:
  whoami
  send <target> <text...>        target = #channel | @user | ID.  Reads body from stdin if no text argv.
  read <target> [--count=N]
  history <target> [--oldest=<ts>] [--latest=<ts>] [--max=N]
                                   NDJSON to stdout. Rate-limit aware (429 respects Retry-After).
  search <query...>
  users [query]
  channels [query]
  dm-open <@user|UserID>

Env:
  SLACK_ACCOUNT                    keychain account name (default: eclipse-labs)
  SHAKOS_SLACK_REQUIRE_CONFIRM=1   prompt for CONFIRM before send (default: off)`);
  process.exit(verb ? 2 : 0);
}

try {
  await verbs[verb](argv);
} catch (e) {
  die(`[error] ${e.message}`, 1);
}

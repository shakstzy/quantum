#!/usr/bin/env node
// run.mjs -- x-read skill CLI.
//
// Verbs: login | whoami | thread | status | reset-breaker
// All read-only. Replays X GraphQL ops via captured request templates from
// inside the x.com page context.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..');
const NODE_MODULES = join(SKILL_ROOT, 'node_modules');
const PROFILE_DIR = process.env.X_READ_PROFILE_DIR || `${process.env.HOME}/.quantum/chrome-profiles/x`;
const DEBUG = process.env.X_READ_DEBUG === '1';

function die(msg, code = 1) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code);
}

function ensureDeps() {
  if (existsSync(join(NODE_MODULES, 'patchright'))) return;
  console.error('[x-read] First run: installing patchright + Chrome. This may take 2-3 minutes.');
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

// Extract a tweet ID from a full URL or accept a bare numeric ID.
function parseTweetId(input) {
  if (!input) die('tweet id or URL required');
  if (/^\d{5,25}$/.test(input)) return input;
  const m = input.match(/(?:x|twitter)\.com\/[^\/]+\/status(?:es)?\/(\d{5,25})/);
  if (m) return m[1];
  die(`could not parse tweet ID from "${input}"; pass an x.com/<handle>/status/<id> URL or a bare numeric ID`);
}

// Boot a session and warm it up so a target op is captured before we replay.
// warmupOp: name of GraphQL op the caller needs in the template map.
// warmupNav: URL to navigate to in order to organically trigger that op.
async function openSession({ warmupOp, warmupNav }) {
  ensureDeps();
  const { launchContext, waitForTemplate, isAuthChallengeUrl, tripBreaker } = await import('./browser.mjs');

  const ctx = await launchContext({ visible: false });
  try {
    if (DEBUG) process.stderr.write(`[x-read] navigating to ${warmupNav}\n`);
    await ctx.page.goto(warmupNav, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    await ctx.close();
    throw e;
  }

  // Detect challenge redirects after navigation settles.
  await new Promise(r => setTimeout(r, 1500));
  const url = ctx.page.url();
  if (isAuthChallengeUrl(url)) {
    tripBreaker('challenge-on-warmup');
    await ctx.close();
    die(`[x-read] redirected to challenge URL ${url}. Breaker tripped. Run \`node scripts/run.mjs login\` after manually verifying the account.`, 3);
  }

  const template = await waitForTemplate(ctx, warmupOp, { timeoutMs: 30000, probeEveryMs: 300 });
  if (!template) {
    const ops = ctx.listCapturedOps();
    await ctx.close();
    die(`[x-read] session warm-up failed: required op "${warmupOp}" not observed within 30s. Captured ops: [${ops.join(', ') || 'none'}]. If "none", session likely expired; run \`node scripts/run.mjs login\`.`, 3);
  }
  return ctx;
}

async function whoami() {
  // Viewer fires on home load.
  const ctx = await openSession({ warmupOp: 'Viewer', warmupNav: 'https://x.com/home' });
  const { pageApi, rateLimitSleepMs } = await import('./browser.mjs');
  try {
    const tpl = ctx.getTemplate('Viewer');
    const res = await pageApi(ctx.page, 'Viewer', tpl);
    if (res.status === 429) {
      const wait = rateLimitSleepMs(res.rateLimit.reset);
      die(`[x-read] 429 rate-limited; reset in ${Math.round(wait/1000)}s. Try again later.`, 4);
    }
    if (res.status === 401 || res.status === 403) {
      die(`[x-read] ${res.status} from Viewer; session likely expired. Run \`node scripts/run.mjs login\`.`, 3);
    }
    if (!res.ok) {
      die(`[x-read] Viewer returned ${res.status}: ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body).slice(0, 400)}`);
    }
    const viewer = res.body?.data?.viewer || res.body?.data?.viewer_v2 || res.body?.data;
    const userResult = viewer?.user_results?.result || viewer?.user_result?.result;
    const legacy = userResult?.legacy || {};
    const out = {
      ok: true,
      id: userResult?.rest_id || null,
      handle: legacy.screen_name || null,
      name: legacy.name || null,
      verified: !!(userResult?.is_blue_verified ?? legacy.verified),
      followers: legacy.followers_count ?? null,
      following: legacy.friends_count ?? null
    };
    console.log(JSON.stringify(out, null, 2));
  } finally { await ctx.close(); }
}

async function thread(argv) {
  const tweetId = parseTweetId(argv.positional[0]);
  // Navigate to the canonical tweet URL so the X client fires TweetDetail
  // for THIS tweet ID. This both captures the template and gives us a fresh
  // response we can mine.
  const navUrl = `https://x.com/i/status/${tweetId}`;
  const ctx = await openSession({ warmupOp: 'TweetDetail', warmupNav: navUrl });
  const { pageApi, rateLimitSleepMs } = await import('./browser.mjs');
  try {
    const tpl = ctx.getTemplate('TweetDetail');
    // Replay with our target tweet ID; X may have already fetched it, but
    // replaying ensures we have a fresh, parseable response in our control.
    const res = await pageApi(ctx.page, 'TweetDetail', tpl, {
      variables: { focalTweetId: tweetId }
    });
    if (res.status === 429) {
      const wait = rateLimitSleepMs(res.rateLimit.reset);
      die(`[x-read] 429 rate-limited; reset in ${Math.round(wait/1000)}s.`, 4);
    }
    if (res.status === 401 || res.status === 403) {
      die(`[x-read] ${res.status} from TweetDetail; session likely expired. Run \`node scripts/run.mjs login\`.`, 3);
    }
    if (!res.ok) {
      die(`[x-read] TweetDetail returned ${res.status}: ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body).slice(0, 400)}`);
    }
    const out = parseTweetDetail(res.body, tweetId);
    out.fetched_at = new Date().toISOString();
    console.log(JSON.stringify(out, null, 2));
  } finally { await ctx.close(); }
}

// Walk the TweetDetail response. We pull the focal tweet + every reply entry
// surfaced in the primary instructions block. Cursor-paginated "show more
// replies" modules are NOT walked in v1.
function parseTweetDetail(body, focalId) {
  try {
    const instructions = body?.data?.threaded_conversation_with_injections_v2?.instructions
      || body?.data?.threaded_conversation_with_injections?.instructions
      || [];
    const entries = [];
    for (const inst of instructions) {
      if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
        entries.push(...inst.entries);
      }
    }
    const tweets = [];
    for (const entry of entries) {
      const items = collectTweetResults(entry);
      for (const r of items) tweets.push(normalizeTweet(r));
    }
    const root = tweets.find(t => t.id === focalId) || tweets[0] || null;
    const replies = tweets.filter(t => t.id !== (root?.id ?? focalId));
    return {
      ok: true,
      root,
      replies,
      counts: { tweets: tweets.length, replies: replies.length },
      truncated_note: 'v1 returns only primary entries; cursor-paginated "show more replies" modules are not walked.'
    };
  } catch (e) {
    return { ok: false, error: `parse failed: ${e.message}`, raw_keys: Object.keys(body || {}) };
  }
}

function collectTweetResults(entry) {
  const out = [];
  // Single-tweet entries.
  const single = entry?.content?.itemContent?.tweet_results?.result;
  if (single) out.push(single);
  // Conversation modules: items[]
  const items = entry?.content?.items || [];
  for (const it of items) {
    const r = it?.item?.itemContent?.tweet_results?.result;
    if (r) out.push(r);
  }
  return out;
}

function normalizeTweet(r) {
  // Tombstones (deleted/unavailable) come back as TweetTombstone or
  // TweetUnavailable; legacy is missing. Surface what we can.
  if (r?.__typename === 'TweetTombstone' || r?.__typename === 'TweetUnavailable') {
    return { id: r?.rest_id || null, tombstone: r?.tombstone?.text?.text || r?.__typename, text: null, author: null };
  }
  const tweet = r?.tweet || r; // some responses nest under .tweet
  const legacy = tweet?.legacy || {};
  const note = tweet?.note_tweet?.note_tweet_results?.result?.text;
  const userResult = tweet?.core?.user_results?.result;
  const userLegacy = userResult?.legacy || {};
  return {
    id: tweet?.rest_id || legacy?.id_str || null,
    text: note || legacy?.full_text || null,
    is_long_form: !!note,
    created_at: legacy?.created_at || null,
    in_reply_to_status_id: legacy?.in_reply_to_status_id_str || null,
    metrics: {
      replies: legacy?.reply_count ?? null,
      retweets: legacy?.retweet_count ?? null,
      likes: legacy?.favorite_count ?? null,
      bookmarks: legacy?.bookmark_count ?? null,
      quotes: legacy?.quote_count ?? null,
      views: tweet?.views?.count ?? null
    },
    media: (legacy?.entities?.media || []).map(m => ({
      type: m.type,
      url: m.media_url_https,
      expanded: m.expanded_url
    })),
    author: {
      id: userResult?.rest_id || null,
      handle: userLegacy?.screen_name || null,
      name: userLegacy?.name || null,
      verified: !!(userResult?.is_blue_verified ?? userLegacy?.verified)
    }
  };
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
  writeBreaker({ state: 'healthy', flagged_at: null, events: [] });
  console.error('[x-read] breaker reset to healthy.');
}

const VERBS = {
  login,
  whoami,
  thread,
  status,
  'reset-breaker': resetBreaker
};

function printHelp() {
  console.error(`x-read skill CLI (read-only)

Usage:
  node scripts/run.mjs <verb> [args...]

Verbs:
  login                       One-time visible browser login. Cookies persist to profile dir.
  whoami                      Capture Viewer op + return Adithya's user object.
  thread <url-or-id>          Fetch tweet + visible replies. Pass x.com/<handle>/status/<id> URL or bare numeric ID.
  status                      Profile + cookies + breaker + pidfile state.
  reset-breaker               Reset the 24h halt after manual verification.

Read-only contract:
  pageApi accepts only GET. There are no write verbs (post, like, follow, dm).
  For posting to X, use the zernio-post skill instead.

Env:
  X_READ_PROFILE_DIR          Override profile dir (default: ~/.quantum/chrome-profiles/x)
  X_READ_DEBUG=1              Verbose logs to stderr
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

#!/usr/bin/env node
// run.mjs -- x-read skill CLI.
//
// Verbs: login | whoami | thread | status | reset-breaker
// All read-only. v1 parses the page's organic GraphQL responses (no replay)
// to keep zero-extra-request semantics + dodge the original-vs-replay race.

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

function parseTweetId(input) {
  if (!input) die('tweet id or URL required');
  if (/^\d{5,25}$/.test(input)) return input;
  const m = input.match(/(?:x|twitter)\.com\/[^\/]+\/status(?:es)?\/(\d{5,25})/);
  if (m) return m[1];
  die(`could not parse tweet ID from "${input}"; pass an x.com/<handle>/status/<id> URL or a bare numeric ID`);
}

// Boot a session, navigate, and wait for a target op's response to be captured
// from the page's organic traffic.
async function openSessionAndCapture({ navUrl, expectedOp }) {
  ensureDeps();
  const { launchContext, isAuthChallengeUrl, detectDomChallenge, tripBreaker } = await import('./browser.mjs');

  const ctx = await launchContext({ visible: false });
  try {
    if (DEBUG) process.stderr.write(`[x-read] navigating to ${navUrl}\n`);
    await ctx.page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    await ctx.close();
    throw e;
  }

  // Settle briefly so URL redirects + initial DOM render finish.
  await new Promise(r => setTimeout(r, 1500));

  // URL-level challenge check.
  const url = ctx.page.url();
  if (isAuthChallengeUrl(url)) {
    tripBreaker(`challenge-url:${url}`);
    await ctx.close();
    die(`[x-read] redirected to challenge URL ${url}. Breaker tripped (single-strike on Premium account). After verifying the account in a real browser, run \`node scripts/run.mjs login\`.`, 3);
  }

  // DOM-level challenge check.
  const domChallenge = await detectDomChallenge(ctx.page).catch(() => null);
  if (domChallenge) {
    tripBreaker(`dom-challenge:${domChallenge}`);
    await ctx.close();
    die(`[x-read] DOM challenge detected (${domChallenge}). Breaker tripped. Verify the account in a real browser, then run \`login\`.`, 3);
  }

  // Wait for the response we need.
  const resp = await ctx.waitForResponse(expectedOp, { timeoutMs: 30000 });
  if (!resp) {
    const ops = ctx.listCapturedResponses();
    await ctx.close();
    die(`[x-read] expected op "${expectedOp}" response not seen within 30s. Captured response ops: [${ops.join(', ') || 'none'}]. If "none", session likely expired; run \`node scripts/run.mjs login\`.`, 3);
  }

  // Auth-failure check on the response itself.
  if (resp.status === 401 || resp.status === 403) {
    tripBreaker(`response-${resp.status}:${expectedOp}`);
    await ctx.close();
    die(`[x-read] ${resp.status} from ${expectedOp}; session likely expired. Breaker tripped. Run \`node scripts/run.mjs login\`.`, 3);
  }
  if (resp.status === 429) {
    const { rateLimitResetSeconds } = await import('./browser.mjs');
    const wait = rateLimitResetSeconds(resp.rateLimit?.reset);
    await ctx.close();
    die(`[x-read] 429 rate-limited on ${expectedOp}; reset in ${wait}s.`, 4);
  }
  if (!resp.ok) {
    await ctx.close();
    die(`[x-read] ${expectedOp} returned ${resp.status}: ${typeof resp.body === 'string' ? resp.body.slice(0, 400) : JSON.stringify(resp.body).slice(0, 400)}`);
  }
  // Round 2 finding: parseError can mask body-read failures as null-body
  // success. Treat as capture failure rather than parser failure downstream.
  if (resp.parseError) {
    await ctx.close();
    die(`[x-read] ${expectedOp} response body capture failed: ${resp.parseError}`);
  }
  if (!resp.body || typeof resp.body !== 'object') {
    await ctx.close();
    die(`[x-read] ${expectedOp} body was not a JSON object (got ${typeof resp.body}). Likely a captcha interstitial or transient error.`);
  }

  return { ctx, resp };
}

async function whoami() {
  // X 2026 doesn't fire a single "Viewer" op anymore. We use a different
  // strategy: parse the user's rest_id from the `twid` cookie (deterministic;
  // cookie format is `u%3D<rest_id>`), then walk any response that contains
  // user_results.result for our rest_id. HomeTimeline always fires on /home
  // and embeds users.
  const { launchContext, isAuthChallengeUrl, detectDomChallenge, tripBreaker } = await import('./browser.mjs');
  const ctx = await launchContext({ visible: false });
  try {
    if (DEBUG) process.stderr.write('[x-read] navigating to https://x.com/home\n');
    await ctx.page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));
    const url = ctx.page.url();
    if (isAuthChallengeUrl(url)) {
      tripBreaker(`challenge-url:${url}`);
      die(`[x-read] redirected to challenge URL ${url}. Breaker tripped. Run \`login\` after verifying the account.`, 3);
    }
    const dom = await detectDomChallenge(ctx.page).catch(() => null);
    if (dom) {
      tripBreaker(`dom-challenge:${dom}`);
      die(`[x-read] DOM challenge detected (${dom}). Breaker tripped.`, 3);
    }
    // Parse twid cookie for rest_id.
    const cookies = await ctx.context.cookies();
    const twid = cookies.find(c => c.name === 'twid');
    let restId = null;
    if (twid) {
      const m = decodeURIComponent(twid.value).match(/u=(\d+)/);
      if (m) restId = m[1];
    }
    // Wait for HomeTimeline (fires reliably on /home in 2026 X).
    const resp = await ctx.waitForResponse('HomeTimeline', { timeoutMs: 30000 });
    if (!resp) {
      const ops = ctx.listCapturedResponses();
      die(`[x-read] no HomeTimeline response within 30s. Captured: [${ops.join(', ')}]. Session may need re-login.`, 3);
    }
    if (resp.status === 401 || resp.status === 403) {
      tripBreaker(`response-${resp.status}:HomeTimeline`);
      die(`[x-read] ${resp.status} from HomeTimeline; session expired. Run \`login\`.`, 3);
    }
    // Walk response recursively for our user.
    const ourUser = restId ? findUserByRestId(resp.body, restId) : null;
    if (!ourUser) {
      // Fall back to just rest_id from cookie.
      console.log(JSON.stringify({
        ok: !!restId,
        id: restId,
        handle: null,
        name: null,
        note: restId
          ? 'authenticated (rest_id from twid cookie); could not locate own user object in HomeTimeline response. Run `thread <url>` against any tweet to confirm session works end-to-end.'
          : 'twid cookie missing; not authenticated. Run `login`.'
      }, null, 2));
      if (!restId) process.exitCode = 3;
      return;
    }
    const legacy = ourUser?.legacy || {};
    console.log(JSON.stringify({
      ok: true,
      id: ourUser?.rest_id || restId,
      handle: legacy.screen_name || null,
      name: legacy.name || null,
      verified: !!(ourUser?.is_blue_verified ?? legacy.verified),
      premium: !!ourUser?.is_blue_verified,
      followers: legacy.followers_count ?? null,
      following: legacy.friends_count ?? null
    }, null, 2));
  } finally { await ctx.close(); }
}

// Recursively find a user_results.result with the given rest_id.
function findUserByRestId(node, restId, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return null;
  if (Array.isArray(node)) {
    for (const x of node) { const hit = findUserByRestId(x, restId, depth + 1); if (hit) return hit; }
    return null;
  }
  if (node.user_results && node.user_results.result && node.user_results.result.rest_id === restId) {
    return node.user_results.result;
  }
  // Some responses use `core.user_results.result` shape. Tested above is enough.
  for (const k of Object.keys(node)) {
    const hit = findUserByRestId(node[k], restId, depth + 1);
    if (hit) return hit;
  }
  return null;
}

async function thread(argv) {
  const tweetId = parseTweetId(argv.positional[0]);
  const navUrl = `https://x.com/i/status/${tweetId}`;
  const { ctx, resp } = await openSessionAndCapture({
    navUrl,
    expectedOp: 'TweetDetail'
  });
  try {
    const out = parseTweetDetail(resp.body, tweetId);
    out.fetched_at = new Date().toISOString();
    if (out.ok && out.root && out.root.id !== tweetId) {
      // Codex round 1: silent root mismatch corrupts output. Fail loud.
      out.ok = false;
      out.error = `root.id mismatch: expected ${tweetId}, got ${out.root.id}`;
    }
    console.log(JSON.stringify(out, null, 2));
    if (!out.ok) process.exitCode = 5;
  } finally { await ctx.close(); }
}

// ---- TweetDetail parser ------------------------------------------------

// Walk every instruction's entries (any instruction type that has them) and
// collect tweet results recursively.
function parseTweetDetail(body, focalId) {
  try {
    const instructions = body?.data?.threaded_conversation_with_injections_v2?.instructions
      || body?.data?.threaded_conversation_with_injections?.instructions
      || [];
    const allEntries = [];
    for (const inst of instructions) {
      if (Array.isArray(inst?.entries)) allEntries.push(...inst.entries);
      // Some instruction types (TimelineReplaceEntry, TimelineAddToModule)
      // carry entries under different keys; deep-walk to be safe.
      collectEntriesDeep(inst, allEntries);
    }
    const tweetResults = [];
    for (const entry of allEntries) collectTweetResultsDeep(entry, tweetResults);
    // De-dupe by rest_id (entries can repeat across modules).
    const seen = new Set();
    const tweets = [];
    for (const r of tweetResults) {
      const t = normalizeTweet(r);
      const key = t?.id || JSON.stringify(t).slice(0, 64);
      if (seen.has(key)) continue;
      seen.add(key);
      tweets.push(t);
    }
    let root = tweets.find(t => t.id === focalId) || null;
    // Round 2 finding: if the focal tweet is unavailable/tombstoned and X
    // returned no rest_id on the tombstone result, the parser would otherwise
    // bail with "not found" instead of surfacing the unavailable reason.
    // Look for an unidentified tombstone among tweets and adopt it as root.
    if (!root) {
      const tombstone = tweets.find(t => t.tombstone && (t.id === null || t.id === focalId));
      if (tombstone) {
        root = { ...tombstone, id: focalId };
      } else {
        return {
          ok: false,
          error: `focal tweet ${focalId} not found in TweetDetail response (likely deleted, suspended, withheld, or behind a sensitive-media interstitial)`,
          captured_ids: tweets.map(t => t.id).filter(Boolean)
        };
      }
    }
    const replies = tweets.filter(t => t.id !== root.id);
    return {
      ok: true,
      root,
      replies,
      counts: { tweets: tweets.length, replies: replies.length },
      truncated_note: 'v1 returns only entries surfaced in the first TweetDetail response. Cursor-paginated "show more replies" modules are not walked.'
    };
  } catch (e) {
    return { ok: false, error: `parse failed: ${e.message}`, raw_keys: Object.keys(body || {}) };
  }
}

function collectEntriesDeep(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) {
    for (const x of node) collectEntriesDeep(x, out, depth + 1);
    return;
  }
  if (Array.isArray(node.entries)) out.push(...node.entries);
  for (const k of Object.keys(node)) {
    if (k === 'entries') continue;
    collectEntriesDeep(node[k], out, depth + 1);
  }
}

// Recursively find any object that looks like a tweet_results.result wrapper.
function collectTweetResultsDeep(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) {
    for (const x of node) collectTweetResultsDeep(x, out, depth + 1);
    return;
  }
  if (node.tweet_results && node.tweet_results.result) {
    out.push(node.tweet_results.result);
  }
  for (const k of Object.keys(node)) {
    collectTweetResultsDeep(node[k], out, depth + 1);
  }
}

// Unwrap TweetWithVisibilityResults / Tweet / TweetTombstone wrapper layers.
// Returns the inner tweet object (with rest_id + legacy) or the original
// tombstone marker.
function unwrapVisibilityResult(r) {
  if (!r || typeof r !== 'object') return r;
  // TweetWithVisibilityResults nests the real tweet under .tweet
  if (r.__typename === 'TweetWithVisibilityResults' && r.tweet) return r.tweet;
  if (r.tweet && r.tweet.rest_id && !r.rest_id) return r.tweet;
  return r;
}

function normalizeTweet(rawResult) {
  const r = unwrapVisibilityResult(rawResult);
  // Tombstone after unwrap.
  if (r?.__typename === 'TweetTombstone' || r?.__typename === 'TweetUnavailable') {
    return {
      id: r?.rest_id || null,
      tombstone: r?.tombstone?.text?.text || r?.__typename,
      text: null,
      author: null
    };
  }
  const tweet = r;
  const legacy = tweet?.legacy || {};

  // Note Tweets: long-form. When present, prefer note's entity set for
  // mentions/urls; media still comes from legacy unless note-specific media
  // is present.
  const noteResult = tweet?.note_tweet?.note_tweet_results?.result;
  const noteEntities = noteResult?.entity_set;
  const text = noteResult?.text || legacy?.full_text || null;

  const userResult = tweet?.core?.user_results?.result;
  const userLegacy = userResult?.legacy || {};

  // Retweet unwrap. legacy.retweeted_status_result.result is the original.
  const retweet = tweet?.legacy?.retweeted_status_result?.result;
  const quoted = tweet?.quoted_status_result?.result;

  return {
    id: tweet?.rest_id || legacy?.id_str || null,
    text,
    is_long_form: !!noteResult,
    is_retweet: !!retweet,
    is_quote: !!(legacy?.is_quote_status || quoted),
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
    media: extractMedia(legacy, noteEntities),
    urls: extractUrls(legacy, noteEntities),
    author: {
      id: userResult?.rest_id || null,
      handle: userLegacy?.screen_name || null,
      name: userLegacy?.name || null,
      verified: !!(userResult?.is_blue_verified ?? userLegacy?.verified)
    },
    retweet_of: retweet ? normalizeTweet(retweet) : null,
    quoted: quoted ? normalizeTweet(quoted) : null
  };
}

function extractMedia(legacy, noteEntities) {
  // Note tweets carry media under the note's entity set; legacy media may
  // be empty for long-form posts. Round 2 finding IMP-10: include note
  // media as a fallback so long-form posts don't lose their attachments.
  const fromLegacy = (legacy?.entities?.media || []).map(m => ({
    type: m.type,
    url: m.media_url_https,
    expanded: m.expanded_url
  }));
  if (fromLegacy.length) return fromLegacy;
  const fromNote = (noteEntities?.media || []).map(m => ({
    type: m.type,
    url: m.media_url_https,
    expanded: m.expanded_url
  }));
  return fromNote;
}

function extractUrls(legacy, noteEntities) {
  const src = noteEntities?.urls || legacy?.entities?.urls || [];
  return src.map(u => ({
    short: u.url,
    expanded: u.expanded_url,
    display: u.display_url
  }));
}

// ---- Verb plumbing -----------------------------------------------------

async function login(argv) {
  ensureDeps();
  const { runLogin } = await import('./login.mjs');
  await runLogin({ force: !!argv.flags.force });
}

async function status() {
  const { readBreaker, getProfileDir } = await import('./browser.mjs');
  const dir = getProfileDir();
  const pidfilePath = join(dir, '.skill.pid');
  let pid = null;
  let pidAlive = false;
  if (existsSync(pidfilePath)) {
    pid = parseInt(readFileSync(pidfilePath, 'utf8').trim(), 10);
    if (Number.isFinite(pid)) {
      try { process.kill(pid, 0); pidAlive = true; } catch { pidAlive = false; }
    }
  }
  const b = readBreaker();
  const cookiesPath = join(dir, 'Default', 'Cookies');
  const cookies = existsSync(cookiesPath) ? 'present' : 'missing';
  console.log(JSON.stringify({
    profile_dir: dir,
    pidfile: { pid, alive: pidAlive },
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
  whoami                      Capture Viewer op + return the logged-in user object.
  thread <url-or-id>          Fetch tweet + visible replies. Pass x.com/<handle>/status/<id> URL or bare numeric ID.
  status                      Profile + cookies + breaker + pidfile state.
  reset-breaker               Reset the 24h halt after manual verification.

Read-only contract:
  All fetches go through page.on('response') capture of the X client's organic
  GraphQL traffic. No replay HTTP from us in v1. There are no write verbs
  (post, like, follow, dm). For posting to X, use the zernio-post skill.

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

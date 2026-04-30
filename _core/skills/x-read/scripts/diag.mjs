// diag.mjs -- diagnostic. Probes captured GraphQL ops + extracts a real
// tweet ID from the home timeline (for live testing without hardcoding a URL).
// Also probes legacy REST endpoints (account/settings.json, account/verify_credentials.json).
// Run: node scripts/diag.mjs [--target=home|bookmarks|analytics|profile:<handle>|search:<q>]

import { launchContext } from './browser.mjs';

const argv = process.argv.slice(2);
const targetArg = argv.find(a => a.startsWith('--target='))?.split('=')[1] || 'home';

let navUrl;
if (targetArg === 'home') navUrl = 'https://x.com/home';
else if (targetArg === 'bookmarks') navUrl = 'https://x.com/i/bookmarks';
else if (targetArg === 'analytics') navUrl = 'https://x.com/i/account_analytics';
else if (targetArg.startsWith('profile:')) navUrl = `https://x.com/${targetArg.split(':', 2)[1]}`;
else if (targetArg.startsWith('search:')) navUrl = `https://x.com/search?q=${encodeURIComponent(targetArg.split(':', 2)[1])}&src=typed_query`;
else navUrl = targetArg; // raw URL

console.error(`[diag] target=${targetArg} url=${navUrl}`);

const ctx = await launchContext({ visible: false });
const responses = [];
ctx.page.on('response', (r) => {
  responses.push({ url: r.url(), status: r.status() });
});

try {
  await ctx.page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.error(`[diag] DOMContentLoaded. url=${ctx.page.url()}`);
  // Wait for organic traffic.
  await new Promise(r => setTimeout(r, 8000));
  console.error(`[diag] settled url=${ctx.page.url()}`);

  // Captured GraphQL ops (templates + responses).
  const tpls = ctx.listCapturedOps();
  const resps = ctx.listCapturedResponses();
  console.error(`[diag] graphql templates: ${tpls.length}`);
  console.error(`[diag]   ${tpls.join(', ')}`);
  console.error(`[diag] graphql responses: ${resps.length}`);
  console.error(`[diag]   ${resps.join(', ')}`);

  // For home target: extract first tweet ID from HomeTimeline response.
  if (targetArg === 'home') {
    const home = ctx.getResponse('HomeTimeline');
    if (home && home.body) {
      const tweetIds = [];
      collectStringsByKey(home.body, 'rest_id', tweetIds);
      // Filter to tweet-shaped IDs (they're long numerics; users + tweets share format
      // but tweets typically appear in entries[*].content.itemContent.tweet_results.result.rest_id).
      const tweets = [];
      collectTweetIds(home.body, tweets);
      console.error(`[diag] home: total rest_ids seen=${tweetIds.length}, tweet rest_ids=${tweets.length}`);
      console.error(`[diag] first 5 tweet IDs: ${tweets.slice(0, 5).join(', ')}`);
    } else {
      console.error('[diag] HomeTimeline response not captured');
    }
  }

  // Probe legacy REST endpoints from inside the page context (no replay - just
  // navigate / fetch). For diagnosing what works.
  console.error('[diag] probing legacy REST endpoints from page context...');
  const probe = await ctx.page.evaluate(async () => {
    const urls = [
      '/i/api/1.1/account/settings.json',
      '/i/api/1.1/account/verify_credentials.json',
      '/i/api/2/account/multi/list.json'
    ];
    const out = {};
    for (const u of urls) {
      try {
        const r = await fetch(u, { credentials: 'include' });
        const t = await r.text();
        let body = null;
        try { body = JSON.parse(t); } catch { body = t.slice(0, 200); }
        out[u] = { status: r.status, ok: r.ok, sample: typeof body === 'object' ? Object.keys(body).slice(0, 12) : body };
      } catch (e) {
        out[u] = { error: e.message };
      }
    }
    return out;
  });
  console.error('[diag] REST probe results:');
  console.error(JSON.stringify(probe, null, 2));

  // Show top-level structure of first captured response per op (helps map shape).
  console.error('[diag] response shapes (top-level keys per op):');
  for (const op of resps.slice(0, 20)) {
    const r = ctx.getResponse(op);
    if (!r || !r.body || typeof r.body !== 'object') continue;
    const dataKeys = r.body.data ? Object.keys(r.body.data).slice(0, 6) : [];
    console.error(`  ${op}: status=${r.status} data_keys=[${dataKeys.join(', ')}]`);
  }
} finally {
  await ctx.close();
}

function collectStringsByKey(node, key, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return;
  if (Array.isArray(node)) {
    for (const x of node) collectStringsByKey(x, key, out, depth + 1);
    return;
  }
  for (const k of Object.keys(node)) {
    if (k === key && typeof node[k] === 'string') out.push(node[k]);
    collectStringsByKey(node[k], key, out, depth + 1);
  }
}

// Tweet IDs are nested under tweet_results.result.rest_id specifically.
function collectTweetIds(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return;
  if (Array.isArray(node)) {
    for (const x of node) collectTweetIds(x, out, depth + 1);
    return;
  }
  if (node.tweet_results && node.tweet_results.result && node.tweet_results.result.rest_id) {
    out.push(node.tweet_results.result.rest_id);
  }
  for (const k of Object.keys(node)) {
    collectTweetIds(node[k], out, depth + 1);
  }
}

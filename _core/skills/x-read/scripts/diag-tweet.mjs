// diag-tweet.mjs -- dump a TweetDetail response to find the current author-info path.
import { launchContext } from './browser.mjs';
const tweetId = process.argv[2];
if (!tweetId) { console.error('usage: node scripts/diag-tweet.mjs <tweet-id>'); process.exit(2); }

const ctx = await launchContext({ visible: false });
try {
  await ctx.page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));
  const td = await ctx.waitForResponse('TweetDetail', { timeoutMs: 30000 });
  if (!td || !td.body) { console.error('no TweetDetail captured'); process.exit(3); }
  // Walk to first tweet_results.result.
  function findFirst(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 14) return null;
    if (Array.isArray(node)) {
      for (const x of node) { const h = findFirst(x, depth + 1); if (h) return h; }
      return null;
    }
    if (node.tweet_results && node.tweet_results.result) return node.tweet_results.result;
    for (const k of Object.keys(node)) {
      const h = findFirst(node[k], depth + 1);
      if (h) return h;
    }
    return null;
  }
  const tweet = findFirst(td.body);
  console.log('=== top-level keys on tweet result ===');
  console.log(Object.keys(tweet || {}));
  console.log('\n=== __typename ===', tweet?.__typename);
  console.log('\n=== core keys ===', Object.keys(tweet?.core || {}));
  if (tweet?.core?.user_results?.result) {
    console.log('=== core.user_results.result keys ===', Object.keys(tweet.core.user_results.result));
    console.log('=== core.user_results.result.legacy keys (first 20) ===', Object.keys(tweet.core.user_results.result.legacy || {}).slice(0, 20));
    console.log('=== core.user_results.result.legacy.screen_name ===', tweet.core.user_results.result.legacy?.screen_name);
    console.log('=== core.user_results.result.legacy.name ===', tweet.core.user_results.result.legacy?.name);
  }
  // Also check alternative paths.
  console.log('\n=== alternative user paths probed ===');
  const paths = [
    'core.user_results.result',
    'core.user_result.result',
    'user_results.result',
    'user.user_results.result',
    'tweet.core.user_results.result',
  ];
  for (const p of paths) {
    let cur = tweet;
    for (const seg of p.split('.')) cur = cur?.[seg];
    if (cur) {
      console.log(`HIT ${p}: __typename=${cur.__typename} rest_id=${cur.rest_id} screen_name=${cur.legacy?.screen_name} name=${cur.legacy?.name} core_screen_name=${cur.core?.screen_name} core_name=${cur.core?.name}`);
    }
  }
  // Dump core sub-tree truncated.
  console.log('\n=== core full (truncated to 1500 chars) ===');
  console.log(JSON.stringify(tweet?.core || null, null, 2).slice(0, 1500));
} finally {
  await ctx.close();
}

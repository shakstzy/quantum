// debug.mjs -- diagnostic: launch (visible), goto x.com/home, log every
// response URL for 30s, log final URL + page title + cookies count, close.

import { launchContext } from './browser.mjs';

const argv = process.argv.slice(2);
const visible = !argv.includes('--headless');
console.error(`[debug] visible=${visible}`);

const ctx = await launchContext({ visible });
const responses = [];
ctx.page.on('response', (r) => {
  responses.push({ url: r.url(), status: r.status() });
});
ctx.page.on('framenavigated', (f) => {
  if (f === ctx.page.mainFrame()) console.error(`[debug] main frame -> ${f.url()}`);
});
try {
  console.error('[debug] navigating to x.com/home');
  await ctx.page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.error(`[debug] DOMContentLoaded. url=${ctx.page.url()} title=${await ctx.page.title()}`);
  // wait longer to let X fire its requests
  await new Promise(r => setTimeout(r, 25000));
  console.error(`[debug] after 25s. url=${ctx.page.url()}`);
  const cookies = await ctx.context.cookies();
  console.error(`[debug] cookies for context: ${cookies.length}; x.com cookies: ${cookies.filter(c => c.domain.includes('x.com') || c.domain.includes('twitter.com')).length}`);
  const authTok = cookies.find(c => c.name === 'auth_token');
  console.error(`[debug] auth_token cookie: ${authTok ? `present (domain=${authTok.domain}, expires=${authTok.expires})` : 'MISSING'}`);
  const ct0 = cookies.find(c => c.name === 'ct0');
  console.error(`[debug] ct0 cookie: ${ct0 ? `present (domain=${ct0.domain})` : 'MISSING'}`);
  console.error(`[debug] total responses captured: ${responses.length}`);
  // bucket by host
  const byHost = {};
  for (const r of responses) {
    try { const h = new URL(r.url).hostname; byHost[h] = (byHost[h] || 0) + 1; } catch (_) {}
  }
  console.error(`[debug] hosts: ${JSON.stringify(byHost, null, 2)}`);
  const graphql = responses.filter(r => /\/i\/api\/graphql\//.test(r.url));
  console.error(`[debug] graphql responses: ${graphql.length}`);
  for (const g of graphql.slice(0, 30)) console.error(`  ${g.status} ${g.url}`);
  const apiV2 = responses.filter(r => /\/i\/api\/2\//.test(r.url));
  console.error(`[debug] /i/api/2 responses: ${apiV2.length}`);
  for (const g of apiV2.slice(0, 10)) console.error(`  ${g.status} ${g.url}`);
} finally {
  await ctx.close();
}

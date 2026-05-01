// One-shot: open the persistent grok profile and figure out which endpoint
// proves we're signed in. Writes the answer to /tmp/grok-auth-discovery.json.

import { launchContext } from './browser.mjs';

const ctx = await launchContext({ visible: false });
const out = { tried: [], navigationProbe: null, networkAuthProbe: [], finalUrl: null };

try {
  // Capture network so we can see what grok.com itself calls for auth.
  const authish = [];
  ctx.page.on('request', (req) => {
    const u = req.url();
    if (/auth|session|user|me|whoami|profile|userinfo/i.test(u) && /grok\.com|x\.ai|x\.com/.test(u)) {
      authish.push({ url: u, method: req.method() });
    }
  });

  await ctx.page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ctx.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 4000));

  out.finalUrl = ctx.page.url();
  out.navigationProbe = {
    finalUrl: out.finalUrl,
    redirectedToLogin: /login|sign-?in|accounts\.x\.ai/i.test(out.finalUrl),
    titleSnippet: await ctx.page.title()
  };
  out.networkAuthProbe = authish.slice(0, 30);

  // Brute-force probe a wider set of likely auth endpoints.
  const candidates = [
    'https://grok.com/rest/auth/session',
    'https://grok.com/api/auth/session',
    'https://grok.com/rest/v2/auth/session',
    'https://grok.com/rest/me',
    'https://grok.com/api/me',
    'https://grok.com/rest/user',
    'https://grok.com/api/user',
    'https://grok.com/rest/whoami',
    'https://grok.com/api/whoami',
    'https://grok.com/rest/profile',
    'https://grok.com/api/profile',
    'https://grok.com/rest/v2/me',
    'https://grok.com/rest/userinfo',
    'https://accounts.x.ai/api/me',
    'https://accounts.x.ai/api/user',
    'https://accounts.x.ai/api/auth/session',
    'https://accounts.x.ai/rest/auth/session',
    'https://api.x.ai/me',
    'https://grok.com/rest/app-chat/conversations',
    'https://grok.com/rest/app-chat/users/me',
    'https://grok.com/rest/customer/info',
    'https://grok.com/rest/billing/me',
    'https://grok.com/rest/rate-limits',
    'https://grok.com/api/rate-limits'
  ];
  for (const url of candidates) {
    const r = await ctx.page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } });
        const text = await r.text();
        return { status: r.status, contentType: r.headers.get('content-type'), bodyPreview: (text || '').slice(0, 600) };
      } catch (e) { return { error: e.message }; }
    }, url);
    out.tried.push({ url, ...r });
    if (r.status === 200 && /json/i.test(r.contentType || '')) {
      out.tried[out.tried.length - 1].matched = true;
    }
  }
} finally {
  await ctx.close();
}

const path = '/tmp/grok-auth-discovery.json';
const { writeFileSync } = await import('node:fs');
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(path);

// One-shot: discover grok.com's chat-completion endpoint and stream shape.
// Drives the UI with the live-discovered selectors, captures every network
// request between submit and stream-complete, dumps it to /tmp/grok-chat-discovery.json.

import { launchContext } from './browser.mjs';
import { writeFileSync } from 'node:fs';

const ctx = await launchContext({ visible: false });
const out = { requests: [], responses: [], wsStreams: [], chatLikePosts: [], assistantText: null };

ctx.page.on('request', (req) => {
  out.requests.push({ url: req.url(), method: req.method(), resourceType: req.resourceType(), t: Date.now() });
});
ctx.page.on('response', async (res) => {
  try {
    const ct = res.headers()['content-type'] || '';
    const url = res.url();
    const method = res.request().method();
    const status = res.status();
    const r = { url, method, status, contentType: ct, t: Date.now() };
    if (method === 'POST' || /chat|message|conversation|completion|stream/i.test(url)) {
      // Capture the body for chat-shaped requests.
      try {
        const text = await res.text();
        r.bodyPreview = (text || '').slice(0, 4000);
        r.bodyLen = text?.length || 0;
      } catch (e) { r.bodyError = e.message; }
      out.chatLikePosts.push(r);
    }
    out.responses.push(r);
  } catch (_) {}
});
ctx.page.on('websocket', (ws) => {
  const url = ws.url();
  const entry = { url, openedAt: Date.now(), frames: [] };
  out.wsStreams.push(entry);
  ws.on('framereceived', (data) => {
    const payload = typeof data === 'object' && data?.payload != null ? data.payload : data;
    entry.frames.push({ dir: 'in', preview: typeof payload === 'string' ? payload.slice(0, 400) : `<binary ${payload?.length}>`, t: Date.now() });
  });
  ws.on('framesent', (data) => {
    const payload = typeof data === 'object' && data?.payload != null ? data.payload : data;
    entry.frames.push({ dir: 'out', preview: typeof payload === 'string' ? payload.slice(0, 400) : '<binary>', t: Date.now() });
  });
  ws.on('close', () => { entry.closedAt = Date.now(); });
});

try {
  await ctx.page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ctx.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  // Click the live-discovered composer.
  const composer = await ctx.page.$('[contenteditable="true"]');
  if (!composer) throw new Error('composer not found');
  await composer.click();
  await ctx.page.keyboard.type('Hi! Reply with just the word "test" and nothing else.', { delay: 6 });
  await new Promise(r => setTimeout(r, 800));

  // Wait for the send button to be enabled + visible.
  const sendDeadline = Date.now() + 10000;
  let sent = false;
  while (Date.now() < sendDeadline && !sent) {
    const sendBtn = await ctx.page.$('[data-testid="chat-submit"]');
    if (sendBtn) {
      const enabled = await sendBtn.isEnabled().catch(() => false);
      const visible = await sendBtn.isVisible().catch(() => false);
      if (enabled && visible) {
        await sendBtn.click({ timeout: 3000 });
        sent = true;
        out.sentVia = 'chat-submit-button';
        break;
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  if (!sent) {
    // Cmd+Enter fallback (Tiptap submit shortcut, since requireCmdEnterToSubmit
    // is the option but it's the standard Tiptap submit binding).
    await ctx.page.keyboard.press('Meta+Enter');
    out.sentVia = 'cmd-enter';
  }

  // Give the stream up to 60s to complete.
  await new Promise(r => setTimeout(r, 60000));

  // Scrape final assistant text from DOM as ground truth.
  out.assistantText = await ctx.page.evaluate(() => {
    const sels = ['[data-message-author-role="assistant"]', '[role="article"]', 'main article'];
    for (const sel of sels) {
      const els = document.querySelectorAll(sel);
      if (els.length) {
        const last = els[els.length - 1];
        return (last.innerText || '').trim().slice(0, 2000);
      }
    }
    return null;
  });

  // Capture the URL we ended on (to see if conversation was created).
  out.finalUrl = ctx.page.url();

} catch (e) {
  out.error = e.message;
  try { out.errorStack = e.stack?.slice(0, 1000); } catch (_) {}
} finally {
  try { await ctx.close(); } catch (_) {}
}

writeFileSync('/tmp/grok-chat-discovery.json', JSON.stringify(out, null, 2));
console.log('/tmp/grok-chat-discovery.json');
console.log('chatLikePosts:', out.chatLikePosts.length, 'wsStreams:', out.wsStreams.length, 'finalUrl:', out.finalUrl);
console.log('sentVia:', out.sentVia, 'assistantText:', (out.assistantText || '').slice(0, 100));

#!/usr/bin/env node
// diagnose.mjs -- visible-mode diagnostic for the discord skill.
// Launches Chrome visibly with the QUANTUM profile, navigates to
// discord.com/channels/@me, polls for token capture every 2s for 60s,
// reports final URL and whether Discord's client made an authenticated
// API call. Saves a screenshot to scripts/diagnose-screenshot.png.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { launchContext, pageApi, waitForCapturedToken } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOT_PATH = join(HERE, 'diagnose-screenshot.png');

console.error('[diagnose] launching VISIBLE Chrome with QUANTUM profile.');
console.error('[diagnose] watch the window. it will navigate to discord.com/channels/@me.');

const ctx = await launchContext({ visible: true });
const page = ctx.page;

let urlAfterGoto = null;
let networkLog = [];
page.on('request', r => {
  const u = r.url();
  if (u.includes('discord.com/api/')) {
    networkLog.push({ method: r.method(), url: u, ts: Date.now() });
  }
});

try {
  await page.goto('https://discord.com/channels/@me', { waitUntil: 'domcontentloaded', timeout: 30000 });
  urlAfterGoto = page.url();
  console.error(`[diagnose] after goto: ${urlAfterGoto}`);

  console.error('[diagnose] polling for captured token (60s)...');
  const tok = await waitForCapturedToken(page, { timeoutMs: 60000, probeEveryMs: 2000 });
  const finalUrl = page.url();
  console.error(`[diagnose] final url: ${finalUrl}`);
  console.error(`[diagnose] token captured: ${tok ? 'YES (' + tok.length + ' chars)' : 'NO'}`);
  console.error(`[diagnose] discord.com/api/* requests seen: ${networkLog.length}`);
  if (networkLog.length) {
    networkLog.slice(0, 8).forEach(r => console.error(`  - ${r.method} ${r.url}`));
  }

  // Try to inspect the page for clues.
  const pageState = await page.evaluate(() => ({
    location: window.location.href,
    hasToken: !!window.__quantumDiscordToken,
    cookies_doc: document.cookie ? document.cookie.length : 0,
    hasServiceWorker: !!navigator.serviceWorker,
    swActive: navigator.serviceWorker && navigator.serviceWorker.controller ? true : false,
    title: document.title,
    bodyText: (document.body && document.body.innerText || '').slice(0, 200)
  })).catch(e => ({ error: e.message }));
  console.error('[diagnose] page state:', JSON.stringify(pageState, null, 2));

  try {
    await page.screenshot({ path: SHOT_PATH, fullPage: false });
    console.error(`[diagnose] screenshot saved: ${SHOT_PATH}`);
  } catch (e) {
    console.error(`[diagnose] screenshot failed: ${e.message}`);
  }

  if (tok) {
    console.error('[diagnose] manual probe: GET /users/@me with captured token...');
    const probe = await pageApi(page, 'GET', '/api/v9/users/@me');
    console.error(`[diagnose] probe status: ${probe.status}, ok: ${probe.ok}`);
    if (probe.ok) console.error(`[diagnose] signed in as: ${probe.body?.username} (${probe.body?.id})`);
  }
} finally {
  console.error('[diagnose] closing in 3s; review the visible window before close.');
  await new Promise(r => setTimeout(r, 3000));
  await ctx.close();
}

// ui-submit.mjs -- drive the Higgsfield UI to submit a job.
// The page's own Generate click fires a POST that includes DataDome's full JS stack
// (clientid, timing signals, sig headers). Replicating that outside the page is
// infeasible, so we let the page do it, then capture the response for the job_uuid.

import { transition } from './state.mjs';
import { hasCaptchaInDom, trigger403Breaker } from './browser.mjs';
import { pause, pauseJitter } from './behavior.mjs';
import { extractUserIdFromJwt } from './jwt.mjs';
import { unwrapImagesHiggsProxy } from './download.mjs';

// Wait for a fnf.higgsfield.ai POST response that returns a job_uuid-shaped body.
// Returns { job_uuid, raw } or throws.
let __hfSubmitSeq = 0;
async function waitForJobPostResponse(context, slug, { timeoutMs = 30000 } = {}) {
  const seq = ++__hfSubmitSeq;
  if (process.env.HF_DEBUG === '1') console.error(`[ui-submit] waitForJobPostResponse seq=${seq} slug=${slug}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      context.off('response', handler);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for POST /jobs/${slug} response.`));
    }, timeoutMs);

    // Match /jobs[/v2]/<slug> at end of path so we only accept the response
    // for THIS submit's slug. A loose /\/jobs\// match picks up unrelated
    // /jobs/search or cached-history endpoints returning stale job ids.
    // Slug casing varies on the server: some live URLs use hyphens
    // (/jobs/nano-banana-2) and others underscores (/jobs/v2/cinematic_studio_image).
    // We accept EITHER form by building a pattern that treats `_` and `-` as
    // interchangeable in the slug segment.
    const slugAny = slug.replace(/[_-]/g, '[_-]');
    const slugRe = new RegExp(`/jobs(?:/v\\d+)?/${slugAny}(?:[/?#]|$)`);
    const slugNormalized = slug; // kept for log messages only
    const handler = async resp => {
      try {
        const req = resp.request();
        if (req.method() !== 'POST') return;
        const u = new URL(resp.url());
        if (process.env.HF_DEBUG === '1' && /higgsfield\.ai/.test(u.hostname)) {
          console.error(`[ui-submit] seq=${seq} POST ${u.hostname}${u.pathname} status=${resp.status()}`);
        }
        if (u.hostname !== 'fnf.higgsfield.ai') return;
        if (!slugRe.test(u.pathname)) {
          if (process.env.HF_DEBUG === '1' && /\/jobs\//.test(u.pathname)) {
            console.error(`[ui-submit] seq=${seq} non-match POST ${u.pathname} status=${resp.status()} (awaiting /jobs/${slugNormalized})`);
          }
          return;
        }
        if (process.env.HF_DEBUG === '1') console.error(`[ui-submit] candidate POST ${u.pathname} status=${resp.status()}`);

        const status = resp.status();
        if (status === 403) {
          clearTimeout(timer);
          context.off('response', handler);
          trigger403Breaker();
          const err = new Error(`403 from page's own POST ${u.pathname}. DataDome flagged the profile or IP.`);
          err.code = 'UI_SUBMIT_403';
          reject(err);
          return;
        }
        if (status >= 500) {
          clearTimeout(timer);
          context.off('response', handler);
          const err = new Error(`Server ${status} on POST ${u.pathname}.`);
          err.code = 'UI_SUBMIT_5XX';
          reject(err);
          return;
        }
        if (!resp.ok()) {
          // Log and wait; some endpoints return 4xx for unrelated calls, keep listening
          return;
        }
        const body = await resp.text().catch(() => null);
        if (!body) return;
        let j = null;
        try { j = JSON.parse(body); } catch (_) { return; }
        if (process.env.HF_DEBUG === '1') {
          // Redact CDN URLs and any token-shaped fields so HF_DEBUG logs cannot leak signed URLs / cookies.
          const redacted = JSON.stringify(j, (k, v) => {
            if (typeof v !== 'string') return v;
            if (/^https?:\/\//i.test(v)) return '<URL>';
            if (/^(eyJ|sess_|tok_|bearer\s)/i.test(v)) return '<TOKEN>';
            return v;
          }).slice(0, 400);
          console.error(`[ui-submit] seq=${seq} response body keys=${Object.keys(j || {}).join(',')} body=${redacted}`);
        }
        // Higgsfield's POST /jobs/<slug> response is:
        //   { id: <project_id (stable per session)>, job_sets: [{ id: <per-submit job id> }], ... }
        // The per-submit id lives in job_sets[0].id, NOT the outer id. Outer id is
        // the project and is identical across submits within a session.
        const uuid = j?.job_sets?.[0]?.id || j?.job_id || j?.job?.id || j?.id || j?.data?.id;
        if (!uuid) return; // Probably not a job-submit response
        clearTimeout(timer);
        context.off('response', handler);
        resolve({ job_uuid: uuid, raw: j, path: u.pathname });
      } catch (_) {}
    };
    context.on('response', handler);
  });
}

const DEFAULT_PROMPT_SELECTORS = [
  'div[role="textbox"][contenteditable="true"]',
  'textarea[placeholder*="Describe the scene you imagine"]',
  'textarea[placeholder*="Describe"]',
  'textarea[placeholder*="scene"]',
  'textarea',
  '[contenteditable="true"]'
];

// Resolve the first matching selector that exists on the page.
async function resolvePromptSelector(page, override) {
  const list = override
    ? (Array.isArray(override) ? override : [override, ...DEFAULT_PROMPT_SELECTORS])
    : DEFAULT_PROMPT_SELECTORS;
  for (const s of list) {
    if (await page.$(s)) return s;
  }
  return null;
}

// Given an ElementHandle to a textarea or contenteditable, clear and type fresh content.
// Uses focus() instead of click() because overlays (sticky header, hover flyouts)
// often intercept the click point for inputs nested deep in the layout.
async function replacePromptContentEl(page, el, text) {
  if (!el) throw new Error('Prompt element not found.');
  // Move mouse off any hover-sensitive nav elements first
  await page.mouse.move(10, 10);
  await pause(100);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.focus();
  await pause(150);
  const isMac = process.platform === 'darwin';
  const meta = isMac ? 'Meta' : 'Control';
  await page.keyboard.down(meta);
  await page.keyboard.press('a');
  await page.keyboard.up(meta);
  await pause(100);
  await page.keyboard.press('Backspace');
  await pause(200);
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 20 + Math.floor(Math.random() * 60) });
  }
}

// Among all elements matching the prompt selector, pick the one most in-viewport.
// Returns { handle, anchor: { cx, cy } } where cx/cy are viewport center coords.
async function selectVisiblePromptAnchor(page, selector) {
  const handles = await page.$$(selector);
  if (handles.length === 0) throw new Error(`No element found for selector: ${selector}`);
  if (handles.length === 1) {
    const a = await handles[0].evaluate(el => {
      const r = el.getBoundingClientRect();
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });
    return { handle: handles[0], anchor: a };
  }
  // Rank by viewport-intersection area (how much of the element is visible).
  const ranked = await Promise.all(handles.map(async (h, i) => {
    const score = await h.evaluate(el => {
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const visArea = ix * iy;
      const totalArea = Math.max(1, r.width * r.height);
      return { visRatio: visArea / totalArea, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });
    return { i, handle: h, ...score };
  }));
  ranked.sort((a, b) => b.visRatio - a.visRatio);
  const best = ranked[0];
  return { handle: best.handle, anchor: { cx: best.cx, cy: best.cy } };
}

// Core driver: fills prompt, clicks Generate, returns { job_uuid }
// When multiple prompt inputs or Generate buttons exist on the page (cinema-studio
// renders both Image and Video panels simultaneously), the correct pair is chosen
// by proximity: we pick the prompt input most visible in viewport, then the Generate
// button geometrically closest to it.
export async function submitViaUI(page, context, runDir, {
  slug,
  prompt,
  promptSelector = null,
  generateSelector = 'button:has-text("Generate")',
  responseTimeoutMs = 30000,
  expectedCost = null
}) {
  await transition(runDir, 'pending', {});

  // Verify no captcha
  if (await hasCaptchaInDom(page)) {
    await transition(runDir, 'datadome_flagged', { error: 'captcha visible before UI submit' });
    const err = new Error('Captcha visible pre-submit.');
    err.code = 'DATADOME_VISIBLE';
    throw err;
  }

  // Auto-resolve prompt selector across variants (image page uses contenteditable div, video uses textarea)
  const resolvedPromptSel = await resolvePromptSelector(page, promptSelector);
  if (!resolvedPromptSel) {
    const err = new Error('No prompt input found (tried: div[role=textbox], textarea variants).');
    err.code = 'UI_NO_PROMPT';
    throw err;
  }

  // Pick the most-visible prompt element (matters on cinema-studio where the DOM
  // contains both image-panel and video-panel prompts simultaneously).
  const promptAnchor = await selectVisiblePromptAnchor(page, resolvedPromptSel);

  // Fill prompt (replaces any existing content) using the resolved anchor element.
  await replacePromptContentEl(page, promptAnchor.handle, prompt);
  await pauseJitter();

  // Arm the response listener BEFORE clicking
  const responsePromise = waitForJobPostResponse(context, slug, { timeoutMs: responseTimeoutMs });

  // Click Generate. Require <button>, visible, text starts with "Generate", not disabled.
  // When multiple exist, pick the one closest to the prompt we just filled (same panel).
  // Fall back to largest-by-area if no prompt anchor.
  //
  // Cinema-studio renders TWO overlapping Generate buttons (one per mode
  // panel). To steer clicks to the right one, callers pass `expectedCost`
  // (e.g. 2 for cinema-image, 96 for cinema-video). We filter candidates to
  // buttons whose innerText line-2 matches that number first, then pick by
  // proximity among matches.
  const genBtn = await page.evaluateHandle(({ anchor, cost }) => {
    const candidates = Array.from(document.querySelectorAll('button')).filter(b => {
      const t = (b.innerText || '').trim();
      if (!/^generate\b/i.test(t)) return false;
      const r = b.getBoundingClientRect();
      return r.width > 40 && r.height > 20 && window.getComputedStyle(b).visibility !== 'hidden' && !b.disabled;
    });
    if (candidates.length === 0) return null;
    // Cost filter: keep only buttons whose line-2 parses as the expected cost
    // (if any match). If none match (e.g. page doesn't display cost), skip
    // the filter.
    let pool = candidates;
    if (cost != null) {
      const costMatch = candidates.filter(b => {
        const lines = (b.innerText || '').trim().split('\n').map(s => s.trim());
        const n = parseInt(lines[1] || '', 10);
        return isFinite(n) && n === cost;
      });
      if (costMatch.length > 0) pool = costMatch;
    }
    // Among the pool, prefer the LARGEST-by-area (outer wrapper; cinema
    // renders nested Generate <button>s where the inner span carries the text
    // but clicks don't fire the submit). Tiebreak by proximity to the prompt.
    pool.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const areaDiff = (rb.width * rb.height) - (ra.width * ra.height);
      if (Math.abs(areaDiff) > 200) return areaDiff;
      if (!anchor) return 0;
      const da = Math.hypot((ra.x + ra.width / 2) - anchor.cx, (ra.y + ra.height / 2) - anchor.cy);
      const db = Math.hypot((rb.x + rb.width / 2) - anchor.cx, (rb.y + rb.height / 2) - anchor.cy);
      return da - db;
    });
    return pool[0];
  }, { anchor: promptAnchor.anchor, cost: expectedCost });
  const genBtnElement = genBtn.asElement ? genBtn.asElement() : null;
  if (!genBtnElement) {
    await transition(runDir, 'failed', { error: 'Generate button not found (no visible <button> starting with "Generate")' });
    const err = new Error('Generate button not found.');
    err.code = 'UI_NO_GEN_BUTTON';
    throw err;
  }
  if (process.env.HF_DEBUG === '1') {
    const chosen = await genBtnElement.evaluate(el => {
      const r = el.getBoundingClientRect();
      return { text: (el.innerText || '').trim().slice(0, 60), xywh: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
    });
    console.error(`[ui-submit] chose Generate: "${chosen.text}" xywh=${JSON.stringify(chosen.xywh)} prompt-anchor=(${Math.round(promptAnchor.anchor.cx)},${Math.round(promptAnchor.anchor.cy)}) using-slug=${slug}`);
  }
  // Move mouse off any hover-sensitive nav, scroll button into view, then force-click
  // (bypass hit-testing so header overlays can't intercept the submit).
  await page.mouse.move(10, 10);
  await pause(150);
  await genBtnElement.scrollIntoViewIfNeeded().catch(() => {});
  await pause(100);
  await genBtnElement.click({ timeout: 10000, force: true });

  let result;
  try {
    result = await responsePromise;
  } catch (e) {
    await transition(runDir, 'failed', { error: e.message });
    throw e;
  }

  await transition(runDir, 'submitted', { job_uuid: result.job_uuid, submit_path: result.path });
  return result;
}

// Toggle the "Unlimited" switch ON if the user has unlim plan access.
// Detects by looking for a label like "Unlimited" adjacent to a switch/checkbox and
// flips it if currently off. Idempotent: returns 'already_on' / 'turned_on' / 'not_found'.
// After this toggle, Generate button cost flips from N credits to 0 (free gen from unlim pool).
export async function enableUnlimitedToggle(page) {
  return page.evaluate(() => {
    // Find elements labeled "Unlimited" (exact or start-of-line)
    const labels = Array.from(document.querySelectorAll('label, span, div, p'))
      .filter(el => {
        const t = (el.innerText || '').trim();
        return t === 'Unlimited' || /^Unlimited(\s|$)/.test(t);
      });
    for (const label of labels) {
      // Walk up to the nearest container that also holds a switch/checkbox
      let container = label.parentElement;
      for (let i = 0; i < 4 && container; i++) {
        const sw = container.querySelector('button[role="switch"], input[type="checkbox"], [role="switch"]');
        if (sw) {
          const wasOn = sw.getAttribute('aria-checked') === 'true' || sw.checked === true || /checked|bg-primary|on/i.test(sw.className || '');
          if (wasOn) return 'already_on';
          sw.click();
          return 'turned_on';
        }
        container = container.parentElement;
      }
    }
    return 'not_found';
  });
}

// Open the History panel (the button toggles a drawer, doesn't navigate)
// so that our freshly-generated images populate into the DOM.
export async function openHistoryPanel(page) {
  try {
    const btn = await page.$('button:has-text("History")');
    if (btn) {
      const isActive = await btn.evaluate(el => /active|selected/i.test(el.className || ''));
      if (!isActive) {
        await btn.click();
        await pause(800);
      }
    }
  } catch (_) {}
}

// Scrape DOM for all assets owned by this user (per JWT sub). Covers <img>, <video>,
// <source>, <a href>, data-* attrs, AND the full innerHTML (which often has URLs in
// React state / lazy-load payloads that haven't mounted as elements yet).
// Host allowlist: cloudfront.net (image CDN) + cdn.higgsfield.ai (video CDN).
// Returns array of { raw, cdn, timestamp, uuid, ext, kind } sorted newest-first.
// When the CDN URL is a *_thumbnail.webp for a video, we attach `derivedMp4Url` so callers can download the real mp4.
const USER_ASSET_HOSTS = ['cloudfront.net', 'cdn.higgsfield.ai'];

// Videos: thumbnail sits on cdn.higgsfield.ai; the full mp4 sits on the image CloudFront
// bucket (d8j0ntlcm91z4.cloudfront.net) with the same uuid, no suffix, .mp4 extension.
const VIDEO_MP4_CDN_HOST = 'd8j0ntlcm91z4.cloudfront.net';

function deriveFullAssetUrl(thumbnailUrl) {
  const m = thumbnailUrl.match(/^https:\/\/([^/]+)\/(user_[A-Za-z0-9_-]+)\/hf_(\d{8})_(\d{6})_([a-f0-9-]{36})_(thumbnail|preview|min)\.(webp|jpg|jpeg|png)(\?.*)?$/i);
  if (!m) return null;
  const [, , userFolder, date, time, uuid, suffix] = m;
  if (suffix === 'thumbnail' || suffix === 'preview') {
    // Full mp4 on the CloudFront bucket (different host from thumbnail)
    return `https://${VIDEO_MP4_CDN_HOST}/${userFolder}/hf_${date}_${time}_${uuid}.mp4`;
  }
  // `_min.webp` is still full-resolution for images (webp-compressed), no derived URL needed
  return null;
}

export async function scrapeUserAssets(page, userSubstr) {
  const rawUrls = await page.evaluate(() => {
    const urls = new Set();
    document.querySelectorAll('img').forEach(el => { if (el.src) urls.add(el.src); });
    document.querySelectorAll('video').forEach(el => {
      if (el.src) urls.add(el.src);
      if (el.poster) urls.add(el.poster);
      el.querySelectorAll('source').forEach(s => { if (s.src) urls.add(s.src); });
    });
    document.querySelectorAll('audio').forEach(el => {
      if (el.src) urls.add(el.src);
      el.querySelectorAll('source').forEach(s => { if (s.src) urls.add(s.src); });
    });
    document.querySelectorAll('a[href]').forEach(el => { if (el.href) urls.add(el.href); });
    document.querySelectorAll('[data-src],[data-video-src],[data-url]').forEach(el => {
      for (const name of ['data-src', 'data-video-src', 'data-url']) {
        const v = el.getAttribute(name);
        if (v) urls.add(v);
      }
    });
    // Regex-scan full HTML for cdn.higgsfield.ai + cloudfront URLs that the React lazy-load
    // hasn't mounted yet (video thumbnails sit in React state before being rendered).
    const html = document.body?.innerHTML || '';
    const urlRe = /https:\/\/(?:[\w-]+\.)?(?:cloudfront\.net|cdn\.higgsfield\.ai)\/[^"'\s<>)]+/g;
    for (const m of html.matchAll(urlRe)) urls.add(m[0]);
    return [...urls];
  });
  const out = [];
  for (const raw of rawUrls) {
    const cdn = unwrapImagesHiggsProxy(raw);
    if (!cdn) continue;
    if (!USER_ASSET_HOSTS.some(h => cdn.includes(h))) continue;
    if (!cdn.includes('/user_' + userSubstr)) continue;
    const m = cdn.match(/\/hf_(\d{8})_(\d{6})_([a-f0-9-]{36})(?:_([a-z]+))?\.([a-z0-9]+)/i);
    const ts = m ? m[1] + m[2] : '';
    const uuid = m ? m[3] : '';
    const suffix = m ? (m[4] || '') : '';
    const ext = m ? m[5] : '';
    // Determine kind: mp4/mov/webm = video; png/jpg/webp = image (unless suffix indicates thumbnail)
    let kind;
    if (['mp4', 'mov', 'webm'].includes(ext.toLowerCase())) kind = 'video';
    else if (suffix === 'thumbnail' || suffix === 'preview') kind = 'video_thumbnail';
    else kind = 'image';
    const derivedMp4Url = (kind === 'video_thumbnail') ? deriveFullAssetUrl(cdn) : null;
    out.push({ raw, cdn, timestamp: ts, uuid, ext, suffix, kind, derivedMp4Url });
  }
  // Dedup by underlying (uuid, ts) so a thumbnail and its mp4 don't both count as separate assets
  const seen = new Map();
  for (const a of out) {
    const key = a.uuid && a.timestamp ? `${a.timestamp}_${a.uuid}` : a.cdn;
    const existing = seen.get(key);
    // Prefer full videos over thumbnails; full-resolution images over min variants
    if (!existing) { seen.set(key, a); continue; }
    const rank = r => r.kind === 'video' ? 3 : r.kind === 'image' ? 2 : 1;
    if (rank(a) > rank(existing)) seen.set(key, a);
  }
  const uniq = [...seen.values()];
  uniq.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  return uniq;
}

// Back-compat alias
export const scrapeUserImages = scrapeUserAssets;

// Wait until we observe N new user-owned images that weren't present pre-submit.
// Returns the new images (oldest-first in submission order, newest-last).
// requireKind: 'video' | 'image' | null. Video-kind includes video_thumbnail (we'll download the derived mp4).
export async function waitForNewAssets(page, userSub, preExistingSet, {
  expectCount = 1, timeoutMs = 5 * 60 * 1000, pollMs = 3000, requireKind = null
} = {}) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeoutMs) {
    await openHistoryPanel(page);
    const all = await scrapeUserAssets(page, userSub);
    let fresh = all.filter(a => !preExistingSet.has(a.cdn) && !preExistingSet.has(a.derivedMp4Url || ''));
    if (requireKind === 'video') {
      fresh = fresh.filter(a => a.kind === 'video' || a.kind === 'video_thumbnail');
    } else if (requireKind === 'image') {
      fresh = fresh.filter(a => a.kind === 'image');
    }
    if (fresh.length >= expectCount) return fresh.slice(0, expectCount);
    last = fresh;
    await pause(pollMs);
  }
  const err = new Error(`Timed out waiting for ${expectCount} new asset(s). Observed ${last.length} fresh during wait.`);
  err.code = 'UI_POLL_TIMEOUT';
  throw err;
}

// Given a scraped asset, resolve the BEST download URL (prefer full mp4 over thumbnail).
export function bestDownloadUrl(asset) {
  if (asset.kind === 'video_thumbnail' && asset.derivedMp4Url) return asset.derivedMp4Url;
  return asset.cdn;
}

// Back-compat alias
export const waitForNewImages = waitForNewAssets;

// Helper: extract the user_id substring used in CloudFront URLs from the captured JWT.
// Returns the raw `sub` value (e.g. "user_2uomBLAH") so we can use it as a search substring.
export function userIdFromJwtCapture(jwtCapture) {
  if (!jwtCapture?.token) return null;
  const payload = extractUserIdFromJwt(jwtCapture.token);
  return payload?.user_id || null;
}

// ---------------------------------------------------------------------------
// Generic picker + upload helpers
// ---------------------------------------------------------------------------
// Higgsfield's config bar uses pill buttons whose innerText line-1 is the
// current selection (e.g. "3:4", "1K", "1/4", "Nano Banana Pro"). Clicking
// the pill opens a dropdown of option tiles; each tile's line-1 is the value.
// selectPicker finds a pill by any of a set of candidate line-1 labels
// (since the pill label changes to the current selection), opens it, then
// clicks the option whose line-1 matches the target.

// Find a config-bar pill whose line-1 text is one of candidateLabels.
// anchor is the prompt element's center; pills are constrained to MAX_PILL_DIST
// px of the anchor. On Higgsfield tool pages the config-bar pills sit in the
// same row as the prompt (typical distance 30-400 px). 300 px is tight enough to
// reject history-card chips and loose enough to cover the full config bar.
const MAX_PILL_DIST = 300;
// Options in an opened dropdown render adjacent to the pill. The listbox can
// be ~600 px tall (aspect picker) or ~800 px (model picker); 900 px fits both.
const MAX_OPTION_DIST = 900;
async function findConfigPillByLabels(page, candidateLabels, { anchor = null, maxDist = null } = {}) {
  const md = maxDist || MAX_PILL_DIST;
  return page.evaluateHandle(({ labels, anc, maxDist }) => {
    const vh = window.innerHeight;
    const all = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => {
      const r = b.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return false;
      if (window.getComputedStyle(b).visibility === 'hidden') return false;
      const t = (b.innerText || '').trim();
      const line1 = t.split('\n')[0].trim();
      return labels.includes(line1);
    });
    if (all.length === 0) return null;
    // Viewport filter.
    const inViewport = all.filter(b => {
      const r = b.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      return cy >= 0 && cy <= vh;
    });
    let pool = inViewport.length > 0 ? inViewport : all;
    if (anc) {
      // Proximity filter: drop pills further than maxDist from the prompt anchor.
      const near = pool.filter(b => {
        const r = b.getBoundingClientRect();
        const d = Math.hypot((r.x + r.width / 2) - anc.cx, (r.y + r.height / 2) - anc.cy);
        return d <= maxDist;
      });
      if (near.length > 0) pool = near;
      pool.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const da = Math.hypot((ra.x + ra.width / 2) - anc.cx, (ra.y + ra.height / 2) - anc.cy);
        const db = Math.hypot((rb.x + rb.width / 2) - anc.cx, (rb.y + rb.height / 2) - anc.cy);
        return da - db;
      });
    } else {
      // No anchor available: prefer the pill nearest the bottom of the visible area
      // (the config bar always sits near the bottom on Higgsfield pages).
      pool.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return rb.bottom - ra.bottom;
      });
    }
    return pool[0];
  }, { labels: candidateLabels, anc: anchor, maxDist: md });
}

// Find the option in an opened dropdown matching `label`. Strongly prefers
// elements inside a role="listbox"/"menu"/"dialog" container (Radix picker
// primitive), since that's where Higgsfield's picker options live. Falls back
// to loose proximity only if no container-scoped match. Returns a Playwright
// ElementHandle so the caller can click it through synthetic events.
async function findDropdownOptionHandle(page, label, pillAnchor = null) {
  return page.evaluateHandle(({ lbl, anc, maxDist }) => {
    // First pass: search inside any open picker container.
    const containers = Array.from(document.querySelectorAll(
      '[role="listbox"], [role="menu"], [role="dialog"], [data-state="open"]'
    )).filter(c => {
      const r = c.getBoundingClientRect();
      return r.width > 40 && r.height > 40;
    });
    const containerMatches = [];
    for (const c of containers) {
      const opts = Array.from(c.querySelectorAll('[role="option"], [role="menuitem"], button, li, div'));
      for (const el of opts) {
        const t = (el.innerText || '').trim();
        if (!t) continue;
        const line1 = t.split('\n')[0].trim();
        if (line1 !== lbl) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) continue;
        if (window.getComputedStyle(el).visibility === 'hidden') continue;
        containerMatches.push({ el, r, role: el.getAttribute('role') });
      }
    }
    // Prefer [role="option"] / [role="menuitem"] over generic div/span inside
    // the same container -- clicking the semantic element triggers the
    // listbox's select handler in Radix.
    containerMatches.sort((a, b) => {
      const rank = m => (m.role === 'option' || m.role === 'menuitem') ? 0 : 1;
      return rank(a) - rank(b);
    });
    if (containerMatches.length > 0) return containerMatches[0].el;
    // Fallback: no container found. Loose viewport + proximity search (same as
    // before), for pages that don't use ARIA roles on their pickers.
    const vh = window.innerHeight;
    const candidates = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], li, div'));
    const matches = [];
    for (const el of candidates) {
      const t = (el.innerText || '').trim();
      if (!t) continue;
      const line1 = t.split('\n')[0].trim();
      if (line1 !== lbl) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) continue;
      if (window.getComputedStyle(el).visibility === 'hidden') continue;
      const cls = (el.className || '').toString();
      const role = el.getAttribute('role');
      const tag = el.tagName;
      const looksClickable = tag === 'BUTTON' || role === 'menuitem' || role === 'option'
        || role === 'button' || /cursor-pointer|hover:|menuitem|popover|option/i.test(cls);
      if (!looksClickable) continue;
      matches.push({ el, r });
    }
    if (matches.length === 0) return null;
    const inView = matches.filter(({ r }) => {
      const cy = r.top + r.height / 2;
      return cy >= 0 && cy <= vh;
    });
    let pool = inView.length > 0 ? inView : matches;
    if (anc) {
      const near = pool.filter(({ r }) => {
        const d = Math.hypot((r.x + r.width / 2) - anc.cx, (r.y + r.height / 2) - anc.cy);
        return d <= maxDist;
      });
      if (near.length > 0) pool = near;
      pool.sort((a, b) => {
        const da = Math.hypot((a.r.x + a.r.width / 2) - anc.cx, (a.r.y + a.r.height / 2) - anc.cy);
        const db = Math.hypot((b.r.x + b.r.width / 2) - anc.cx, (b.r.y + b.r.height / 2) - anc.cy);
        return da - db;
      });
    }
    return pool[0].el;
  }, { lbl: label, anc: pillAnchor, maxDist: MAX_OPTION_DIST });
}

// Open the pill whose current label is one of `currentLabels`, then click the option
// whose line-1 text equals `target`. Returns 'already_selected' | 'selected' |
// 'trigger_not_found' | 'option_not_found'. Idempotent if target is already current.
//
// anchor: optional { cx, cy } to prefer pills near a specific panel (used by cinema).
// Select a picker by opening its pill and clicking the target option.
// Flow: resolve prompt anchor -> find pill near anchor -> check if pill's
// current label already equals target (shortcut) -> click pill -> wait for the
// target option to appear within MAX_OPTION_DIST of the pill -> click option.
//
// Returns 'already_selected' | 'selected' | 'trigger_not_found' | 'option_not_found'.
export async function selectPicker(page, { currentLabels, target, anchor = null, maxDist = null }) {
  const resolvedMaxDist = maxDist || MAX_PILL_DIST;
  if (!anchor) {
    try {
      const sel = await resolvePromptSelector(page, null);
      if (sel) {
        const a = await selectVisiblePromptAnchor(page, sel);
        anchor = a.anchor;
      }
    } catch (_) {}
  }
  // Step 1: resolve the pill that currently displays any of the candidate labels.
  // currentLabels is the union of known labels for this category; we also include
  // `target` so that if the pill already shows target, we can detect it here.
  const searchLabels = Array.from(new Set([...currentLabels, target]));
  const pillHandle = await findConfigPillByLabels(page, searchLabels, { anchor, maxDist: resolvedMaxDist });
  const pill = pillHandle.asElement ? pillHandle.asElement() : null;
  if (!pill) return 'trigger_not_found';

  // Step 2: check if this pill's current line-1 text already equals target.
  const pillState = await pill.evaluate(el => {
    const r = el.getBoundingClientRect();
    const line1 = (el.innerText || '').trim().split('\n')[0].trim();
    return { line1, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });
  if (pillState.line1 === target) return 'already_selected';

  // Step 3: click the pill and wait for the target option to appear nearby.
  await page.mouse.move(10, 10);
  await pause(100);
  await pill.scrollIntoViewIfNeeded().catch(() => {});
  await pill.click({ force: true }).catch(() => {});
  const pillAnchor = { cx: pillState.cx, cy: pillState.cy };
  const appeared = await waitForOptionVisible(page, target, pillAnchor, { timeoutMs: 3000 });
  if (!appeared) {
    await page.keyboard.press('Escape').catch(() => {});
    await pause(200);
    return 'option_not_found';
  }
  // Step 4: click the option through Playwright (not el.click() inside evaluate)
  // so React's synthetic event handlers register the selection.
  const optionJs = await findDropdownOptionHandle(page, target, pillAnchor);
  const option = optionJs.asElement ? optionJs.asElement() : null;
  if (!option) {
    await page.keyboard.press('Escape').catch(() => {});
    await pause(200);
    return 'option_not_found';
  }
  await option.scrollIntoViewIfNeeded().catch(() => {});
  await option.click({ force: true }).catch(() => {});
  await pause(500);
  // Step 5: verify the pill's line-1 text updated to match target. If not, the
  // click landed on a non-interactive label (e.g. a history-card chip with the
  // same text) and the state didn't change. Try keyboard fallback once before
  // giving up.
  const verified = await verifyPillLabel(page, pillAnchor, target);
  if (verified) return 'selected';
  // Fallback: reopen the dropdown and press ArrowDown + Enter to find the option.
  const kbOk = await selectByKeyboard(page, pillAnchor, target);
  if (kbOk) {
    await pause(400);
    const v2 = await verifyPillLabel(page, pillAnchor, target);
    if (v2) return 'selected';
  }
  return 'click_not_verified';
}

// After a picker click, read the button closest to pillAnchor within a small
// radius (the pill stays put; only its label changes). Returns true if that
// pill's new line-1 text equals target.
async function verifyPillLabel(page, pillAnchor, target) {
  return page.evaluate(({ anc, t }) => {
    const vh = window.innerHeight;
    // A pill click doesn't move the pill element; we look for ANY button within
    // 40 px of the known pill center and check its current line-1 text.
    const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => {
      const r = b.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return false;
      const cy = r.top + r.height / 2;
      if (cy < 0 || cy > vh) return false;
      const cx = r.x + r.width / 2;
      return Math.hypot(cx - anc.cx, cy - anc.cy) <= 40;
    });
    if (btns.length === 0) return false;
    // Any nearby pill whose line-1 matches target counts as verified.
    return btns.some(b => (b.innerText || '').trim().split('\n')[0].trim() === t);
  }, { anc: pillAnchor, t: target });
}

// Keyboard-driven fallback: reopen the dropdown, press ArrowDown until the
// focused/highlighted option's text matches target, then Enter. Works when the
// dropdown exposes ARIA keyboard navigation (Radix / Headless UI standard).
async function selectByKeyboard(page, pillAnchor, target) {
  // Reopen the pill nearest pillAnchor.
  const reopened = await page.evaluate(anc => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    btns.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const da = Math.hypot((ra.x + ra.width / 2) - anc.cx, (ra.y + ra.height / 2) - anc.cy);
      const db = Math.hypot((rb.x + rb.width / 2) - anc.cx, (rb.y + rb.height / 2) - anc.cy);
      return da - db;
    });
    if (btns.length === 0) return false;
    btns[0].click();
    return true;
  }, pillAnchor);
  if (!reopened) return false;
  await pause(700);
  // Press ArrowDown up to 25 times; each press check if aria-activedescendant
  // or focused element's text matches target.
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('ArrowDown');
    await pause(100);
    const match = await page.evaluate(t => {
      const active = document.activeElement;
      if (!active) return false;
      const line1 = (active.innerText || active.textContent || '').trim().split('\n')[0].trim();
      return line1 === t;
    }, target);
    if (match) {
      await page.keyboard.press('Enter');
      return true;
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

// Poll up to timeoutMs for an option whose line-1 text matches `label` to appear
// inside an open picker container (role=listbox/menu/dialog). Returns true on success.
async function waitForOptionVisible(page, label, pillAnchor, { timeoutMs = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await page.evaluate(lbl => {
      const containers = Array.from(document.querySelectorAll(
        '[role="listbox"], [role="menu"], [role="dialog"], [data-state="open"]'
      )).filter(c => {
        const r = c.getBoundingClientRect();
        return r.width > 40 && r.height > 40;
      });
      for (const c of containers) {
        const opts = c.querySelectorAll('[role="option"], [role="menuitem"], button, li, div');
        for (const el of opts) {
          const t = (el.innerText || '').trim();
          if (!t) continue;
          const line1 = t.split('\n')[0].trim();
          if (line1 === lbl) return true;
        }
      }
      return false;
    }, label);
    if (found) return true;
    await pause(120);
  }
  return false;
}

// Upload one or more local files as reference images / videos via the page's
// hidden <input type="file">. The input is scoped to the one NEAREST the active
// prompt (so cinema-studio's dual-panel layout picks the input inside the
// active panel, not e.g. a profile-photo picker elsewhere in the DOM).
//
// Returns { uploaded: number } on success, throws on no input found or if the
// chosen input is more than MAX_PILL_DIST away from the prompt (which strongly
// suggests we'd hit the wrong control).
export async function uploadReferenceImages(page, filePaths, { clearExisting = false } = {}) {
  const { existsSync } = await import('node:fs');
  if (!filePaths || filePaths.length === 0) return { uploaded: 0 };
  for (const p of filePaths) {
    if (!existsSync(p)) throw new Error(`Reference file not found: ${p}`);
  }
  if (clearExisting) await clearReferenceImages(page);
  const inputs = await page.$$('input[type="file"]');
  if (inputs.length === 0) {
    throw new Error('No <input type="file"> found on page (expected hidden attachment input).');
  }
  // Derive prompt anchor so we can prefer the attachment input inside the active panel.
  let promptAnchor = null;
  try {
    const sel = await resolvePromptSelector(page, null);
    if (sel) {
      const a = await selectVisiblePromptAnchor(page, sel);
      promptAnchor = a.anchor;
    }
  } catch (_) {}
  // Score each input: must accept image|video|wildcard AND be within reach of
  // the prompt anchor (if we have one).
  const scored = [];
  for (const inp of inputs) {
    const info = await inp.evaluate(el => {
      const r = el.getBoundingClientRect();
      return {
        accept: el.getAttribute('accept') || '',
        cx: r.x + r.width / 2,
        cy: r.y + r.height / 2,
        name: el.getAttribute('name') || '',
        id: el.id || ''
      };
    }).catch(() => null);
    if (!info) continue;
    const acceptOk = !info.accept || /image|video|\*/i.test(info.accept);
    if (!acceptOk) continue;
    const dist = promptAnchor ? Math.hypot(info.cx - promptAnchor.cx, info.cy - promptAnchor.cy) : 0;
    scored.push({ inp, info, dist });
  }
  if (scored.length === 0) {
    throw new Error('No attachment-capable file input found (none accepts image|video|*).');
  }
  scored.sort((a, b) => a.dist - b.dist);
  const chosen = scored[0];
  if (promptAnchor && chosen.dist > 1500) {
    throw new Error(`Nearest file input is ${Math.round(chosen.dist)} px from prompt (expected < 1500). Refusing to upload.`);
  }
  await chosen.inp.setInputFiles(filePaths);
  await pause(2500);
  return { uploaded: filePaths.length, input: { accept: chosen.info.accept, name: chosen.info.name, id: chosen.info.id }, dist_from_prompt: Math.round(chosen.dist) };
}

// Aggressively remove any attachment chips (previously uploaded reference
// images) near the prompt input. Higgsfield persists attachment state across
// page loads -- if we don't clear, a new prompt inherits whatever the user
// (or a prior run) attached. Hover-click strategy: for each thumbnail chip
// adjacent to the prompt, hover to reveal the remove button, then click it.
// Verifies by re-counting chips and aborting if stuck.
// Clear Higgsfield's persisted attachment state. The tool pages hydrate their
// input-images list from localStorage keys like hf:image-form-upd, hf:video-*,
// hf:marketing-*, hf:cinematic-*. Clearing the DOM chips doesn't help -- the
// POST body is built from persisted React state, not the visible UI. This
// helper strips inputImages / mediasV3 / medias / assets arrays from every
// form-shaped key and optionally reloads so React re-hydrates cleanly.
//
// Safe to call on every page; idempotent. If no keys match, it's a no-op.
export async function clearPersistedAttachments(page, { reload = true } = {}) {
  const summary = await page.evaluate(() => {
    const changed = [];
    for (const k of Object.keys(localStorage)) {
      if (!/hf:|form|media|image|video|cinematic|marketing|photodump/i.test(k)) continue;
      try {
        const raw = localStorage.getItem(k);
        if (!raw || !raw.startsWith('{')) continue;
        const obj = JSON.parse(raw);
        let mutated = false;
        const strip = (ob) => {
          if (!ob || typeof ob !== 'object') return;
          for (const key of ['inputImages', 'input_images', 'inputImage', 'mediasV3',
                              'mediasV35', 'medias', 'assets', 'endImage', 'referenceImages',
                              'reference_images', 'input_media']) {
            if (key in ob) {
              if (Array.isArray(ob[key])) { if (ob[key].length) { ob[key] = []; mutated = true; } }
              else if (ob[key]) { ob[key] = null; mutated = true; }
            }
          }
          for (const v of Object.values(ob)) {
            if (v && typeof v === 'object') strip(v);
          }
        };
        strip(obj);
        if (mutated) {
          localStorage.setItem(k, JSON.stringify(obj));
          changed.push(k);
        }
      } catch (_) {}
    }
    return { changed };
  });
  if (reload && summary.changed.length > 0) {
    await page.reload({ waitUntil: 'load', timeout: 30000 }).catch(() => {});
  }
  return summary;
}

export async function clearReferenceImages(page, { maxChips = 12 } = {}) {
  let removed = 0;
  for (let pass = 0; pass < maxChips; pass++) {
    // Locate a chip to remove. Chips are small buttons/containers near the
    // prompt, often wrapping a <img>.
    const chip = await page.evaluate(() => {
      const prompt = document.querySelector('div[role="textbox"][contenteditable="true"], textarea');
      if (!prompt) return null;
      const pr = prompt.getBoundingClientRect();
      const pcx = pr.x + pr.width / 2, pcy = pr.y + pr.height / 2;
      // Candidates: buttons OR their containing tiles that wrap an <img>
      // attachment thumbnail, within 250 px of the prompt.
      const all = Array.from(document.querySelectorAll('button, [role="button"]'));
      const chips = [];
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 24 || r.width > 120 || r.height > 120) continue;
        if (window.getComputedStyle(el).visibility === 'hidden') continue;
        const d = Math.hypot((r.x + r.width / 2) - pcx, (r.y + r.height / 2) - pcy);
        if (d > 260) continue;
        const hasImg = !!el.querySelector('img');
        // Skip obvious non-chip controls (aspect/res/batch pills with text labels).
        const line1 = (el.innerText || '').trim().split('\n')[0].trim();
        const hasTextLabel = line1.length > 0 && line1.length < 30 && !hasImg;
        if (hasTextLabel) continue;
        if (!hasImg) continue; // require an embedded thumbnail
        chips.push({ d, r, idx: chips.length });
      }
      chips.sort((a, b) => a.d - b.d);
      if (chips.length === 0) return null;
      const c = chips[0];
      return { cx: Math.round(c.r.x + c.r.width / 2), cy: Math.round(c.r.y + c.r.height / 2), total: chips.length };
    });
    if (!chip) break;
    // Hover over the chip, wait for the X button to render.
    await page.mouse.move(chip.cx, chip.cy);
    await pause(350);
    // Click any small (<=30x30) button that appeared near the chip's center.
    // Higgsfield's remove buttons are icon-only, so no text to match on.
    const clicked = await page.evaluate(anchor => {
      const cx = anchor.cx, cy = anchor.cy;
      const btns = Array.from(document.querySelectorAll('button')).filter(b => {
        const r = b.getBoundingClientRect();
        if (r.width < 8 || r.width > 36 || r.height < 8 || r.height > 36) return false;
        if (window.getComputedStyle(b).visibility === 'hidden') return false;
        const d = Math.hypot((r.x + r.width / 2) - cx, (r.y + r.height / 2) - cy);
        return d < 55;
      });
      // Prefer ones with X/close svg hints; fall back to any.
      btns.sort((a, b) => {
        const scoreOf = el => {
          const txt = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
          if (/remove|delete|close/.test(txt)) return 0;
          const path = el.querySelector('svg path[d]');
          if (path && /M\s*18.*6.*6.*18|l.*-.*-|\?cross|\?close/.test(path.getAttribute('d') || '')) return 1;
          return 2;
        };
        return scoreOf(a) - scoreOf(b);
      });
      if (btns.length === 0) return false;
      btns[0].click();
      return true;
    }, { cx: chip.cx, cy: chip.cy });
    if (!clicked) {
      // Try Backspace while the prompt is focused (some implementations remove
      // the last attachment on Backspace with empty prompt).
      await page.evaluate(() => {
        const p = document.querySelector('div[role="textbox"][contenteditable="true"], textarea');
        p && p.focus();
      });
      await page.keyboard.press('Backspace').catch(() => {});
    }
    await pause(450);
    removed++;
    if (removed >= maxChips) break;
  }
  if (removed) await pause(300);
  return removed;
}

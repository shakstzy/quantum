// video.mjs -- /ai/video handler. UI-driven submit (page clicks Generate) so DataDome's
// JS stack is honored. Completion is detected by scraping the History panel for a fresh
// user-owned CloudFront asset.

import { launchContext } from './browser.mjs';
import { browsePhase, pauseJitter } from './behavior.mjs';
import { initState, slugFromPrompt, timestampForRunId } from './state.mjs';
import { downloadAll, finalize, preflight, getWallet, parseCostCap, walletTotal } from './job.mjs';
import { submitViaUI, openHistoryPanel, scrapeUserAssets, waitForNewAssets, userIdFromJwtCapture, bestDownloadUrl, enableUnlimitedToggle, selectPicker, uploadReferenceImages, clearReferenceImages, clearPersistedAttachments } from './ui-submit.mjs';
import { waitForCapturedJwt } from './jwt.mjs';
import { transition } from './state.mjs';
import { collectRefs } from './image.mjs';
import { join, resolve as pathResolve } from 'node:path';

// Aspect / duration / resolution current-label candidates for /ai/video pills.
// Durations show as "3.0s", "5.0s", "8.0s" etc; resolutions "720p" / "1080p".
const VIDEO_ASPECT_LABELS     = ['16:9', '9:16', '1:1', '4:3', '3:4', 'Auto'];
const VIDEO_DURATION_LABELS   = ['3s', '5s', '8s', '10s', '15s', '3.0s', '5.0s', '8.0s', '10.0s', '15.0s'];
const VIDEO_RESOLUTION_LABELS = ['720p', '1080p'];

const OUTPUT_ROOT = process.env.HF_OUTPUT_DIR || `${process.env.HOME}/.quantum/skill-output/higgsfield`;
const VIDEO_URL = 'https://higgsfield.ai/ai/video';

// Catalog matches /ai/video model picker as of 2026-04-21 (see rules/site-map.json).
// Costs reflect empirically observed defaults (720p base). Using a non-existent slug throws.
// If the picker adds new models, re-run `node scripts/probe-sitemap.mjs` and update below.
// Video models: catalog key matches the frontend model selection. Some models
// SHARE a backend POST slug (e.g. Seedance 2.0 and Seedance 2.0 Fast both POST
// to /jobs/v2/seedance_2_0 with a "fast_mode" param in the body). We track
// backend_slug explicitly; it defaults to the catalog key when not specified.
export const VIDEO_CATALOG = {
  'seedance_2_0_fast':       { cost: 15, family: 'seedance', frontend_label: 'Seedance 2.0 Fast',       backend_slug: 'seedance_2_0' },
  'seedance_2_0':            { cost: 40, family: 'seedance', frontend_label: 'Seedance 2.0',            backend_slug: 'seedance_2_0' },
  'kling3_0':                { cost: 25, family: 'kling',    frontend_label: 'Kling 3.0',               backend_slug: 'kling3_0' },
  'kling3_0_motion_control': { cost: 35, family: 'kling_mc', frontend_label: 'Kling 3.0 Motion Control', backend_slug: 'kling3_0_motion_control' },
  'kling2_5_turbo':          { cost: 20, family: 'kling',    frontend_label: 'Kling 2.5 Turbo',         backend_slug: 'kling2_5_turbo' },
  'kling2_1':                { cost: 15, family: 'kling',    frontend_label: 'Kling 2.1',               backend_slug: 'kling2_1' },
  'wan2_7':                  { cost: 35, family: 'wan',      frontend_label: 'Wan 2.7',                 backend_slug: 'wan2_7' },
  'minimax_hailuo':          { cost: 20, family: 'minimax',  frontend_label: 'Minimax Hailuo',          backend_slug: 'minimax_hailuo' }
};

// Video extensions we look for in the History panel to confirm completion.
const VIDEO_EXTS = ['mp4', 'webm', 'mov'];

// Read the currently-selected model label from the left-sidebar "Model" row.
// Returns the label string or null. Matches the "Model\n<value>" two-line pattern
// at a config-sidebar width (100-500px wide) and inside the left half of the
// viewport (x < 500). We previously allowed any viewport match, but every
// history-card chip on /ai/video renders its own model label as a line-2 value
// and was causing false positives.
async function readActiveVideoModel(page) {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const candidates = Array.from(document.querySelectorAll('div, section, aside, span'));
    for (const el of candidates) {
      const t = (el.innerText || '').trim();
      if (!/^Model(\n|$)/.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.width > 500) continue;
      if (r.x > 500) continue;
      if (r.y < 0 || r.y > vh) continue;
      // Lines after "Model" may include a blank spacer line before the value;
      // take the first non-empty line after "Model".
      const lines = t.split('\n').slice(1).map(s => s.trim()).filter(Boolean);
      const value = lines[0] || '';
      if (!value || value === 'Select model') continue;
      return value;
    }
    return null;
  });
}

// Find the Select-Model trigger (the left-sidebar row whose top line reads
// "Model" or "Select model"). Returns a Playwright ElementHandle that we can
// click via Playwright (so React synthetic events fire -- `el.click()` inside
// evaluate bypasses onClick). Accepts these trigger shapes:
//   innerText === "Model"                 (fresh page, no model selected)
//   innerText === "Select model"          (alternate empty state)
//   innerText starts with "Model\n<value>" (value already selected)
async function findModelTriggerHandle(page) {
  return page.evaluateHandle(() => {
    const vh = window.innerHeight;
    const isTriggerText = t => t === 'Model' || t === 'Select model' ||
      /^Select model(\s|$)/.test(t) || /^Model\n/.test(t);

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const b of buttons) {
      const t = (b.innerText || '').trim();
      if (!isTriggerText(t)) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 40 || r.height < 20) continue;
      if (r.x > 500) continue;
      if (r.y < 0 || r.y > vh) continue;
      return b;
    }
    const divs = Array.from(document.querySelectorAll('div, section, aside'));
    for (const el of divs) {
      const t = (el.innerText || '').trim();
      if (!isTriggerText(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 20) continue;
      if (r.x > 500) continue;
      if (r.y < 0 || r.y > vh) continue;
      let cur = el;
      for (let i = 0; i < 6; i++) {
        const cls = (cur.className || '').toString();
        if (cur.tagName === 'BUTTON' || cur.getAttribute('role') === 'button' || /cursor-pointer|clickable/.test(cls)) return cur;
        if (!cur.parentElement) break;
        cur = cur.parentElement;
      }
      return el;
    }
    return null;
  });
}

// Inside an open model picker dialog, find the tile whose line-1 matches the
// desired label. Prefers elements inside a role=dialog / data-state=open
// container (Radix primitive). Returns a Playwright ElementHandle.
async function findVideoModelTileHandle(page, label) {
  return page.evaluateHandle(lbl => {
    const lblLower = lbl.toLowerCase();
    const containers = Array.from(document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [data-state="open"]'))
      .filter(c => {
        const r = c.getBoundingClientRect();
        return r.width > 40 && r.height > 40;
      });
    const inContainer = [];
    for (const c of containers) {
      const opts = Array.from(c.querySelectorAll('button, [role="option"], [role="menuitem"], div, li'));
      for (const el of opts) {
        const t = (el.innerText || '').trim();
        if (!t) continue;
        const line1 = t.split('\n')[0].trim();
        if (line1.toLowerCase() !== lblLower) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.height < 20) continue;
        if (window.getComputedStyle(el).visibility === 'hidden') continue;
        inContainer.push({ el, r, role: el.getAttribute('role'), tag: el.tagName });
      }
    }
    inContainer.sort((a, b) => {
      const rank = m => (m.tag === 'BUTTON' ? 0 : (m.role === 'option' || m.role === 'menuitem' ? 1 : 2));
      return rank(a) - rank(b);
    });
    if (inContainer.length > 0) return inContainer[0].el;
    const btns = Array.from(document.querySelectorAll('button'));
    const matches = [];
    for (const b of btns) {
      const t = (b.innerText || '').trim();
      if (!t) continue;
      const line1 = t.split('\n')[0].trim();
      if (line1.toLowerCase() !== lblLower) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 40 || r.height < 30) continue;
      if (window.getComputedStyle(b).visibility === 'hidden') continue;
      matches.push({ el: b, r });
    }
    if (matches.length === 0) return null;
    const vw = window.innerWidth, vh = window.innerHeight;
    const centerX = vw / 2, centerY = vh / 2;
    matches.sort((a, b) => {
      const areaA = a.r.width * a.r.height, areaB = b.r.width * b.r.height;
      if (Math.abs(areaA - areaB) > 500) return areaB - areaA;
      const da = Math.hypot((a.r.x + a.r.width / 2) - centerX, (a.r.y + a.r.height / 2) - centerY);
      const db = Math.hypot((b.r.x + b.r.width / 2) - centerX, (b.r.y + b.r.height / 2) - centerY);
      return da - db;
    });
    return matches[0].el;
  }, label);
}

// Select the desired video model. Idempotent: skips the picker if the sidebar
// "Model\n<value>" row already shows `label`. Otherwise opens the picker via
// Playwright click (synthetic events), waits for any target video model to
// appear inside a dialog, clicks the target tile via Playwright, then verifies
// the sidebar label updated.
export async function selectVideoModel(page, label) {
  const dbg = process.env.HF_DEBUG === '1';
  const active = await readActiveVideoModel(page);
  if (dbg) console.error(`[video-model] active=${JSON.stringify(active)} target=${JSON.stringify(label)}`);
  if (active && active.toLowerCase() === label.toLowerCase()) return true;

  const triggerJs = await findModelTriggerHandle(page);
  const trigger = triggerJs.asElement ? triggerJs.asElement() : null;
  if (dbg) console.error(`[video-model] trigger found: ${trigger ? 'yes' : 'no'}`);
  if (!trigger) return false;
  await page.mouse.move(10, 10);
  await page.waitForTimeout(100);
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ force: true }).catch(() => {});
  const start = Date.now();
  let appeared = false;
  while (Date.now() - start < 5000) {
    appeared = await page.evaluate(lbl => {
      const lblLower = lbl.toLowerCase();
      const containers = Array.from(document.querySelectorAll('[role="dialog"], [data-state="open"], [role="menu"], [role="listbox"]'));
      for (const c of containers) {
        const btns = c.querySelectorAll('button, [role="option"], [role="menuitem"]');
        for (const b of btns) {
          const line1 = (b.innerText || '').trim().split('\n')[0].trim();
          if (line1.toLowerCase() === lblLower) return true;
        }
      }
      const allBtns = Array.from(document.querySelectorAll('button'));
      return allBtns.some(b => (b.innerText || '').trim().split('\n')[0].trim().toLowerCase() === lblLower);
    }, label);
    if (appeared) break;
    await page.waitForTimeout(150);
  }
  if (dbg) console.error(`[video-model] picker tile for ${label} appeared: ${appeared}`);
  if (!appeared) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  const tileJs = await findVideoModelTileHandle(page, label);
  const tile = tileJs.asElement ? tileJs.asElement() : null;
  if (dbg) {
    if (tile) {
      const info = await tile.evaluate(el => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName, role: el.getAttribute('role'), text: (el.innerText || '').trim().slice(0, 80), xy: [Math.round(r.x), Math.round(r.y)], wh: [Math.round(r.width), Math.round(r.height)] };
      });
      console.error(`[video-model] tile resolved: ${JSON.stringify(info)}`);
    } else {
      const allTiles = await page.evaluate(lbl => {
        const out = [];
        for (const c of document.querySelectorAll('[role="dialog"], [data-state="open"], [role="menu"], [role="listbox"]')) {
          for (const b of c.querySelectorAll('button, [role="option"], [role="menuitem"]')) {
            const t = (b.innerText || '').trim().slice(0, 60);
            if (!t) continue;
            const r = b.getBoundingClientRect();
            out.push({ t, xy: [Math.round(r.x), Math.round(r.y)], role: b.getAttribute('role'), tag: b.tagName });
          }
        }
        return out;
      }, label);
      console.error(`[video-model] tile NOT found for "${label}". Tiles present:`, JSON.stringify(allTiles).slice(0, 800));
    }
  }
  if (!tile) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await tile.scrollIntoViewIfNeeded().catch(() => {});
  await tile.click({ force: true }).catch(() => {});
  await page.waitForTimeout(800);
  const verifyStart = Date.now();
  while (Date.now() - verifyStart < 4000) {
    const now = await readActiveVideoModel(page);
    if (now && now.toLowerCase() === label.toLowerCase()) {
      if (dbg) console.error(`[video-model] verified: active=${now}`);
      return true;
    }
    await page.waitForTimeout(200);
  }
  const closedAndSet = await page.evaluate(lbl => {
    const dialog = document.querySelector('[role="dialog"][data-state="open"]');
    if (dialog) return false;
    const all = Array.from(document.querySelectorAll('div, section, aside'));
    for (const el of all) {
      const t = (el.innerText || '').trim();
      if (!/^Model(\n|$)/.test(t)) continue;
      const lines = t.split('\n').slice(1).map(s => s.trim()).filter(Boolean);
      const value = lines[0] || '';
      if (value && value.toLowerCase().startsWith(lbl.toLowerCase())) return true;
    }
    return false;
  }, label);
  return closedAndSet;
}

export async function runVideo(argv) {
  if (!argv.prompt) throw new Error('--prompt is required');
  const slug = argv.model || 'seedance_2_0_fast';
  const cat = VIDEO_CATALOG[slug];
  if (!cat) throw new Error(`Unknown video model: ${slug}. Supported: ${Object.keys(VIDEO_CATALOG).join(', ')}`);

  const runId = `${timestampForRunId()}-${slugFromPrompt(argv.prompt)}`;
  const runDir = argv.output ? argv.output : join(OUTPUT_ROOT, runId);

  const params_for_state = {
    aspect_ratio: argv.aspect || null,
    duration: argv.duration ? parseInt(argv.duration, 10) : null,
    resolution: argv.res || null,
    use_unlim: !!argv.unlim
  };

  await initState(runDir, {
    run_id: runId,
    cmd: 'video',
    model_frontend: slug,
    model_backend: cat.backend_slug || slug,
    tool_url: VIDEO_URL,
    prompt: argv.prompt,
    params: params_for_state,
    cost_credits_expected: cat.cost,
    force_used: !!argv.force
  });

  console.log(`[higgsfield] run_id=${runId} dir=${runDir} slug=${slug} expected_cost=${cat.cost}`);
  if (argv.dryRun) {
    console.log(`[higgsfield] --dry-run: would click Generate on ${VIDEO_URL} with prompt=${argv.prompt} model=${slug}`);
    return { dry_run: true, runDir };
  }

  const ctx = await launchContext({ force: !!argv.force, headless: false });
  let walletBefore = null;
  try {
    await ctx.page.goto(VIDEO_URL, { waitUntil: 'load', timeout: 45000 });
    const wait = await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    if (!wait.ok) throw new Error(`No Clerk JWT observed: ${wait.reason}. Run 'node scripts/run.mjs login'.`);
    console.log(`[higgsfield] captured Clerk JWT (${ctx.jwtCapture.captureCount} obs)`);
    const cleared = await clearPersistedAttachments(ctx.page);
    if (cleared.changed.length) console.log(`[higgsfield] cleared persisted attachments in ${cleared.changed.length} localStorage key(s)`);

    await browsePhase(ctx.page);
    walletBefore = await preflight(ctx.page, runDir, { expectedCost: cat.cost, jwtCapture: ctx.jwtCapture, costCap: parseCostCap(argv) });

    // Select the requested model in the UI (required: video page has no model selected by default).
    const picked = await selectVideoModel(ctx.page, cat.frontend_label);
    if (!picked) {
      const err = new Error(`Could not select model "${cat.frontend_label}" in the UI. The picker may have changed.`);
      err.code = 'UI_NO_MODEL_SELECT';
      throw err;
    }
    console.log(`[higgsfield] model selected in UI: ${cat.frontend_label}`);

    const userSub = userIdFromJwtCapture(ctx.jwtCapture);
    if (!userSub) throw new Error('Could not extract user_id from captured JWT.');
    const userSubstr = userSub.replace(/^user_/, '');
    console.log(`[higgsfield] user_id=${userSub}`);

    await openHistoryPanel(ctx.page);
    const preExisting = await scrapeUserAssets(ctx.page, userSubstr);
    const preSet = new Set(preExisting.map(x => x.cdn));
    console.log(`[higgsfield] baseline: ${preSet.size} pre-existing user assets`);

    const unlimState = await enableUnlimitedToggle(ctx.page);
    console.log(`[higgsfield] unlimited toggle: ${unlimState}`);

    // Apply picker tweaks FIRST so subsequent React rerenders don't clear attachments.
    if (argv.aspect) {
      const r = await selectPicker(ctx.page, { currentLabels: VIDEO_ASPECT_LABELS, target: argv.aspect, maxDist: 900 });
      console.log(`[higgsfield] aspect ${argv.aspect}: ${r}`);
      params_for_state.aspect_ratio = argv.aspect;
    }
    if (argv.duration) {
      const raw = String(argv.duration).trim().replace(/s$/i, '');
      const n = parseFloat(raw);
      if (!isFinite(n)) throw new Error(`Invalid --duration: ${argv.duration}`);
      const candidates = [`${n.toFixed(1)}s`, `${Math.round(n)}s`];
      let r = 'option_not_found', target = candidates[0];
      for (const c of candidates) {
        r = await selectPicker(ctx.page, { currentLabels: VIDEO_DURATION_LABELS, target: c, maxDist: 900 });
        target = c;
        if (r === 'already_selected' || r === 'selected') break;
      }
      if (r !== 'already_selected' && r !== 'selected') {
        // Probe what duration options THIS model actually supports so the error is actionable.
        const opts = await ctx.page.evaluate(() => {
          const out = new Set();
          document.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"], li, span, div').forEach(el => {
            if (el.children.length > 1) return;
            const t = (el.innerText || '').trim();
            if (/^\d+\.?\d*\s*s$/i.test(t)) out.add(t);
          });
          return Array.from(out);
        });
        throw new Error(`Could not select duration "${argv.duration}" (tried ${candidates.join(', ')}). Model "${slug}" supports: ${opts.join(', ') || '(none detected)'}`);
      }
      console.log(`[higgsfield] duration ${target}: ${r}`);
      params_for_state.duration = target;
    }
    if (argv.res) {
      const r = await selectPicker(ctx.page, { currentLabels: VIDEO_RESOLUTION_LABELS, target: argv.res, maxDist: 900 });
      console.log(`[higgsfield] resolution ${argv.res}: ${r}`);
      params_for_state.resolution = argv.res;
    }

    // ALWAYS clear stale attachment chips before submit. Higgsfield persists
    // attachments; skipping this leaks a prior run's refs into this job.
    const clearedChips = await clearReferenceImages(ctx.page);
    if (clearedChips > 0) console.log(`[higgsfield] cleared ${clearedChips} stale attachment chip(s)`);

    const refPaths = collectRefs(argv);
    if (refPaths.length > 0) {
      const absPaths = refPaths.map(p => pathResolve(p));
      const u = await uploadReferenceImages(ctx.page, absPaths, { clearExisting: false });
      console.log(`[higgsfield] uploaded ${u.uploaded} reference file(s) via input ${u.input?.name || u.input?.id || '(unnamed)'} @ ${u.dist_from_prompt}px: ${absPaths.join(', ')}`);
      params_for_state.ref_files = absPaths;
    }

    const submission = await submitViaUI(ctx.page, ctx.context, runDir, {
      slug: cat.backend_slug || slug,
      prompt: argv.prompt,
      responseTimeoutMs: 60000 // video submit takes longer than image sometimes
    });

    await transition(runDir, 'polling', {});
    console.log(`[higgsfield] waiting for new video asset (up to 30 min)...`);
    const fresh = await waitForNewAssets(ctx.page, userSubstr, preSet, {
      expectCount: 1,
      timeoutMs: 30 * 60 * 1000,
      pollMs: 5000,
      requireKind: 'video'
    });
    console.log(`[higgsfield] detected ${fresh.length} new video asset(s)`);
    fresh.forEach(f => console.log(`  ${f.kind}: ${f.cdn}`));

    const urls = fresh.map(bestDownloadUrl);
    console.log('[higgsfield] download URLs:', urls);
    const records = await downloadAll(runDir, urls);

    const walletAfter = await getWallet(ctx.page, ctx.jwtCapture);
    const meta = await finalize(runDir, {
      wallet_before: walletTotal(walletBefore),
      wallet_after: walletTotal(walletAfter),
      job_uuid: submission.job_uuid,
      job: null,
      records,
      cmd: 'video',
      model_frontend: slug,
      model_backend: slug,
      prompt: argv.prompt,
      params: params_for_state
    });

    console.log(`[higgsfield] SAVED ${records.length} file(s) to ${runDir}`);
    for (const r of records) console.log(`  ${r.local_path} (${r.bytes} bytes, ${r.content_type})`);
    console.log(`[higgsfield] cost: ~${meta.cost_credits_actual} credits (wallet ${meta.wallet_before} -> ${meta.wallet_after})`);
    return { runDir, metadata: meta };
  } catch (err) {
    if (argv.debug) {
      console.error(`[higgsfield] error: ${err.message}. Browser left open. Ctrl+C when done.`);
      await new Promise(() => {});
    }
    throw err;
  } finally {
    if (!argv.debug) await ctx.close();
  }
}

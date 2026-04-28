// cinema.mjs -- Cinema Studio handler (image + video modes). UI-driven submit.

import { launchContext } from './browser.mjs';
import { browsePhase, pauseJitter } from './behavior.mjs';
import { initState, slugFromPrompt, timestampForRunId, transition } from './state.mjs';
import { downloadAll, finalize, preflight, getWallet, parseCostCap, walletTotal } from './job.mjs';
import { submitViaUI, openHistoryPanel, scrapeUserAssets, waitForNewAssets, userIdFromJwtCapture, bestDownloadUrl, enableUnlimitedToggle, uploadReferenceImages } from './ui-submit.mjs';
import { waitForCapturedJwt } from './jwt.mjs';
import { collectRefs } from './image.mjs';
import { join, resolve as pathResolve } from 'node:path';

const OUTPUT_ROOT = process.env.HF_OUTPUT_DIR || `${process.env.HOME}/.quantum/skill-output/higgsfield`;

const CINEMA_MODES = {
  video: { slug: 'cinematic_studio_video_3_5', cost: 96, resolution: '1080p', exts: ['mp4', 'webm', 'mov'] },
  image: { slug: 'cinematic_studio_image',     cost: 2,  resolution: '1k',    exts: ['png', 'webp', 'jpg', 'jpeg'] }
};

export const CINEMA_MODE_CATALOG = CINEMA_MODES;

// Read the "primary" Generate button's cost value (line 2). Cinema-studio
// renders two overlapping Generate buttons (outer wrapper + inner): the outer
// is the real primary and reflects the active mode (video=96, image=2); the
// inner seems to be a nested span that always reads "GENERATE 2".
// We pick the LARGEST by area (width*height) to force the outer wrapper.
// Returns the numeric cost or null.
async function readCinemaGenerateCost(page) {
  return page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => {
      const t = (b.innerText || '').trim();
      if (!/^GENERATE\b/i.test(t)) return false;
      const r = b.getBoundingClientRect();
      return r.width > 40 && r.height > 20 && window.getComputedStyle(b).visibility !== 'hidden';
    });
    if (btns.length === 0) return null;
    btns.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    const primary = btns[0];
    const lines = (primary.innerText || '').trim().split('\n').map(s => s.trim());
    const cost = parseInt(lines[1] || '', 10);
    return isFinite(cost) ? cost : null;
  });
}

// Switch cinema-studio to Image or Video mode. Cinema renders overlapping tab
// widgets (one actual mode switcher + one stale/decorative) with identical
// aria labels, so aria-selected alone is unreliable. We verify the switch via
// the Generate button's cost readout: image = 2 credits, video = 96 credits.
// Returns true once the cost reflects the requested mode.
export async function selectCinemaMode(page, mode) {
  const label = mode === 'video' ? 'Video' : 'Image';
  const targetCost = mode === 'video' ? 96 : 2;
  const dbg = process.env.HF_DEBUG === '1';
  // Fast path: Generate already shows target cost.
  const currentCost = await readCinemaGenerateCost(page);
  if (dbg) console.error(`[cinema-mode] fast-path: targetCost=${targetCost} currentCost=${currentCost}`);
  if (currentCost === targetCost) return true;

  // Click a role=tab with target label that is NOT aria-selected.
  //
  // Critical filter: cinema-studio renders TWO Image/Video tab pairs. One at
  // x~228 is actually a LEFT-SIDEBAR NAV LINK (clicking navigates to /upscale
  // or similar, destroying the page). The REAL mode-switch tabs sit in the
  // config bar at x>=300 alongside the prompt. Reject x<300 candidates.
  const tabJs = await page.evaluateHandle(l => {
    const lblLower = l.toLowerCase();
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const candidates = [];
    for (const t of tabs) {
      const line1 = (t.innerText || '').trim().split('\n')[0].trim();
      if (line1.toLowerCase() !== lblLower) continue;
      if (t.getAttribute('aria-selected') === 'true') continue;
      const r = t.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) continue;
      if (r.x < 300) continue; // sidebar nav tab; clicking navigates away
      if (window.getComputedStyle(t).visibility === 'hidden') continue;
      candidates.push({ el: t, r });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.r.y + b.r.height) - (a.r.y + a.r.height));
    return candidates[0].el;
  }, label);
  const tab = tabJs.asElement ? tabJs.asElement() : null;
  if (dbg) console.error(`[cinema-mode] first-choice tab found: ${tab ? 'yes' : 'no'}`);
  if (tab) {
    await tab.scrollIntoViewIfNeeded().catch(() => {});
    await tab.click({ force: true }).catch(() => {});
    // Poll cost: panel transition may take 500-1500ms; Generate can briefly
    // unmount. Wait up to 5s for cost to stabilize at target.
    const start = Date.now();
    let lastCost = null;
    while (Date.now() - start < 5000) {
      await page.waitForTimeout(250);
      lastCost = await readCinemaGenerateCost(page);
      if (lastCost === targetCost) {
        if (dbg) console.error(`[cinema-mode] post-first-click cost=${lastCost} target=${targetCost} (settled in ${Date.now()-start}ms)`);
        return true;
      }
    }
    if (dbg) {
      const diag = await page.evaluate(() => {
        const url = location.href;
        const btns = Array.from(document.querySelectorAll('button')).filter(b => /generate/i.test((b.innerText || '').trim()));
        const dump = btns.slice(0, 8).map(b => {
          const r = b.getBoundingClientRect();
          return { text: (b.innerText || '').trim().slice(0, 40), xy: [Math.round(r.x), Math.round(r.y)], wh: [Math.round(r.width), Math.round(r.height)], vis: window.getComputedStyle(b).visibility };
        });
        const prompts = Array.from(document.querySelectorAll('div[role="textbox"][contenteditable="true"], textarea')).map(el => {
          const r = el.getBoundingClientRect();
          return { tag: el.tagName, place: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '', xy: [Math.round(r.x), Math.round(r.y)], wh: [Math.round(r.width), Math.round(r.height)] };
        });
        return { url, btns: dump, prompts };
      });
      console.error(`[cinema-mode] post-first-click FAILED. url=${diag.url}`);
      console.error(`[cinema-mode]   generate-like btns:`, JSON.stringify(diag.btns));
      console.error(`[cinema-mode]   prompts:`, JSON.stringify(diag.prompts));
    }
  }
  // First click didn't flip. Try every remaining target-labelled tab until
  // the Generate cost matches. Some layouts have an actual mode-switch tab
  // plus decorative siblings; we only know which is which by outcome.
  const allCandidates = await page.evaluate(l => {
    const lblLower = l.toLowerCase();
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    return tabs.map((t, i) => {
      const r = t.getBoundingClientRect();
      const visible = window.getComputedStyle(t).visibility !== 'hidden';
      return {
        idx: i,
        line1: (t.innerText || '').trim().split('\n')[0].trim(),
        aria: t.getAttribute('aria-selected'),
        x: r.x, y: r.y, w: r.width, h: r.height, visible
      };
    }).filter(x => x.line1.toLowerCase() === lblLower && x.x >= 300 && x.w >= 20 && x.h >= 20 && x.visible);
  }, label);
  for (const cand of allCandidates) {
    const handle = await page.evaluateHandle(({ idx }) => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      return tabs[idx] || null;
    }, { idx: cand.idx });
    const el = handle.asElement ? handle.asElement() : null;
    if (!el) continue;
    if (dbg) console.error(`[cinema-mode] fallback click on candidate idx=${cand.idx} aria=${cand.aria}`);
    await el.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    const c = await readCinemaGenerateCost(page);
    if (dbg) console.error(`[cinema-mode] post-fallback-click cost=${c} target=${targetCost}`);
    if (c === targetCost) return true;
  }
  if (dbg) console.error(`[cinema-mode] FAILED to reach cost=${targetCost}; tried ${allCandidates.length} candidates`);
  return false;
}

// Click the cinema-studio model picker and select the requested model label.
// The cinema model picker renders as a full dialog with tiles (same shape as
// /ai/video's model picker). Uses the same evaluateHandle + Playwright-click
// pattern so React synthetic events fire. Returns true on success.
export async function selectCinemaModel(page, label) {
  // Try a fast path: check if active cinema model label already matches.
  const active = await page.evaluate(() => {
    const vh = window.innerHeight;
    for (const el of document.querySelectorAll('div, section, aside, span')) {
      const t = (el.innerText || '').trim();
      if (!/^Model(\n|$)/.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.width > 500 || r.x > 500) continue;
      if (r.y < 0 || r.y > vh) continue;
      const lines = t.split('\n').slice(1).map(s => s.trim()).filter(Boolean);
      const value = lines[0] || '';
      if (!value || value === 'Select model') continue;
      return value;
    }
    return null;
  });
  if (active && active.toLowerCase() === label.toLowerCase()) return true;

  const triggerJs = await page.evaluateHandle(() => {
    const vh = window.innerHeight;
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const t = (b.innerText || '').trim();
      if (t !== 'Select model' && !/^Select model(\s|$)/.test(t) && !/^Model\n.+/.test(t)) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 40 || r.height < 20) continue;
      if (r.x > 500 || r.y < 0 || r.y > vh) continue;
      return b;
    }
    return null;
  });
  const trigger = triggerJs.asElement ? triggerJs.asElement() : null;
  if (!trigger) return false;
  await page.mouse.move(10, 10);
  await page.waitForTimeout(100);
  await trigger.click({ force: true }).catch(() => {});

  const start = Date.now();
  let appeared = false;
  while (Date.now() - start < 5000) {
    appeared = await page.evaluate(lbl => {
      const lblLower = lbl.toLowerCase();
      const containers = Array.from(document.querySelectorAll('[role="dialog"], [data-state="open"], [role="menu"], [role="listbox"]'));
      for (const c of containers) {
        for (const b of c.querySelectorAll('button, [role="option"], [role="menuitem"]')) {
          const line1 = (b.innerText || '').trim().split('\n')[0].trim();
          if (line1.toLowerCase() === lblLower) return true;
        }
      }
      return false;
    }, label);
    if (appeared) break;
    await page.waitForTimeout(150);
  }
  if (!appeared) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  const tileJs = await page.evaluateHandle(lbl => {
    const lblLower = lbl.toLowerCase();
    const containers = Array.from(document.querySelectorAll('[role="dialog"], [data-state="open"], [role="menu"], [role="listbox"]'));
    const matches = [];
    for (const c of containers) {
      for (const el of c.querySelectorAll('button, [role="option"], [role="menuitem"]')) {
        const line1 = (el.innerText || '').trim().split('\n')[0].trim();
        if (line1.toLowerCase() !== lblLower) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.height < 20) continue;
        matches.push({ el, r });
      }
    }
    matches.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
    return matches[0]?.el || null;
  }, label);
  const tile = tileJs.asElement ? tileJs.asElement() : null;
  if (!tile) { await page.keyboard.press('Escape').catch(() => {}); return false; }
  await tile.scrollIntoViewIfNeeded().catch(() => {});
  await tile.click({ force: true }).catch(() => {});
  await page.waitForTimeout(800);
  return true;
}

// Click the in-page Image/Video mode tab. Cinema Studio renders TWO overlapping
// tab sets in the DOM (one per panel). Both expose role="tab", so we must identify
// which tab set belongs to the panel we want.
//
// Strategy:
//  1. Collect all role="tab" elements in the config-bar band (y 700-880, x 180-320).
//  2. Group them into sets by x-coordinate cluster (within 10px of each other).
//  3. For each set, the OTHER label's tab (e.g. Image when we want Video) tells us
//     the set's orientation. We pick the set where a tab matching `label` exists.
//  4. Click that tab if not already active; verify by re-reading aria-selected.
//
// Returns { clicked, verified, xywh, reason? }
async function clickModeTab(page, label) {
  const result = await page.evaluate((lbl) => {
    const allTabs = Array.from(document.querySelectorAll('[role="tab"]')).map(t => {
      const r = t.getBoundingClientRect();
      const line1 = (t.innerText || '').trim().split('\n')[0].trim();
      return { el: t, line1, r,
        ariaSel: t.getAttribute('aria-selected') === 'true',
        activeCls: /text-font-primary/.test(t.className || '') };
    });
    const inBand = allTabs.filter(s => s.r.y >= 700 && s.r.y <= 880 && s.r.x >= 180 && s.r.x <= 320);
    if (inBand.length === 0) return { clicked: false, reason: 'no_tabs_in_band' };
    // Group by x-cluster (10 px window) -- each config-bar tab set sits at its own x.
    const groups = [];
    for (const t of inBand) {
      let placed = false;
      for (const g of groups) {
        if (Math.abs(g.x - t.r.x) <= 12) { g.members.push(t); placed = true; break; }
      }
      if (!placed) groups.push({ x: t.r.x, members: [t] });
    }
    // Pick the group containing a tab matching `label` and a sibling with a
    // different label (proving this group is an Image/Video pair).
    const targetGroup = groups.find(g => {
      const labels = new Set(g.members.map(m => m.line1.toLowerCase()));
      return labels.has(lbl.toLowerCase()) && labels.size >= 2;
    });
    if (!targetGroup) return { clicked: false, reason: 'no_matching_group' };
    const targetTab = targetGroup.members.find(m => m.line1.toLowerCase() === lbl.toLowerCase());
    if (!targetTab) return { clicked: false, reason: 'no_target_in_group' };
    const xywh = [Math.round(targetTab.r.x), Math.round(targetTab.r.y), Math.round(targetTab.r.width), Math.round(targetTab.r.height)];
    // Already active in its own group? No click needed.
    if (targetTab.ariaSel || targetTab.activeCls) {
      targetTab.el.scrollIntoView({ block: 'center' });
      return { clicked: false, alreadyActive: true, xywh };
    }
    targetTab.el.scrollIntoView({ block: 'center' });
    targetTab.el.click();
    return { clicked: true, xywh };
  }, label);
  if (result.clicked) {
    await page.waitForTimeout(800);
    // Verify by re-reading aria-selected on the target tab we just clicked.
    const verified = await page.evaluate(({ lbl, xywh }) => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      for (const t of tabs) {
        const r = t.getBoundingClientRect();
        if (Math.abs(r.x - xywh[0]) > 4 || Math.abs(r.y - xywh[1]) > 4) continue;
        const line1 = (t.innerText || '').trim().split('\n')[0].trim();
        if (line1.toLowerCase() !== lbl.toLowerCase()) continue;
        return t.getAttribute('aria-selected') === 'true' || /text-font-primary/.test(t.className || '');
      }
      return false;
    }, { lbl: label, xywh: result.xywh });
    result.verified = verified;
  }
  return result;
}

export async function runCinema(argv) {
  if (!argv.scene) throw new Error('--scene is required (text prompt)');
  const mode = argv.mode || 'video';
  if (!CINEMA_MODES[mode]) throw new Error('--mode must be "image" or "video"');
  const cfg = CINEMA_MODES[mode];

  const runId = `${timestampForRunId()}-${slugFromPrompt(argv.scene)}`;
  const runDir = argv.output ? argv.output : join(OUTPUT_ROOT, runId);
  const projectUrl = argv.projectId
    ? `https://higgsfield.ai/cinema-studio?cinematic-project-id=${argv.projectId}&workflow-project-id=${argv.projectId}`
    : 'https://higgsfield.ai/cinema-studio?autoSelectFolder=true';

  await initState(runDir, {
    run_id: runId,
    cmd: 'cinema',
    model_frontend: `cinema-studio-${mode}`,
    model_backend: cfg.slug,
    tool_url: projectUrl,
    prompt: argv.scene,
    params: {
      mode,
      resolution: cfg.resolution,
      genre: argv.genre || null,
      style: argv.style || null,
      project_id: argv.projectId || null
    },
    cost_credits_expected: cfg.cost,
    force_used: !!argv.force
  });

  if (argv.dryRun) {
    console.log(`[higgsfield] --dry-run: would open ${projectUrl}, select ${mode} tab, type scene, click Generate.`);
    return { dry_run: true, runDir };
  }

  const ctx = await launchContext({ force: !!argv.force, headless: false });
  let walletBefore = null;
  try {
    await ctx.page.goto(projectUrl, { waitUntil: 'load', timeout: 45000 });
    const wait = await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    if (!wait.ok) throw new Error(`No Clerk JWT observed: ${wait.reason}`);

    await browsePhase(ctx.page);
    walletBefore = await preflight(ctx.page, runDir, { expectedCost: cfg.cost, jwtCapture: ctx.jwtCapture, costCap: parseCostCap(argv) });

    // Select mode tab. Cinema-studio's DOM has two overlapping tab sets; clickModeTab
    // scopes to the config-bar band and scrolls the chosen panel into view so
    // submitViaUI's proximity picker lands on the right prompt + Generate pair.
    const modeOk = await selectCinemaMode(ctx.page, mode);
    console.log(`[higgsfield] mode tab ${mode}: ${modeOk ? 'set' : 'FAILED_TO_SWITCH'}`);
    if (!modeOk) throw new Error(`Could not switch cinema mode to ${mode}; Generate cost did not flip to ${cfg.cost}`);
    await pauseJitter();

    const userSub = userIdFromJwtCapture(ctx.jwtCapture);
    if (!userSub) throw new Error('Could not extract user_id from JWT.');
    const userSubstr = userSub.replace(/^user_/, '');
    await openHistoryPanel(ctx.page);
    const preExisting = await scrapeUserAssets(ctx.page, userSubstr);
    const preSet = new Set(preExisting.map(x => x.cdn));

    const unlimState = await enableUnlimitedToggle(ctx.page);
    console.log(`[higgsfield] unlimited toggle: ${unlimState}`);

    const refPaths = collectRefs(argv);
    if (refPaths.length > 0) {
      const absPaths = refPaths.map(p => pathResolve(p));
      const u = await uploadReferenceImages(ctx.page, absPaths, { clearExisting: true });
      console.log(`[higgsfield] uploaded ${u.uploaded} reference file(s): ${absPaths.join(', ')}`);
    }

    const submission = await submitViaUI(ctx.page, ctx.context, runDir, {
      slug: cfg.slug, prompt: argv.scene, responseTimeoutMs: 60000, expectedCost: cfg.cost
    });

    await transition(runDir, 'polling', {});
    const timeoutMs = mode === 'video' ? 30 * 60 * 1000 : 5 * 60 * 1000;
    console.log(`[higgsfield] waiting for cinema ${mode} asset (up to ${timeoutMs / 60000} min)...`);
    const fresh = await waitForNewAssets(ctx.page, userSubstr, preSet, {
      expectCount: 1, timeoutMs, pollMs: mode === 'video' ? 5000 : 3000,
      requireKind: mode === 'video' ? 'video' : 'image'
    });
    fresh.forEach(f => console.log(`  ${f.kind}: ${f.cdn}`));

    const records = await downloadAll(runDir, fresh.map(bestDownloadUrl));
    const walletAfter = await getWallet(ctx.page, ctx.jwtCapture);
    const meta = await finalize(runDir, {
      wallet_before: walletTotal(walletBefore),
      wallet_after: walletTotal(walletAfter),
      job_uuid: submission.job_uuid, job: null, records,
      cmd: 'cinema', model_frontend: `cinema-studio-${mode}`, model_backend: cfg.slug,
      prompt: argv.scene, params: { mode, resolution: cfg.resolution }
    });
    console.log(`[higgsfield] SAVED ${records.length} file(s) to ${runDir}; ~${meta.cost_credits_actual} credits`);
    return { runDir, metadata: meta };
  } catch (err) {
    if (argv.debug) {
      console.error(`[higgsfield] error: ${err.message}. Browser left open.`);
      await new Promise(() => {});
    }
    throw err;
  } finally {
    if (!argv.debug) await ctx.close();
  }
}

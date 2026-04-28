// marketing.mjs -- Marketing Studio handler. UI-driven submit.
// v1 note: preset must be pre-selected in the UI (user does this manually in the profile,
// or passes --preset NAME and we click the matching tile). The UI state persists in the profile.

import { launchContext } from './browser.mjs';
import { browsePhase, pauseJitter } from './behavior.mjs';
import { initState, slugFromPrompt, timestampForRunId, transition } from './state.mjs';
import { downloadAll, finalize, preflight, getWallet, parseCostCap, walletTotal } from './job.mjs';
import { submitViaUI, openHistoryPanel, scrapeUserAssets, waitForNewAssets, userIdFromJwtCapture, bestDownloadUrl, enableUnlimitedToggle, uploadReferenceImages } from './ui-submit.mjs';
import { waitForCapturedJwt } from './jwt.mjs';
import { collectRefs } from './image.mjs';
import { join, resolve as pathResolve } from 'node:path';

const OUTPUT_ROOT = process.env.HF_OUTPUT_DIR || `${process.env.HOME}/.quantum/skill-output/higgsfield`;
const SLUG = 'marketing_studio_video';
const EXPECTED_COST = 48;
const VIDEO_EXTS = ['mp4', 'webm', 'mov'];

// Known marketing-studio preset tiles as of 2026-04-21. Used for validation
// warnings only; the selector tries exact name match regardless.
export const MARKETING_PRESETS = [
  'UGC', 'Tutorial', 'Unboxing', 'Hyper Motion', 'Product Review',
  'Testimonial', 'How-To', 'Founder Story', 'Product Showcase'
];

async function selectPresetByName(page, name) {
  if (!name) return false;
  const btn = await page.$(`button:has-text("${name}"), [role="button"]:has-text("${name}")`);
  if (!btn) return false;
  await btn.click().catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

// Click the preset tile whose label matches `name`. Prefers tiles where the
// ENTIRE first line exactly matches `name`; falls back to contains-match on
// label/title text. Uses Playwright click so React synthetic events fire.
// Returns true if a tile was clicked, false if no match was found.
export async function selectMarketingPreset(page, name) {
  if (!name) return false;
  const handleJs = await page.evaluateHandle(n => {
    const all = Array.from(document.querySelectorAll('button, [role="button"], [data-preset], div[tabindex="0"]'));
    const exact = [];
    const contains = [];
    for (const el of all) {
      const t = (el.innerText || '').trim();
      if (!t) continue;
      const line1 = t.split('\n')[0].trim();
      if (line1 === n) {
        const r = el.getBoundingClientRect();
        if (r.width >= 60 && r.height >= 40) exact.push({ el, r });
      } else if (line1.toLowerCase() === n.toLowerCase()) {
        const r = el.getBoundingClientRect();
        if (r.width >= 60 && r.height >= 40) contains.push({ el, r });
      }
    }
    const pool = exact.length > 0 ? exact : contains;
    if (pool.length === 0) return null;
    // Prefer the largest visible match (preset tiles tend to be big cards).
    pool.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
    return pool[0].el;
  }, name);
  const el = handleJs.asElement ? handleJs.asElement() : null;
  if (!el) return false;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ force: true }).catch(() => {});
  await page.waitForTimeout(700);
  return true;
}

export async function runMarketing(argv) {
  if (!argv.prompt) throw new Error('--prompt is required');

  const runId = `${timestampForRunId()}-${slugFromPrompt(argv.prompt)}`;
  const runDir = argv.output ? argv.output : join(OUTPUT_ROOT, runId);
  const projectUrl = argv.projectId
    ? `https://higgsfield.ai/marketing-studio?marketing-project-id=${argv.projectId}`
    : 'https://higgsfield.ai/marketing-studio';

  await initState(runDir, {
    run_id: runId,
    cmd: 'marketing',
    model_frontend: 'marketing-studio',
    model_backend: SLUG,
    tool_url: projectUrl,
    prompt: argv.prompt,
    params: { preset: argv.preset || null, project_id: argv.projectId || null, new_project: !!argv.new },
    cost_credits_expected: EXPECTED_COST,
    force_used: !!argv.force
  });

  if (argv.dryRun) {
    console.log(`[higgsfield] --dry-run: would open ${projectUrl}, click preset "${argv.preset || '(pre-selected)'}", type prompt, click Generate.`);
    return { dry_run: true, runDir };
  }

  const ctx = await launchContext({ force: !!argv.force, headless: false });
  let walletBefore = null;
  try {
    await ctx.page.goto(projectUrl, { waitUntil: 'load', timeout: 45000 });
    const wait = await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    if (!wait.ok) throw new Error(`No Clerk JWT observed: ${wait.reason}`);

    await browsePhase(ctx.page);
    walletBefore = await preflight(ctx.page, runDir, { expectedCost: EXPECTED_COST, jwtCapture: ctx.jwtCapture, costCap: parseCostCap(argv) });

    if (argv.preset) {
      const ok = await selectPresetByName(ctx.page, argv.preset);
      console.log(`[higgsfield] preset selection by name "${argv.preset}": ${ok ? 'clicked' : 'NOT FOUND (pre-selected state assumed)'}`);
    }

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
      slug: SLUG, prompt: argv.prompt, responseTimeoutMs: 60000
    });

    await transition(runDir, 'polling', {});
    console.log('[higgsfield] waiting for marketing video asset (up to 30 min)...');
    const fresh = await waitForNewAssets(ctx.page, userSubstr, preSet, {
      expectCount: 1, timeoutMs: 30 * 60 * 1000, pollMs: 5000, requireKind: 'video'
    });
    fresh.forEach(f => console.log(`  ${f.kind}: ${f.cdn}`));

    const records = await downloadAll(runDir, fresh.map(bestDownloadUrl));
    const walletAfter = await getWallet(ctx.page, ctx.jwtCapture);
    const meta = await finalize(runDir, {
      wallet_before: walletTotal(walletBefore),
      wallet_after: walletTotal(walletAfter),
      job_uuid: submission.job_uuid, job: null, records,
      cmd: 'marketing', model_frontend: 'marketing-studio', model_backend: SLUG,
      prompt: argv.prompt, params: { preset: argv.preset || null, project_id: argv.projectId || null }
    });
    console.log(`[higgsfield] SAVED ${records.length} file(s) to ${runDir}; ~${meta.cost_credits_actual} credits`);
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

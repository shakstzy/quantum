// batch.mjs -- parallel submission of N jobs in ONE browser session.
// Supports four cmds: image, video, marketing, cinema. Strategy:
//   1. Open the cmd's landing URL once, snapshot baseline assets.
//   2. Sequentially type-prompt + click Generate for each spec, capturing each
//      job_uuid from the POST response. The Higgsfield backend queues and
//      processes jobs server-side in parallel.
//   3. Concurrency cap: HF_MAX_CONCURRENT (default 4). When the inflight count
//      reaches the cap, wait for any one job to complete before submitting the
//      next. Higgsfield per-account cap ~8; per-model caps can be lower.
//   4. Completion detection: API poll first (platform.higgsfield.ai/requests/
//      <uuid>/status), History-panel asset diffing as fallback.
//
// CLI:
//   node scripts/run.mjs batch --jobs jobs.jsonl [--concurrency 4]
//
// jobs.jsonl format (one JSON object per line):
//   image:     {"prompt":"...", "cmd":"image", "model":"nano-banana-pro", "aspect":"1:1"}
//   video:     {"prompt":"...", "cmd":"video", "model":"seedance_2_0_fast", "duration":"5"}
//   marketing: {"prompt":"...", "cmd":"marketing", "preset":"UGC", "ref":["/path.webp"]}
//   cinema:    {"prompt":"...", "cmd":"cinema", "mode":"image"}
//
// All jobs in one batch share a cmd. Mixed cmd batches are rejected (each cmd
// lives on a different tool page).

import { launchContext } from './browser.mjs';
import { browsePhase, pause, pauseJitter } from './behavior.mjs';
import { initState, slugFromPrompt, timestampForRunId, transition } from './state.mjs';
import { downloadAll, finalize, preflight, getWallet, parseCostCap, walletTotal } from './job.mjs';
import {
  submitViaUI, openHistoryPanel, scrapeUserAssets, waitForNewAssets,
  userIdFromJwtCapture, bestDownloadUrl, selectPicker, enableUnlimitedToggle,
  uploadReferenceImages, clearReferenceImages, clearPersistedAttachments
} from './ui-submit.mjs';
import { VIDEO_CATALOG, selectVideoModel } from './video.mjs';
import { selectCinemaMode, selectCinemaModel, CINEMA_MODE_CATALOG } from './cinema.mjs';
import { selectMarketingPreset, MARKETING_PRESETS } from './marketing.mjs';
import { waitForCapturedJwt } from './jwt.mjs';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';

const OUTPUT_ROOT = process.env.HF_OUTPUT_DIR || `${process.env.HOME}/.quantum/skill-output/higgsfield`;
// Reports: account-wide cap appears to be 8; per-model caps can be lower
// (Nano Banana Pro "unlimited" reportedly caps at 4). Default to 4 to stay
// under the strictest per-model cap; bump via --concurrency or env.
const DEFAULT_CONCURRENCY = parseInt(process.env.HF_MAX_CONCURRENT || '4', 10);
const MAX_CONCURRENCY_CEILING = 8;
const JOB_POLL_INTERVAL_MS = 4000;
const JOB_POLL_TIMEOUT_MS = 12 * 60 * 1000; // 12 min per job

// Picker-label sets. Image config bar has aspect/res/batch pills; video adds
// duration and uses its own aspect / resolution vocabulary.
const ASPECT_LABELS           = ['Auto', '1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '4:5', '5:4'];
const RESOLUTION_LABELS       = ['1k', '1K', '2k', '2K', '4k', '4K', '720p', '1080p', 'High', 'Medium', 'Low', 'Auto'];
const BATCH_LABELS            = ['1/4', '2/4', '3/4', '4/4', '1/1', '1/2', '2/2'];
const VIDEO_ASPECT_LABELS     = ['16:9', '9:16', '1:1', '4:3', '3:4', 'Auto'];
const VIDEO_DURATION_LABELS   = ['3s', '5s', '8s', '10s', '15s', '3.0s', '5.0s', '8.0s', '10.0s', '15.0s'];
const VIDEO_RESOLUTION_LABELS = ['720p', '1080p'];
const VIDEO_URL               = 'https://higgsfield.ai/ai/video';
const MARKETING_URL           = 'https://higgsfield.ai/marketing-studio';
const MARKETING_SLUG          = 'marketing_studio_video';
const MARKETING_COST          = 48;
const CINEMA_URL              = 'https://higgsfield.ai/cinema-studio?autoSelectFolder=true';

// Minimal model table for URL resolution in v1. A job's frontend model is
// validated against image.mjs's MODEL_CATALOG at runtime.
async function importImageCatalog() {
  const mod = await import('./image.mjs');
  return mod.MODEL_CATALOG_PUBLIC || null;
}

function parseJobsFile(path) {
  if (!existsSync(path)) throw new Error(`Jobs file not found: ${path}`);
  const content = readFileSync(path, 'utf8').trim();
  if (!content) throw new Error(`Jobs file is empty: ${path}`);
  const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
  const jobs = [];
  for (const [i, line] of lines.entries()) {
    try {
      const j = JSON.parse(line);
      if (!j.prompt) throw new Error(`line ${i + 1}: missing "prompt"`);
      const cmd = j.cmd || 'image';
      // image + video require a model; marketing + cinema don't (marketing has a
      // single slug; cinema routes via "mode").
      if ((cmd === 'image' || cmd === 'video') && !j.model) {
        throw new Error(`line ${i + 1}: cmd="${cmd}" requires "model"`);
      }
      jobs.push(j);
    } catch (e) {
      throw new Error(`Invalid job spec on line ${i + 1}: ${e.message}`);
    }
  }
  return jobs;
}

// Collect jobs from --jobs file OR repeated --prompt inline flags.
function collectJobs(argv) {
  if (argv.jobs) return parseJobsFile(pathResolve(argv.jobs));
  const prompts = Array.isArray(argv.prompt) ? argv.prompt : (argv.prompt ? [argv.prompt] : []);
  if (prompts.length === 0) return [];
  const base = { model: argv.model, aspect: argv.aspect, res: argv.res, batch: argv.batch };
  return prompts.map(p => ({ ...base, prompt: p }));
}

// Poll Higgsfield's job-status endpoint for a given uuid. Tries the official
// public-SDK path (platform.higgsfield.ai/requests/<id>/status) first, then
// web-internal fallbacks. Returns 'completed' | 'failed' | in-progress state
// | 'unknown' if no endpoint answers.
async function pollJobApi(page, jwtCapture, jobUuid) {
  const urls = [
    `https://platform.higgsfield.ai/requests/${jobUuid}/status`,
    `https://fnf.higgsfield.ai/api/v3/jobs/${jobUuid}`,
    `https://fnf.higgsfield.ai/v3/jobs/${jobUuid}`,
    `https://fnf.higgsfield.ai/api/v2/jobs/${jobUuid}`
  ];
  for (const url of urls) {
    try {
      const resp = await page.request.get(url, {
        headers: jwtCapture?.token ? { 'Authorization': `Bearer ${jwtCapture.token}` } : {},
        timeout: 10000
      });
      if (!resp.ok()) continue;
      const body = await resp.json().catch(() => null);
      if (!body) continue;
      return parseJobBody(body);
    } catch (_) {}
  }
  return { status: 'unknown' };
}

function parseJobBody(body) {
  const status = String(body.status || body.state || body.job_status || '').toLowerCase();
  const terminal = ['completed', 'succeeded', 'success', 'done', 'finished'].includes(status);
  const failed   = ['failed', 'error', 'canceled', 'cancelled'].includes(status);
  // Try several places for asset URLs.
  const candidates = [];
  for (const key of ['results', 'outputs', 'files', 'assets', 'urls', 'output']) {
    const v = body[key];
    if (!v) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') candidates.push(item);
        else if (item?.url) candidates.push(item.url);
        else if (item?.cdn) candidates.push(item.cdn);
        else if (item?.file) candidates.push(item.file);
      }
    } else if (typeof v === 'string') {
      candidates.push(v);
    }
  }
  return { status: terminal ? 'completed' : (failed ? 'failed' : status || 'unknown'), assets: candidates, raw: body };
}

// Correlate fresh History assets to inflight jobs. Prefers asset dimensions
// matching each job's expected width/height (from the POST response params).
// Falls back to FIFO (oldest asset -> earliest submitted job) only for jobs
// that can't be uniquely matched by dimensions. This defends against
// out-of-order completion (a fast job after a slow job) and -- partially --
// foreign-tab generations (those will typically not match expected dims).
async function correlateAssets(page, freshAssets, inflightOrder, inflightMap) {
  const byOldest = [...freshAssets].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  const map = new Map(); // uuid -> { asset, method: 'dim' | 'fifo' }
  const assetInfo = await Promise.all(byOldest.map(async a => {
    // Fetch image dims via HEAD or a cheap fetch. Higgsfield CDN URLs don't expose
    // dims in headers; probe via new Image() inside page context.
    const dims = await page.evaluate(url => {
      return new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: null, h: null });
        img.src = url;
        setTimeout(() => resolve({ w: null, h: null }), 4000);
      });
    }, a.cdn).catch(() => ({ w: null, h: null }));
    return { asset: a, w: dims.w, h: dims.h };
  }));
  const claimedAsset = new Set();
  const claimedJob = new Set();
  // Pass 1: aspect-ratio match (within 5% tolerance). Server sometimes rounds
  // requested 1344x768 to 1376x768; both are 16:9 for our purposes. Exact
  // pixel match is too tight; aspect-ratio catches the intent.
  for (const uuid of inflightOrder) {
    const entry = inflightMap.get(uuid);
    if (!entry) continue;
    const expW = entry.expected_width, expH = entry.expected_height;
    if (!expW || !expH) continue;
    const expAspect = expW / expH;
    for (const info of assetInfo) {
      if (claimedAsset.has(info.asset.cdn)) continue;
      if (!info.w || !info.h) continue;
      const actualAspect = info.w / info.h;
      const ratioDiff = Math.abs(actualAspect - expAspect) / expAspect;
      if (ratioDiff < 0.05) {
        map.set(uuid, { asset: info.asset, method: 'aspect' });
        claimedAsset.add(info.asset.cdn);
        claimedJob.add(uuid);
        break;
      }
    }
  }
  // Pass 2: FIFO-fill remaining unclaimed jobs with unclaimed assets (oldest-first).
  const remainingJobs = inflightOrder.filter(u => !claimedJob.has(u));
  const remainingAssets = assetInfo.filter(i => !claimedAsset.has(i.asset.cdn));
  for (let i = 0; i < Math.min(remainingJobs.length, remainingAssets.length); i++) {
    map.set(remainingJobs[i], { asset: remainingAssets[i].asset, method: 'fifo' });
  }
  return map;
}

// Wait until the Generate button near the prompt is ready (enabled + cost-label
// style "Generate <n>"). Prevents rapid-click from landing while a previous
// submit is still pending.
async function waitForGenerateReady(page, { timeoutMs = 12000 } = {}) {
  const start = Date.now();
  const probe = () => page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button')).filter(b => {
      const t = (b.innerText || '').trim();
      if (!/^generate\b/i.test(t)) return false;
      const r = b.getBoundingClientRect();
      return r.width > 40 && r.height > 20 && window.getComputedStyle(b).visibility !== 'hidden';
    });
    if (candidates.length === 0) return null;
    const btn = candidates.find(b => {
      if (b.disabled) return false;
      if (b.getAttribute('aria-disabled') === 'true') return false;
      const t = (b.innerText || '').trim();
      return !/generating|processing|loading/i.test(t);
    });
    return btn ? (btn.innerText || '').trim() : null;
  });
  while (Date.now() - start < timeoutMs) {
    const snap1 = await probe();
    if (snap1) {
      // Stability window: re-probe 300 ms later; if the label has not drifted,
      // we trust the UI has settled (cost is no longer animating from prior job).
      await pause(300);
      const snap2 = await probe();
      if (snap2 === snap1) return true;
    }
    await pause(250);
  }
  return false;
}

// Apply per-job picker + upload mutations. Returns updated params_for_state.
async function applyJobParams(ctx, spec, { isVideo = false, pickerMaxDist = null } = {}) {
  const params = {
    aspect_ratio: spec.aspect || null,
    resolution: spec.res || null,
    batch_size: spec.batch ? parseInt(spec.batch, 10) : null,
    duration: spec.duration || null,
    ref_files: null
  };
  const aspLabels = isVideo ? VIDEO_ASPECT_LABELS : ASPECT_LABELS;
  const resLabels = isVideo ? VIDEO_RESOLUTION_LABELS : RESOLUTION_LABELS;
  // /ai/video + cinema/marketing often put config pills in a LEFT sidebar far
  // from the prompt; caller can widen the proximity window via pickerMaxDist.
  if (pickerMaxDist == null && isVideo) pickerMaxDist = 900;
  if (spec.aspect) {
    const r = await selectPicker(ctx.page, { currentLabels: aspLabels, target: spec.aspect, maxDist: pickerMaxDist });
    if (r !== 'already_selected' && r !== 'selected') {
      throw Object.assign(new Error(`Batch item aspect="${spec.aspect}" failed: ${r}`), { code: 'UI_PICKER_FAIL' });
    }
  }
  if (spec.res) {
    const r = await selectPicker(ctx.page, { currentLabels: resLabels, target: spec.res, maxDist: pickerMaxDist });
    if (r !== 'already_selected' && r !== 'selected') {
      throw Object.assign(new Error(`Batch item res="${spec.res}" failed: ${r}`), { code: 'UI_PICKER_FAIL' });
    }
  }
  if (isVideo && spec.duration) {
    // Normalize: dropdown options render as "5.0s" (float) while the pill may
    // show "5s" (int). Try both forms.
    const raw = String(spec.duration).trim().replace(/s$/i, '');
    const n = parseFloat(raw);
    if (!isFinite(n)) throw new Error(`Invalid duration: ${spec.duration}`);
    const candidates = [`${n.toFixed(1)}s`, `${Math.round(n)}s`];
    let lastResult = 'option_not_found';
    for (const target of candidates) {
      const r = await selectPicker(ctx.page, { currentLabels: VIDEO_DURATION_LABELS, target, maxDist: pickerMaxDist });
      if (r === 'already_selected' || r === 'selected') { lastResult = r; break; }
      lastResult = r;
    }
    if (lastResult !== 'already_selected' && lastResult !== 'selected') {
      throw Object.assign(new Error(`Batch item duration="${n}" failed: ${lastResult}`), { code: 'UI_PICKER_FAIL' });
    }
  }
  if (!isVideo && spec.batch) {
    const label = `${spec.batch}/4`;
    const r = await selectPicker(ctx.page, { currentLabels: BATCH_LABELS, target: label });
    if (r !== 'already_selected' && r !== 'selected') {
      throw Object.assign(new Error(`Batch item batch="${label}" failed: ${r}`), { code: 'UI_PICKER_FAIL' });
    }
  }
  // Always clear existing attachments first -- includes chips from prior jobs
  // in this same batch that the previous submit may not have consumed.
  const cleared = await clearReferenceImages(ctx.page);
  if (cleared > 0) console.log(`[higgsfield-batch]   cleared ${cleared} stale attachment chip(s)`);
  const refs = Array.isArray(spec.ref) ? spec.ref : (spec.ref ? [spec.ref] : []);
  if (refs.length > 0) {
    const absPaths = refs.map(p => pathResolve(p));
    const u = await uploadReferenceImages(ctx.page, absPaths, { clearExisting: false });
    console.log(`[higgsfield-batch]   uploaded ${u.uploaded} ref(s) via input @ ${u.dist_from_prompt}px`);
    params.ref_files = absPaths;
  }
  return params;
}

// Resolve the mode-specific configuration for a batch. Returns an object with:
//   url                    Landing URL for the tool page
//   perBatchKind           'image' | 'video' | 'mixed' (cinema can be mixed)
//   resolveSlug(spec)      Backend slug for POST /jobs/<slug>
//   resolveCost(spec)      Expected cost credits per job
//   resolveToolUrl(spec)   Per-job tool_url written to state.json
//   resolveFrontendModel(spec)  Frontend model label for metadata
//   resolveBackendSlug(spec)    Backend slug stored in metadata
//   resolveAssetKind(spec) 'image' | 'video' (for reap-filter)
//   setupPerJob(ctx, spec, prevSpec, isFirst)  Async: pickers / mode tab / model / preset
//   pickerMaxDist          maxDist for selectPicker (video/cinema sidebar ~900)
async function resolveModeSpec(batchCmd, jobs) {
  if (batchCmd === 'image') {
    const catalog = (await import('./image.mjs')).MODEL_CATALOG_PUBLIC;
    if (!catalog) throw new Error('image.mjs MODEL_CATALOG_PUBLIC not exported.');
    for (const [i, j] of jobs.entries()) {
      if (!j.model) throw new Error(`Job ${i + 1}: image batch requires "model".`);
      if (!catalog[j.model]) throw new Error(`Job ${i + 1}: unknown image model "${j.model}". Valid: ${Object.keys(catalog).slice(0, 10).join(', ')}...`);
    }
    return {
      url: catalog[jobs[0].model].url,
      perBatchKind: 'image',
      resolveCost: spec => catalog[spec.model].expected_cost || 0,
      resolveToolUrl: spec => catalog[spec.model].url,
      resolveFrontendModel: spec => spec.model,
      resolveBackendSlug: spec => catalog[spec.model].backend_slug,
      resolveAssetKind: () => 'image',
      pickerMaxDist: null,
      setupPerJob: async (ctx, spec, prevSpec, isFirst) => {
        const needSwitch = (!prevSpec || prevSpec.model !== spec.model);
        if (needSwitch) {
          const cat = catalog[spec.model];
          const r = await selectPicker(ctx.page, {
            currentLabels: Object.values(catalog).map(m => m.frontend_label),
            target: cat.frontend_label
          });
          if (r !== 'already_selected' && r !== 'selected') {
            throw Object.assign(new Error(`model switch failed: ${r}`), { code: 'UI_MODEL_SWITCH_FAIL' });
          }
        }
      }
    };
  }
  if (batchCmd === 'video') {
    for (const [i, j] of jobs.entries()) {
      if (!j.model) throw new Error(`Job ${i + 1}: video batch requires "model".`);
      if (!VIDEO_CATALOG[j.model]) throw new Error(`Job ${i + 1}: unknown video model "${j.model}". Valid: ${Object.keys(VIDEO_CATALOG).join(', ')}`);
    }
    return {
      url: VIDEO_URL,
      perBatchKind: 'video',
      resolveCost: spec => VIDEO_CATALOG[spec.model].cost || 0,
      resolveToolUrl: () => VIDEO_URL,
      resolveFrontendModel: spec => spec.model,
      resolveBackendSlug: spec => VIDEO_CATALOG[spec.model].backend_slug || spec.model,
      resolveAssetKind: () => 'video',
      pickerMaxDist: 900,
      setupPerJob: async (ctx, spec, prevSpec, isFirst) => {
        const needSwitch = isFirst || !prevSpec || prevSpec.model !== spec.model;
        if (needSwitch) {
          const ok = await selectVideoModel(ctx.page, VIDEO_CATALOG[spec.model].frontend_label);
          if (!ok) throw Object.assign(new Error(`video model select failed: ${VIDEO_CATALOG[spec.model].frontend_label}`), { code: 'UI_MODEL_SWITCH_FAIL' });
        }
      }
    };
  }
  if (batchCmd === 'marketing') {
    for (const [i, j] of jobs.entries()) {
      if (j.preset && !MARKETING_PRESETS.includes(j.preset)) {
        console.warn(`[higgsfield-batch] job ${i + 1}: preset "${j.preset}" not in known list (${MARKETING_PRESETS.join(', ')}). Will attempt click by name.`);
      }
    }
    return {
      url: MARKETING_URL,
      perBatchKind: 'video',
      resolveCost: () => MARKETING_COST,
      resolveToolUrl: () => MARKETING_URL,
      resolveFrontendModel: () => 'marketing-studio',
      resolveBackendSlug: () => MARKETING_SLUG,
      resolveAssetKind: () => 'video',
      pickerMaxDist: null,
      setupPerJob: async (ctx, spec, prevSpec, isFirst) => {
        if (spec.preset && (!prevSpec || prevSpec.preset !== spec.preset)) {
          const ok = await selectMarketingPreset(ctx.page, spec.preset);
          if (!ok) {
            console.warn(`[higgsfield-batch]   preset "${spec.preset}" not found; using current selection`);
          }
        }
      }
    };
  }
  if (batchCmd === 'cinema') {
    // Cinema supports both image and video modes. The real mode-switch tabs
    // live in the config bar at x>=300 (sidebar-nav tabs at x<300 would
    // navigate away; selectCinemaMode filters them out).
    for (const [i, j] of jobs.entries()) {
      const m = j.mode || 'video';
      if (!CINEMA_MODE_CATALOG[m]) throw new Error(`Job ${i + 1}: unknown cinema mode "${m}". Valid: ${Object.keys(CINEMA_MODE_CATALOG).join(', ')}`);
    }
    return {
      url: CINEMA_URL,
      perBatchKind: 'mixed',
      resolveCost: spec => CINEMA_MODE_CATALOG[spec.mode || 'video'].cost,
      resolveToolUrl: () => CINEMA_URL,
      resolveFrontendModel: spec => `cinema-studio-${spec.mode || 'video'}`,
      resolveBackendSlug: spec => CINEMA_MODE_CATALOG[spec.mode || 'video'].slug,
      resolveAssetKind: spec => (spec.mode === 'image' ? 'image' : 'video'),
      pickerMaxDist: 900,
      setupPerJob: async (ctx, spec, prevSpec, isFirst) => {
        const mode = spec.mode || 'video';
        const prevMode = prevSpec?.mode || (prevSpec ? 'video' : null);
        if (isFirst || prevMode !== mode) {
          const ok = await selectCinemaMode(ctx.page, mode);
          if (!ok) throw Object.assign(new Error(`cinema mode tab switch failed: ${mode}`), { code: 'UI_MODE_TAB_FAIL' });
        }
        if (spec.cinemaModel && (isFirst || prevSpec?.cinemaModel !== spec.cinemaModel)) {
          const ok = await selectCinemaModel(ctx.page, spec.cinemaModel);
          if (!ok) throw Object.assign(new Error(`cinema model select failed: ${spec.cinemaModel}`), { code: 'UI_MODEL_SWITCH_FAIL' });
        }
      }
    };
  }
  throw new Error(`Unsupported cmd "${batchCmd}". Use image | video | marketing | cinema.`);
}

export async function runBatch(argv) {
  const jobs = collectJobs(argv);
  if (jobs.length === 0) {
    throw new Error('No jobs provided. Use --jobs <file.jsonl> or pass multiple --prompt flags with --model.');
  }
  // Validate all jobs share a single cmd. Each cmd lives on its own tool page;
  // mid-batch navigation would break session continuity.
  const cmds = new Set(jobs.map(j => j.cmd || 'image'));
  if (cmds.size > 1) {
    throw new Error(`Batch requires all jobs share cmd. Got: ${[...cmds].join(', ')}`);
  }
  const batchCmd = [...cmds][0];

  const mode = await resolveModeSpec(batchCmd, jobs);
  const isVideoLike = mode.perBatchKind === 'video' || mode.perBatchKind === 'mixed';

  let concurrency = parseInt(argv.concurrency || DEFAULT_CONCURRENCY, 10);
  if (!(concurrency >= 1 && concurrency <= MAX_CONCURRENCY_CEILING)) {
    throw new Error(`--concurrency must be between 1 and ${MAX_CONCURRENCY_CEILING}`);
  }
  // Per-job drain-timeout: videos generate much slower (1-3 min typ, up to 30 min for long).
  const perJobTimeoutMs = isVideoLike ? 40 * 60 * 1000 : JOB_POLL_TIMEOUT_MS;
  console.log(`[higgsfield-batch] cmd=${batchCmd} ${jobs.length} job(s), concurrency=${concurrency}, landing=${mode.url}, per-job-timeout=${Math.round(perJobTimeoutMs/60000)}min`);

  if (argv.dryRun) {
    console.log('[higgsfield-batch] --dry-run: would submit the following jobs:');
    jobs.forEach((j, i) => {
      const desc = batchCmd === 'cinema' ? `mode=${j.mode || 'video'}`
                 : batchCmd === 'marketing' ? `preset=${j.preset || 'current'}`
                 : j.model;
      console.log(`  [${i + 1}] ${batchCmd}/${desc} | aspect=${j.aspect || 'default'} | duration=${j.duration || 'default'} | "${j.prompt.slice(0, 70)}"`);
    });
    return { dry_run: true, count: jobs.length };
  }

  const ctx = await launchContext({ force: !!argv.force, headless: false });
  try {
    await ctx.page.goto(mode.url, { waitUntil: 'load', timeout: 45000 });
    const wait = await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    if (!wait.ok) throw new Error(`No Clerk JWT observed: ${wait.reason}. Run 'node scripts/run.mjs login' first.`);

    // Purge persisted attachments BEFORE anything else so jobs submit clean.
    const cleared = await clearPersistedAttachments(ctx.page);
    if (cleared.changed.length) console.log(`[higgsfield-batch] cleared persisted attachments in ${cleared.changed.length} localStorage key(s)`);

    await browsePhase(ctx.page);
    // Skip wallet preflight per-job; we do one for the whole batch.
    const totalExpectedCost = jobs.reduce((s, j) => {
      const unit = mode.resolveCost(j);
      return s + unit * (parseInt(j.batch || '1', 10) || 1);
    }, 0);
    // Batch-level preflight has no per-run state.json. Pass null runDir so
    // preflight skips state transitions; failures should ABORT (not warn) since
    // we've validated wallet, captcha, and the per-batch cost cap.
    try {
      await preflight(ctx.page, null, {
        expectedCost: totalExpectedCost,
        jwtCapture: ctx.jwtCapture,
        costCap: parseCostCap(argv)
      });
    } catch (e) {
      console.error(`[higgsfield-batch] preflight FAILED: ${e.message}`);
      throw e;
    }

    const userSub = userIdFromJwtCapture(ctx.jwtCapture);
    if (!userSub) throw new Error('Could not extract user_id from captured JWT.');
    const userSubstr = userSub.replace(/^user_/, '');
    await openHistoryPanel(ctx.page);
    const preBaseline = await scrapeUserAssets(ctx.page, userSubstr);
    const baselineCdns = new Set(preBaseline.map(x => x.cdn));
    // History panel is lazy-loaded: scrapeUserAssets only sees what's currently
    // mounted. Asset filenames embed UTC YYYYMMDDHHMMSS — gate fresh assets on
    // batchStartTs so older items that scroll into view later don't leak through.
    const batchStartTs = timestampForRunId().replace('-', ''); // strip the '-' between date+time
    console.log(`[higgsfield-batch] baseline: ${baselineCdns.size} pre-existing user assets; gating fresh assets at ts >= ${batchStartTs}`);

    const unlimState = await enableUnlimitedToggle(ctx.page);
    console.log(`[higgsfield-batch] unlimited toggle: ${unlimState}`);

    // Inflight tracker keyed by job_uuid, preserving submit order for FIFO fallback.
    const inflight = new Map(); // job_uuid -> { spec, runDir, submittedAt, params_for_state, expectedCost, apiAttempts }
    const results = [];
    const failures = [];
    const submitOrder = []; // [job_uuid, job_uuid, ...] in submit order

    // Reaper: scans History once, correlates fresh assets to inflight jobs, downloads + finalizes any that complete.
    async function reap() {
      if (inflight.size === 0) return;
      // Try API poll for each inflight first.
      for (const [uuid, entry] of [...inflight.entries()]) {
        entry.apiAttempts = (entry.apiAttempts || 0) + 1;
        const apiResult = await pollJobApi(ctx.page, ctx.jwtCapture, uuid);
        if (apiResult.status === 'completed' && apiResult.assets.length > 0) {
          console.log(`[higgsfield-batch] job ${uuid} completed (api) with ${apiResult.assets.length} asset(s)`);
          await finalizeJob(entry, uuid, apiResult.assets);
          inflight.delete(uuid);
        } else if (apiResult.status === 'failed') {
          console.warn(`[higgsfield-batch] job ${uuid} failed (api)`);
          failures.push({ uuid, reason: 'api_failed', raw: apiResult.raw });
          inflight.delete(uuid);
        }
        // else: 'unknown' or in-progress; leave it inflight.
      }
      if (inflight.size === 0) return;
      // History-panel fallback: look for fresh assets not yet tied to anyone.
      const all = await scrapeUserAssets(ctx.page, userSubstr);
      const fresh = all.filter(a => {
        if (baselineCdns.has(a.cdn) || baselineCdns.has(a.derivedMp4Url || '')) return false;
        // Timestamp gate: must be lex-comparable >= batch start (14-digit YYYYMMDDHHMMSS).
        // Empty / missing timestamp is rejected to fail closed.
        if (!a.timestamp || a.timestamp.length !== 14) return false;
        return a.timestamp >= batchStartTs;
      });
      // In cinema batches, the kind mix can be image + video. For pure image or
      // pure video batches, filter down to just matching kind so foreign-tab
      // generations of the other kind don't pollute the pool.
      const freshMatching = fresh.filter(a => {
        if (mode.perBatchKind === 'mixed') return true;
        if (mode.perBatchKind === 'video') return a.kind === 'video' || a.kind === 'video_thumbnail';
        return a.kind === 'image';
      });
      if (freshMatching.length === 0) return;
      // For mixed cinema batches, assign each asset only to jobs expecting its kind.
      const order = submitOrder.filter(u => inflight.has(u));
      let corrSource = freshMatching;
      if (mode.perBatchKind === 'mixed') {
        // Split by kind and correlate separately, then merge.
        const imgAssets = freshMatching.filter(a => a.kind === 'image');
        const vidAssets = freshMatching.filter(a => a.kind === 'video' || a.kind === 'video_thumbnail');
        const imgJobs = order.filter(u => inflight.get(u)?.asset_kind === 'image');
        const vidJobs = order.filter(u => inflight.get(u)?.asset_kind === 'video');
        const m1 = imgJobs.length > 0 ? await correlateAssets(ctx.page, imgAssets, imgJobs, inflight) : new Map();
        const m2 = vidJobs.length > 0 ? await correlateAssets(ctx.page, vidAssets, vidJobs, inflight) : new Map();
        const merged = new Map([...m1, ...m2]);
        for (const [uuid, { asset, method }] of merged) {
          const entry = inflight.get(uuid);
          if (!entry) continue;
          console.log(`[higgsfield-batch] job ${uuid} matched via ${method} -> ${asset.cdn.split('/').pop()}`);
          await finalizeJob(entry, uuid, [bestDownloadUrl(asset)], method);
          inflight.delete(uuid);
          baselineCdns.add(asset.cdn);
          if (asset.derivedMp4Url) baselineCdns.add(asset.derivedMp4Url);
        }
      } else {
        const corr = await correlateAssets(ctx.page, corrSource, order, inflight);
        for (const [uuid, { asset, method }] of corr) {
          const entry = inflight.get(uuid);
          if (!entry) continue;
          console.log(`[higgsfield-batch] job ${uuid} matched via ${method} -> ${asset.cdn.split('/').pop()}`);
          await finalizeJob(entry, uuid, [bestDownloadUrl(asset)], method);
          inflight.delete(uuid);
          baselineCdns.add(asset.cdn);
          if (asset.derivedMp4Url) baselineCdns.add(asset.derivedMp4Url);
        }
      }
      // Absorb any unmatched fresh assets into baseline so a foreign-tab
      // generation doesn't pollute a later reap. Only do this when we have
      // no inflight jobs left (safer to leave potential matches floating).
      if (inflight.size === 0) {
        for (const a of freshMatching) {
          baselineCdns.add(a.cdn);
          if (a.derivedMp4Url) baselineCdns.add(a.derivedMp4Url);
        }
      }
    }

    async function finalizeJob(entry, uuid, assetUrls, matchMethod = 'unknown') {
      try {
        await transition(entry.runDir, 'polling', {});
        const records = await downloadAll(entry.runDir, assetUrls);
        // Post-download verification: compare actual image dimensions to the
        // width/height from the POST response params. Mismatch means FIFO
        // pairing slipped; we surface a warning and embed the warning in
        // metadata so downstream tooling can catch silent corruption.
        let dimWarning = null;
        try {
          if (entry.expected_width && entry.expected_height && records[0]?.local_path) {
            const { spawnSync } = await import('node:child_process');
            const out = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', records[0].local_path], { encoding: 'utf8' });
            const wm = /pixelWidth:\s*(\d+)/.exec(out.stdout || '');
            const hm = /pixelHeight:\s*(\d+)/.exec(out.stdout || '');
            if (wm && hm) {
              const actualW = parseInt(wm[1], 10), actualH = parseInt(hm[1], 10);
              const expAspect = entry.expected_width / entry.expected_height;
              const actAspect = actualW / actualH;
              const ratioDiff = Math.abs(actAspect - expAspect) / expAspect;
              if (ratioDiff > 0.05) {
                dimWarning = `aspect-mismatch: expected ${entry.expected_width}x${entry.expected_height} (~${expAspect.toFixed(3)}), got ${actualW}x${actualH} (~${actAspect.toFixed(3)}) (match=${matchMethod})`;
                console.warn(`[higgsfield-batch] WARNING ${uuid}: ${dimWarning}`);
              }
            }
          }
        } catch (_) {}
        const walletAfter = await getWallet(ctx.page, ctx.jwtCapture).catch(() => null);
        const meta = await finalize(entry.runDir, {
          wallet_before: entry.wallet_before,
          wallet_after: walletTotal(walletAfter),
          job_uuid: uuid,
          job: null,
          records,
          cmd: batchCmd,
          model_frontend: mode.resolveFrontendModel(entry.spec),
          model_backend: mode.resolveBackendSlug(entry.spec),
          prompt: entry.spec.prompt,
          params: { ...entry.params_for_state, _match_method: matchMethod, _dim_warning: dimWarning }
        });
        results.push({ uuid, runDir: entry.runDir, prompt: entry.spec.prompt, records, meta });
        console.log(`[higgsfield-batch] SAVED job ${uuid} -> ${entry.runDir} (${records.length} file(s))`);
      } catch (e) {
        console.error(`[higgsfield-batch] finalize failed for ${uuid}: ${e.message}`);
        failures.push({ uuid, runDir: entry.runDir, reason: e.message });
      }
    }

    // Main submit loop.
    for (let i = 0; i < jobs.length; i++) {
      const spec = jobs[i];
      console.log(`[higgsfield-batch] [${i + 1}/${jobs.length}] preparing: "${spec.prompt.slice(0, 70)}"`);

      // Respect concurrency cap.
      while (inflight.size >= concurrency) {
        console.log(`[higgsfield-batch] concurrency cap reached (${inflight.size}/${concurrency}), waiting...`);
        await reap();
        if (inflight.size >= concurrency) await pause(JOB_POLL_INTERVAL_MS);
      }

      // Mode-specific setup: model switch for image/video, preset tile for
      // marketing, mode tab + cinema model for cinema. Each implementation
      // handles "already selected" internally and is idempotent.
      const prevSpec = i > 0 ? jobs[i - 1] : null;
      try {
        await mode.setupPerJob(ctx, spec, prevSpec, i === 0);
      } catch (e) {
        console.error(`[higgsfield-batch]   setup failed: ${e.message}`);
        failures.push({ uuid: null, reason: e.message, spec });
        continue;
      }

      const runId = `${timestampForRunId()}-${slugFromPrompt(spec.prompt)}`;
      const runDir = join(OUTPUT_ROOT, runId);

      // Apply per-job picker params + reference uploads.
      let params_for_state;
      try {
        params_for_state = await applyJobParams(ctx, spec, { isVideo: isVideoLike, pickerMaxDist: mode.pickerMaxDist });
      } catch (e) {
        console.error(`[higgsfield-batch]   apply-params failed: ${e.message}`);
        failures.push({ uuid: null, reason: e.message, spec });
        continue;
      }

      const expectedCost = mode.resolveCost(spec);
      const backendSlug = mode.resolveBackendSlug(spec);
      const toolUrl = mode.resolveToolUrl(spec);
      await initState(runDir, {
        run_id: runId,
        cmd: batchCmd,
        model_frontend: mode.resolveFrontendModel(spec),
        model_backend: backendSlug,
        tool_url: toolUrl,
        prompt: spec.prompt,
        params: params_for_state,
        cost_credits_expected: expectedCost,
        force_used: !!argv.force
      });

      // Submit: submitViaUI already clicks the page Generate button and waits
      // for the POST response (yielding job_uuid). That returns quickly --
      // completion is handled asynchronously by reap().
      // Pass expectedCost so cinema-studio's dual-Generate-button panels can
      // disambiguate which button to click (image cost=2, video cost=96).
      let submission;
      try {
        submission = await submitViaUI(ctx.page, ctx.context, runDir, {
          slug: backendSlug,
          prompt: spec.prompt,
          responseTimeoutMs: 60000,
          expectedCost: expectedCost || null
        });
      } catch (e) {
        // Rate-limit? If the error message mentions too many requests, back off + retry once.
        const msg = String(e?.message || '');
        if (/too many|concurrent|rate|429|503/i.test(msg)) {
          console.warn(`[higgsfield-batch]   rate-limit-like error: ${msg}. Backing off for this job only (other inflight continue).`);
          // Back off with jitter; keep other inflight jobs running normally.
          await reap();
          await pause(3000 + Math.floor(Math.random() * 3000));
          try {
            submission = await submitViaUI(ctx.page, ctx.context, runDir, {
              slug: backendSlug,
              prompt: spec.prompt,
              responseTimeoutMs: 60000,
              expectedCost: expectedCost || null
            });
          } catch (e2) {
            console.error(`[higgsfield-batch]   retry failed: ${e2.message}`);
            failures.push({ uuid: null, runDir, reason: e2.message, spec });
            continue;
          }
        } else {
          console.error(`[higgsfield-batch]   submit failed: ${msg}`);
          failures.push({ uuid: null, runDir, reason: msg, spec });
          continue;
        }
      }

      const submittedParams = submission.raw?.job_sets?.[0]?.params || {};
      inflight.set(submission.job_uuid, {
        spec,
        runDir,
        submittedAt: Date.now(),
        params_for_state,
        wallet_before: null,
        apiAttempts: 0,
        asset_kind: mode.resolveAssetKind(spec),
        expected_width: submittedParams.width || null,
        expected_height: submittedParams.height || null
      });
      submitOrder.push(submission.job_uuid);
      console.log(`[higgsfield-batch]   submitted job_uuid=${submission.job_uuid} (${inflight.size} inflight / ${concurrency} max)`);

      // Wait for Generate to be clickable again before the next iteration.
      const ready = await waitForGenerateReady(ctx.page, { timeoutMs: 15000 });
      if (!ready) {
        console.warn(`[higgsfield-batch]   Generate did not become ready within 15s; next submit may fail.`);
      }
      await pauseJitter();
    }

    // Drain remaining inflight. Video jobs have a longer per-job ceiling.
    const drainDeadline = Date.now() + perJobTimeoutMs;
    while (inflight.size > 0 && Date.now() < drainDeadline) {
      await reap();
      if (inflight.size > 0) await pause(JOB_POLL_INTERVAL_MS);
    }
    if (inflight.size > 0) {
      console.warn(`[higgsfield-batch] drain timeout: ${inflight.size} job(s) still pending after ${perJobTimeoutMs / 60000} min:`);
      for (const [uuid, entry] of inflight.entries()) {
        console.warn(`  ${uuid} ("${entry.spec.prompt.slice(0, 50)}") -> ${entry.runDir}`);
        failures.push({ uuid, runDir: entry.runDir, reason: 'drain_timeout', spec: entry.spec });
      }
    }

    console.log(`\n[higgsfield-batch] summary: ${results.length} succeeded, ${failures.length} failed / pending.`);
    if (failures.length > 0) {
      console.log('[higgsfield-batch] failures:');
      failures.forEach(f => console.log(`  ${f.uuid || '(no-uuid)'}: ${f.reason}`));
    }
    return { results, failures, count: jobs.length };
  } finally {
    if (!argv.debug) await ctx.close();
  }
}

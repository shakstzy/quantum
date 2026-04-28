// image.mjs -- nano-banana-pro and soul-cinematic handlers.
// Primary flow: navigate, browse phase, type prompt, click generate, poll, download.

import { launchContext } from './browser.mjs';
import { browsePhase, humanClick, typeHuman, pauseJitter } from './behavior.mjs';
import { initState, readState, slugFromPrompt, timestampForRunId } from './state.mjs';
import { downloadAll, finalize, preflight, getWallet, parseCostCap, walletTotal } from './job.mjs';
import { submitViaUI, openHistoryPanel, scrapeUserAssets, waitForNewAssets, userIdFromJwtCapture, bestDownloadUrl, enableUnlimitedToggle, selectPicker, uploadReferenceImages, clearReferenceImages, clearPersistedAttachments } from './ui-submit.mjs';
import { transition } from './state.mjs';
import { verifyUaChConsistency } from './fingerprint.mjs';
import { waitForCapturedJwt } from './jwt.mjs';
import { join, resolve as pathResolve } from 'node:path';

const OUTPUT_ROOT = process.env.HF_OUTPUT_DIR || `${process.env.HOME}/.quantum/skill-output/higgsfield`;

// argv.ref is either a single string (one --ref flag) or an array (repeated flags,
// normalized in run.mjs). Returns an array of paths.
export function collectRefs(argv) {
  const raw = argv.ref;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

// Image model catalog. `frontend_label` is the line-1 text shown in the model
// picker dropdown (used by selectPicker to click the right tile). `url` is the
// direct-load URL; if omitted, we navigate to /ai/image and switch via the
// picker. Costs are rough defaults at batch=1; actual cost shows on the
// Generate button and is recorded post-submit.
const MODEL_CATALOG = {
  'nano-banana-pro':    { frontend_label: 'Nano Banana Pro',          backend_slug: 'nano_banana_2',   url: 'https://higgsfield.ai/ai/image?model=nano-banana-pro',    expected_cost: 2,  defaults: { aspect_ratio: '3:4',  resolution: '1k', batch_size: 1 } },
  'nano-banana-2':      { frontend_label: 'Nano Banana 2',            backend_slug: 'nano_banana_2',   url: 'https://higgsfield.ai/ai/image?model=nano-banana-2',      expected_cost: 2,  defaults: { aspect_ratio: '3:4',  resolution: '1k', batch_size: 1 } },
  'nano-banana':        { frontend_label: 'Nano Banana',              backend_slug: 'nano_banana',     url: 'https://higgsfield.ai/ai/image?model=nano-banana',        expected_cost: 1,  defaults: { aspect_ratio: '3:4',  resolution: '1k', batch_size: 1 } },
  'soul-cinematic':     { frontend_label: 'Soul Cinema',              backend_slug: 'soul_cinematic',  url: 'https://higgsfield.ai/ai/image?model=soul-cinematic',     expected_cost: 1,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'soul-cinema-new':    { frontend_label: 'Higgsfield Soul Cinema',   backend_slug: 'soul_cinema_new', url: 'https://higgsfield.ai/ai/image',                          expected_cost: 2,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'higgsfield-soul-2':  { frontend_label: 'Higgsfield Soul 2.0',      backend_slug: 'soul_v2',         url: 'https://higgsfield.ai/ai/image',                          expected_cost: 1,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'higgsfield-soul':    { frontend_label: 'Higgsfield Soul',          backend_slug: 'soul',            url: 'https://higgsfield.ai/ai/image',                          expected_cost: 1,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'gpt-image-2':        { frontend_label: 'GPT Image 2',              backend_slug: 'gpt_image_2',     url: 'https://higgsfield.ai/ai/image?model=gpt-image-2',        expected_cost: 7,  defaults: { aspect_ratio: 'Auto', resolution: '2K', batch_size: 1 } },
  'gpt-image-1-5':      { frontend_label: 'GPT Image 1.5',            backend_slug: 'gpt_image_1_5',   url: 'https://higgsfield.ai/ai/image',                          expected_cost: 5,  defaults: { aspect_ratio: 'Auto', resolution: '1K', batch_size: 1 } },
  'gpt-image':          { frontend_label: 'GPT Image',                backend_slug: 'gpt_image',       url: 'https://higgsfield.ai/ai/image',                          expected_cost: 3,  defaults: { aspect_ratio: 'Auto', resolution: '1K', batch_size: 1 } },
  'seedream-5-lite':    { frontend_label: 'Seedream 5.0 lite',        backend_slug: 'seedream_5_lite', url: 'https://higgsfield.ai/ai/image',                          expected_cost: 2,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'seedream-4-5':       { frontend_label: 'Seedream 4.5',             backend_slug: 'seedream_4_5',    url: 'https://higgsfield.ai/ai/image',                          expected_cost: 2,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'seedream-4':         { frontend_label: 'Seedream 4.0',             backend_slug: 'seedream_4',      url: 'https://higgsfield.ai/ai/image',                          expected_cost: 1,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'flux-2-pro':         { frontend_label: 'FLUX.2 Pro',               backend_slug: 'flux_2_pro',      url: 'https://higgsfield.ai/ai/image',                          expected_cost: 2,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'flux-2-max':         { frontend_label: 'FLUX.2 MAX',               backend_slug: 'flux_2_max',      url: 'https://higgsfield.ai/ai/image',                          expected_cost: 4,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'flux-2-flex':        { frontend_label: 'FLUX.2 Flex',              backend_slug: 'flux_2_flex',     url: 'https://higgsfield.ai/ai/image',                          expected_cost: 2,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'flux-kontext-max':   { frontend_label: 'Flux Kontext Max',         backend_slug: 'flux_kontext_max',url: 'https://higgsfield.ai/ai/image',                          expected_cost: 3,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'z-image':            { frontend_label: 'Z-Image',                  backend_slug: 'z_image',         url: 'https://higgsfield.ai/ai/image',                          expected_cost: 1,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'kling-o1':           { frontend_label: 'Kling O1',                 backend_slug: 'kling_o1',        url: 'https://higgsfield.ai/ai/image',                          expected_cost: 2,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'reve':               { frontend_label: 'Reve',                     backend_slug: 'reve',            url: 'https://higgsfield.ai/ai/image',                          expected_cost: 2,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'grok-imagine':       { frontend_label: 'Grok Imagine',             backend_slug: 'grok_imagine',    url: 'https://higgsfield.ai/ai/image',                          expected_cost: 3,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'wan-2-2':            { frontend_label: 'WAN 2.2',                  backend_slug: 'wan_2_2',         url: 'https://higgsfield.ai/ai/image',                          expected_cost: 2,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } },
  'multi-reference':    { frontend_label: 'Multi Reference',          backend_slug: 'multi_reference', url: 'https://higgsfield.ai/ai/image',                          expected_cost: 2,  defaults: { aspect_ratio: '16:9', resolution: '2k', batch_size: 1 } }
};

// Re-export for batch.mjs so it can resolve models by frontend key.
export const MODEL_CATALOG_PUBLIC = MODEL_CATALOG;

// Candidate line-1 texts the aspect pill can currently display.
const ASPECT_LABELS     = ['Auto', '1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '4:5', '5:4'];
// Resolution pill (1K/2K/4K/720p/1080p depending on model).
const RESOLUTION_LABELS = ['1k', '1K', '2k', '2K', '4k', '4K', '720p', '1080p', 'High', 'Medium', 'Low', 'Auto'];
// Batch pill reads as "N/M" e.g. "1/4", "2/4", "3/4", "4/4".
const BATCH_LABELS      = ['1/4', '2/4', '3/4', '4/4', '1/1', '1/2', '2/2'];
// Current-model pill can show any frontend_label.
const MODEL_PILL_LABELS = Object.values(MODEL_CATALOG).map(m => m.frontend_label);

// buildBody constructs a best-effort POST body for --dry-run output. Live runs
// UI-drive the submit so the page composes its own body from UI state; this
// function is never serialized onto the wire.
function buildBody(modelKey, prompt, opts) {
  const cat = MODEL_CATALOG[modelKey];
  const aspect = opts.aspect || cat.defaults.aspect_ratio;
  const resolution = opts.res || cat.defaults.resolution;
  const batch_size = opts.batch ? parseInt(opts.batch, 10) : cat.defaults.batch_size;
  const params_for_state = {
    aspect_ratio: aspect,
    resolution,
    batch_size,
    use_unlim: !!opts.unlim,
    character: opts.character || null,
    style: opts.style || null,
    preset: opts.preset || null
  };
  const body = {
    params: {
      prompt,
      aspect_ratio: aspect,
      resolution,
      batch_size,
      use_unlim: !!opts.unlim
    }
  };
  return { body, params_for_state };
}

// Primary handler
export async function runImage(argv) {
  const modelKey = argv.model;
  if (!MODEL_CATALOG[modelKey]) {
    throw new Error(`Unknown --model. Supported: ${Object.keys(MODEL_CATALOG).join(', ')}`);
  }
  if (!argv.prompt) throw new Error('--prompt is required');
  const cat = MODEL_CATALOG[modelKey];

  const runId = `${timestampForRunId()}-${slugFromPrompt(argv.prompt)}`;
  const runDir = argv.output ? argv.output : join(OUTPUT_ROOT, runId);

  const { body, params_for_state } = buildBody(modelKey, argv.prompt, argv);

  const state = await initState(runDir, {
    run_id: runId,
    cmd: 'image',
    model_frontend: modelKey,
    model_backend: cat.backend_slug,
    tool_url: cat.url,
    prompt: argv.prompt,
    params: params_for_state,
    cost_credits_expected: cat.expected_cost,
    force_used: !!argv.force
  });

  console.log(`[higgsfield] run_id=${runId} dir=${runDir}`);
  if (argv.dryRun) {
    console.log(`[higgsfield] --dry-run: would POST /jobs/${cat.backend_slug} with body:`);
    console.log(JSON.stringify(body, null, 2));
    return { dry_run: true, runDir };
  }

  const ctx = await launchContext({ force: !!argv.force, headless: false });
  let walletBefore = null;
  try {
    // Sanity: UA-CH consistency before any real action
    const uachPage = ctx.page;
    const ua = await verifyUaChConsistency(uachPage);
    if (!ua.ok) console.warn(`[higgsfield] WARNING UA-CH check failed (${ua.reason}); continuing anyway`);

    // Capture page console messages for debugging
    ctx.page.on('console', msg => {
      const t = msg.type();
      if (t === 'error' || t === 'warning') console.log(`[page-${t}]`, msg.text().slice(0, 300));
    });
    ctx.page.on('pageerror', err => console.log('[page-error]', err.message.slice(0, 300)));

    // Load the tool page. Use 'load' (fires after sync scripts) not 'networkidle'
    // because higgsfield keeps a long-lived SSE connection open forever.
    await ctx.page.goto(cat.url, { waitUntil: 'load', timeout: 45000 });

    // Wait for the page to fire at least one outgoing request to fnf.higgsfield.ai
    // with a Bearer token. That's our confirmation the session is live.
    const wait = await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    if (!wait.ok) {
      throw new Error(`No Clerk JWT observed in page traffic within 30s: ${wait.reason}. Try 'node scripts/run.mjs login'.`);
    }
    console.log(`[higgsfield] captured Clerk JWT from page traffic (${ctx.jwtCapture.captureCount} observations)`);
    // Purge any attachments that persisted in localStorage from a prior session,
    // otherwise Higgsfield's form state re-hydrates and attaches them to this submit.
    const cleared = await clearPersistedAttachments(ctx.page);
    if (cleared.changed.length) console.log(`[higgsfield] cleared persisted attachments in ${cleared.changed.length} localStorage key(s): ${cleared.changed.join(', ')}`);
    await pauseJitter();

    // Debug: what did we actually load?
    const dbg = await ctx.page.evaluate(() => {
      const clerkKeys = Object.keys(window).filter(k => k.toLowerCase().includes('clerk'));
      const scripts = Array.from(document.scripts).map(s => s.src || '(inline)').filter(s => s.includes('clerk') || s.includes('higgsfield') || s.includes('chunk'));
      return {
        url: location.href,
        title: document.title,
        hasClerk: !!window.Clerk,
        clerkLoaded: !!(window.Clerk && window.Clerk.loaded),
        clerkKeys,
        scriptsMatchingClerk: scripts.filter(s => s.includes('clerk')).slice(0, 3),
        chunkCount: scripts.filter(s => s.includes('chunk')).length,
        hasCaptcha: !!document.querySelector('iframe[src*="captcha-delivery.com"]'),
        hasBlockedText: /You have been blocked|unusual activity/i.test(document.body?.innerText || ''),
        scriptsCount: document.scripts.length,
        hasUserAgentData: 'userAgentData' in navigator,
        userAgent: navigator.userAgent,
        readyState: document.readyState,
        cookieNames: document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean)
      };
    });
    if (dbg.hasCaptcha || dbg.hasBlockedText) {
      throw new Error('Landed on DataDome block page. See .breaker.json.');
    }

    // Browse phase (human signal)
    await browsePhase(ctx.page);

    // Pre-flight: wallet check + captcha surface check
    walletBefore = await preflight(ctx.page, runDir, { expectedCost: cat.expected_cost, jwtCapture: ctx.jwtCapture, costCap: parseCostCap(argv) });

    // Before clicking Generate: open History panel and snapshot pre-existing user images.
    // Our new image(s) will appear as "fresh" entries that weren't in this baseline.
    const userSub = userIdFromJwtCapture(ctx.jwtCapture);
    if (!userSub) throw new Error('Could not extract user_id from captured JWT.');
    const userSubstr = userSub.replace(/^user_/, ''); // strip "user_" prefix for URL match
    console.log(`[higgsfield] user_id=${userSub} (matching user_${userSubstr} in CloudFront URLs)`);
    await openHistoryPanel(ctx.page);
    const preExisting = await scrapeUserAssets(ctx.page, userSubstr);
    const preSet = new Set(preExisting.map(x => x.cdn));
    console.log(`[higgsfield] baseline: ${preSet.size} pre-existing user images in History panel`);

    // Activate the UI Unlimited toggle (default: always try; no-op if user lacks unlim plan)
    const unlimState = await enableUnlimitedToggle(ctx.page);
    console.log(`[higgsfield] unlimited toggle: ${unlimState}`);

    // Ensure the requested model tile is selected in the UI (the URL query-param hint
    // is best-effort; some models only load via the picker). Fail loudly if we can't
    // confirm the right model -- submitting on the wrong model burns credits silently.
    const modelSel = await selectPicker(ctx.page, {
      currentLabels: MODEL_PILL_LABELS,
      target: cat.frontend_label
    });
    console.log(`[higgsfield] model picker (${cat.frontend_label}): ${modelSel}`);
    if (modelSel !== 'already_selected' && modelSel !== 'selected') {
      const err = new Error(`Model picker could not select "${cat.frontend_label}" (result: ${modelSel}). Refusing to submit to avoid wrong-model generation.`);
      err.code = 'UI_MODEL_SELECT_FAIL';
      throw err;
    }

    // Apply picker tweaks FIRST so subsequent React rerenders don't clear attachments.
    // Non-OK results throw so we never silently submit with wrong params.
    const assertPickerOk = (category, value, result) => {
      if (result === 'already_selected' || result === 'selected') return;
      const err = new Error(`Picker ${category}="${value}" failed: ${result}.`);
      err.code = 'UI_PICKER_FAIL';
      throw err;
    };
    if (argv.aspect) {
      const r = await selectPicker(ctx.page, { currentLabels: ASPECT_LABELS, target: argv.aspect });
      console.log(`[higgsfield] aspect ${argv.aspect}: ${r}`);
      assertPickerOk('aspect', argv.aspect, r);
      params_for_state.aspect_ratio = argv.aspect;
    }
    if (argv.res) {
      const r = await selectPicker(ctx.page, { currentLabels: RESOLUTION_LABELS, target: argv.res });
      console.log(`[higgsfield] resolution ${argv.res}: ${r}`);
      assertPickerOk('resolution', argv.res, r);
      params_for_state.resolution = argv.res;
    }
    if (argv.batch) {
      const batchLabel = `${argv.batch}/4`;
      const r = await selectPicker(ctx.page, { currentLabels: BATCH_LABELS, target: batchLabel });
      console.log(`[higgsfield] batch ${batchLabel}: ${r}`);
      assertPickerOk('batch', batchLabel, r);
      params_for_state.batch_size = parseInt(argv.batch, 10);
    }

    // ALWAYS clear any stale attachment chips before submit. Higgsfield
    // persists attachments across sessions -- if we skip this, a new prompt
    // inherits whatever was attached by a previous run.
    const clearedChips = await clearReferenceImages(ctx.page);
    if (clearedChips > 0) console.log(`[higgsfield] cleared ${clearedChips} stale attachment chip(s)`);

    // Upload references LAST so nothing after can clear them.
    const refPaths = collectRefs(argv);
    if (refPaths.length > 0) {
      const absPaths = refPaths.map(p => pathResolve(p));
      const u = await uploadReferenceImages(ctx.page, absPaths, { clearExisting: false });
      console.log(`[higgsfield] uploaded ${u.uploaded} reference file(s) via input ${u.input?.name || u.input?.id || '(unnamed)'} @ ${u.dist_from_prompt}px: ${absPaths.join(', ')}`);
      params_for_state.ref_files = absPaths;
    }

    // UI-drive submission: click the page's own Generate button so the POST goes
    // through DataDome's JS stack. We capture the response via context.on('response').
    // The `body` we pre-built is NOT sent -- the page constructs its body from UI state.
    // We ensure UI defaults match our body (aspect/res/batch defaults align with config).
    const submission = await submitViaUI(ctx.page, ctx.context, runDir, {
      slug: cat.backend_slug,
      prompt: argv.prompt
    });

    // Wait for new image(s) to appear in the History panel. expectCount should match batch_size.
    const expectCount = params_for_state.batch_size || 1;
    await transition(runDir, 'polling', {});
    console.log(`[higgsfield] waiting for ${expectCount} new image(s) to appear in History...`);
    const fresh = await waitForNewAssets(ctx.page, userSubstr, preSet, {
      expectCount,
      timeoutMs: 5 * 60 * 1000,
      pollMs: 3000,
      requireKind: 'image'
    });
    console.log(`[higgsfield] detected ${fresh.length} new image(s)`);
    fresh.forEach(f => console.log(`  ${f.cdn}`));

    const urls = fresh.map(bestDownloadUrl);
    const records = await downloadAll(runDir, urls);

    // Finalize (metadata + wallet delta)
    const walletAfter = await getWallet(ctx.page, ctx.jwtCapture);
    const meta = await finalize(runDir, {
      wallet_before: walletTotal(walletBefore),
      wallet_after: walletTotal(walletAfter),
      job_uuid: submission.job_uuid,
      job: null,
      records,
      cmd: 'image',
      model_frontend: modelKey,
      model_backend: cat.backend_slug,
      prompt: argv.prompt,
      params: params_for_state
    });

    console.log(`[higgsfield] SAVED ${records.length} file(s) to ${runDir}`);
    for (const r of records) console.log(`  ${r.local_path} (${r.bytes} bytes, ${r.content_type})`);
    console.log(`[higgsfield] cost: ~${meta.cost_credits_actual} credits (wallet ${meta.wallet_before} -> ${meta.wallet_after})`);
    return { runDir, metadata: meta };
  } catch (err) {
    if (argv.debug) {
      console.error(`[higgsfield] error: ${err.message}. Browser left open for inspection. Press Ctrl+C when done.`);
      await new Promise(() => {}); // hang
    }
    throw err;
  } finally {
    if (!argv.debug) await ctx.close();
  }
}

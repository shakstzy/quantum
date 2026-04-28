// job.mjs -- submit jobs via the live page, watch completion, download, with hard caps + breaker.
// We always submit via `page.evaluate(fetch)` so DataDome session cookies and x-datadome-clientid
// tag along. Direct Node fetch would lack that context and get 403.

import { transition, readState, writeState } from './state.mjs';
import { getFreshJwt, extractReplayHeaders } from './jwt.mjs';
import { hasCaptchaInDom, trigger403Breaker } from './browser.mjs';
import { downloadCloudfront, unwrapImagesHiggsProxy } from './download.mjs';
import { pause, pauseJitter } from './behavior.mjs';

// Build the header set for page.request.* calls. MUST include x-datadome-clientid
// (captured from the page's own outgoing traffic) or DataDome 403s the POST.
function replayHeaders(jwtCapture, token) {
  const src = jwtCapture.lastPostHeaders || jwtCapture.lastAnyHeaders;
  const base = extractReplayHeaders(src);
  return {
    ...base,
    'authorization': 'Bearer ' + token
  };
}

const IMAGE_POLL_MAX_MS = 5 * 60 * 1000;
const VIDEO_POLL_MAX_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

// Total spendable balance: subscription + package credits (unlim is handled separately).
// All credit-accounting paths (preflight safety floor, finalize cost delta) must use this
// or numbers drift apart when package_credits move.
export function walletTotal(w) {
  if (!w) return null;
  return (w.subscription_credits || 0) + (w.package_credits || 0);
}

// Parse --cost-cap flag from argv. Returns a finite number or null (= use preflight default).
export function parseCostCap(argv) {
  const v = argv?.costCap;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function getWallet(page, jwtCapture) {
  let t;
  try { t = await getFreshJwt(page, jwtCapture); } catch (_) { return null; }
  // Use Playwright's context-level request API (not page.evaluate + fetch).
  // patchright runs evaluate in isolated world, where in-page fetch is flaky.
  // context.request uses the context's cookies + gets past that.
  try {
    const r = await page.request.get('https://fnf.higgsfield.ai/user', {
      headers: replayHeaders(jwtCapture, t)
    });
    if (!r.ok()) return null;
    const j = await r.json();
    return { subscription_credits: j.subscription_credits, package_credits: j.package_credits, has_unlim: j.has_unlim, email: j.email, plan_type: j.plan_type, workspace_id: j.workspace_id, user_id: j.id };
  } catch (_) { return null; }
}

// runDir may be null for batch-level preflight (no per-run state.json yet).
async function maybeTransition(runDir, status, patch) {
  if (!runDir) return;
  try { await transition(runDir, status, patch); } catch (_) {}
}

export async function preflight(page, runDir, { expectedCost, jwtCapture, costCap = null, forceBreaker = false }) {
  // Validate cost is sane up-front. Catalogs that drift to 0/NaN must fail closed.
  if (!Number.isFinite(expectedCost) || expectedCost <= 0) {
    await maybeTransition(runDir, 'aborted_precheck', { error: `invalid expected cost: ${expectedCost}` });
    const err = new Error(`Invalid expected cost ${expectedCost}; refuse to submit.`);
    err.code = 'INVALID_COST';
    throw err;
  }
  // Enforce --cost-cap (default 500). High enough that any single submit (cinema video = 96
  // is the most expensive) flows by default; still catches runaway batches.
  const cap = Number.isFinite(costCap) ? costCap : 500;
  if (expectedCost > cap) {
    await maybeTransition(runDir, 'aborted_precheck', { error: `expectedCost ${expectedCost} exceeds cost-cap ${cap}` });
    const err = new Error(`Expected cost ${expectedCost} exceeds --cost-cap ${cap}. Pass --cost-cap ${expectedCost} to allow.`);
    err.code = 'COST_CAP_EXCEEDED';
    throw err;
  }
  const captcha = await hasCaptchaInDom(page);
  if (captcha) {
    await maybeTransition(runDir, 'datadome_flagged', { error: 'captcha visible pre-submit' });
    const err = new Error('Captcha visible in DOM before submit. Halting.');
    err.code = 'DATADOME_VISIBLE';
    throw err;
  }
  const wallet = await getWallet(page, jwtCapture);
  if (!wallet) {
    await maybeTransition(runDir, 'aborted_precheck', { error: 'wallet unreachable; session may be expired' });
    const err = new Error('Could not read wallet; session may be expired. Run login.');
    err.code = 'SESSION_EXPIRED';
    throw err;
  }
  const totalCredits = walletTotal(wallet);
  const safety = expectedCost * 2;
  if (totalCredits < safety && !wallet.has_unlim) {
    await maybeTransition(runDir, 'aborted_precheck', { error: `insufficient credits: total ${totalCredits} (sub=${wallet.subscription_credits}, pack=${wallet.package_credits || 0}), safety floor ${safety}` });
    const err = new Error(`Wallet total ${totalCredits} below 2x safety floor for expected cost ${expectedCost}.`);
    err.code = 'INSUFFICIENT_CREDITS';
    throw err;
  }
  return wallet;
}

// Submit via Playwright's context.request (not page.evaluate).
// Returns { job_uuid, raw_response } or throws.
export async function submitJob(page, runDir, slug, body, { idempotencyKey, jwtCapture }) {
  await transition(runDir, 'pending', {});
  const t = await getFreshJwt(page, jwtCapture);
  let res;
  try {
    const r = await page.request.post('https://fnf.higgsfield.ai/jobs/' + slug, {
      headers: {
        ...replayHeaders(jwtCapture, t),
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey
      },
      data: body
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (_) { j = { raw: txt }; }
    res = { ok: r.ok(), status: r.status(), body: j };
  } catch (e) {
    await transition(runDir, 'failed', { error: 'submit threw: ' + (e && e.message) });
    throw e;
  }

  if (!res.ok) {
    if (res.status === 403) {
      const b = trigger403Breaker();
      await transition(runDir, 'datadome_flagged', { error: `403 on /jobs/${slug}; breaker ${b.state}` });
      const err = new Error('403 on job submit. Breaker tripped. See state.json.');
      err.code = 'SUBMIT_403';
      throw err;
    }
    await transition(runDir, 'failed', { error: `submit ${res.status}: ${JSON.stringify(res.body).slice(0, 500)}` });
    const err = new Error(`Submit failed ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    err.code = 'SUBMIT_FAILED';
    throw err;
  }

  // Response shape varies; we try common job-id fields
  const j = res.body;
  const uuid = j?.id || j?.job_id || j?.job?.id || j?.job_set_id || j?.jobSetId || j?.data?.id;
  if (!uuid) {
    await transition(runDir, 'failed', { error: 'submit 2xx but no job id in response', last_body: JSON.stringify(j).slice(0, 500) });
    const err = new Error('Submit 2xx but no job id. See state.json.');
    err.code = 'SUBMIT_NO_UUID';
    throw err;
  }
  await transition(runDir, 'submitted', { job_uuid: uuid });
  return { job_uuid: uuid, response: j };
}

export async function pollForCompletion(page, runDir, jobUuid, { isVideo = false, jwtCapture } = {}) {
  await transition(runDir, 'polling', {});
  const maxMs = isVideo ? VIDEO_POLL_MAX_MS : IMAGE_POLL_MAX_MS;
  const start = Date.now();
  let lastStatus = null;
  let iter = 0;
  while (Date.now() - start < maxMs) {
    iter++;
    // Every 5 iterations, also check captcha surface
    if (iter % 5 === 0) {
      const capt = await hasCaptchaInDom(page);
      if (capt) {
        trigger403Breaker();
        await transition(runDir, 'datadome_flagged', { error: 'captcha appeared during polling' });
        const err = new Error('Captcha appeared during polling. Breaker tripped.');
        err.code = 'DATADOME_DURING_POLL';
        throw err;
      }
    }
    const t = await getFreshJwt(page, jwtCapture);
    let res;
    try {
      const r = await page.request.get('https://fnf.higgsfield.ai/jobs/' + jobUuid, {
        headers: replayHeaders(jwtCapture, t)
      });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (_) { j = { raw: txt }; }
      res = { ok: r.ok(), status: r.status(), body: j };
    } catch (e) {
      await pause(POLL_INTERVAL_MS);
      continue;
    }
    if (res.status === 403) {
      trigger403Breaker();
      await transition(runDir, 'datadome_flagged', { error: 'poll 403' });
      const err = new Error('403 during poll. Breaker tripped.');
      err.code = 'POLL_403';
      throw err;
    }
    if (!res.ok) {
      // Transient; keep polling
      await pause(POLL_INTERVAL_MS);
      continue;
    }
    const j = res.body;
    const status = (j?.status || j?.state || j?.job?.status || '').toLowerCase();
    lastStatus = status;
    // Completed states seen in practice (from JS bundle): succeeded / completed / done
    if (status === 'completed' || status === 'succeeded' || status === 'done' || status === 'finished') {
      return { job: j };
    }
    if (status === 'failed' || status === 'error') {
      await transition(runDir, 'failed', { error: `server marked ${status}`, last_body: JSON.stringify(j).slice(0, 500) });
      const err = new Error(`Server marked job ${status}.`);
      err.code = 'JOB_FAILED_SERVER';
      throw err;
    }
    await pause(POLL_INTERVAL_MS);
  }
  await transition(runDir, 'timeout', { error: `poll timeout; last status: ${lastStatus}` });
  const err = new Error(`Poll timeout after ${Math.round((Date.now() - start) / 1000)}s. Last status: ${lastStatus}. Resume later.`);
  err.code = 'POLL_TIMEOUT';
  throw err;
}

// Pull asset URLs from the completed job response. Covers the common shapes we've seen
// in the JS bundle: `results[].url`, `assets[].url`, `outputs[].url`, `images[].url`,
// `video_url`, `image_url`, `media[].url`.
export function extractAssetUrls(job) {
  const urls = [];
  function push(u) { if (typeof u === 'string' && u.startsWith('https://')) urls.push(u); }
  if (job?.results?.length) job.results.forEach(r => push(r?.url || r?.media_url || r?.asset_url));
  if (job?.assets?.length) job.assets.forEach(r => push(r?.url));
  if (job?.outputs?.length) job.outputs.forEach(r => push(r?.url));
  if (job?.images?.length) job.images.forEach(r => push(r?.url));
  if (job?.media?.length) job.media.forEach(r => push(r?.url));
  push(job?.image_url);
  push(job?.video_url);
  push(job?.asset?.url);
  push(job?.job?.asset?.url);
  // Normalize `images.higgs.ai/?url=...` wrappers to the raw CloudFront URL
  return urls.map(unwrapImagesHiggsProxy);
}

export async function downloadAll(runDir, urls) {
  await transition(runDir, 'downloading', {});
  const records = [];
  for (const u of urls) {
    const rec = await downloadCloudfront(u, runDir);
    records.push(rec);
  }
  return records;
}

export async function finalize(runDir, { wallet_before, wallet_after, job_uuid, job, records, cmd, model_frontend, model_backend, prompt, params }) {
  const costActual = (Number.isFinite(wallet_before) && Number.isFinite(wallet_after))
    ? (wallet_before - wallet_after)  // can be 0 (free gen / unlim) or negative (refund); preserve sign.
    : null;
  const isVideo = records.some(r => (r.content_type || '').startsWith('video/'));
  const first = records[0] || {};
  const metadata = {
    schema_version: 1,
    run_id: (await readState(runDir)).run_id,
    cmd,
    model_frontend,
    model_backend,
    prompt,
    params,
    job_uuid,
    filename_on_cdn: first.filename_on_cdn || null,
    local_path: first.local_path || null,
    bytes: first.bytes || null,
    content_type: first.content_type || null,
    sha256: first.sha256 || null,
    all_files: records.map(r => ({ local_path: r.local_path, bytes: r.bytes, content_type: r.content_type, sha256: r.sha256 })),
    duration_seconds: isVideo ? (job?.duration || job?.job?.duration || null) : null,
    cost_credits_actual: costActual,
    wallet_before: wallet_before ?? null,
    wallet_after: wallet_after ?? null,
    timestamp: new Date().toISOString()
  };
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await writeFile(join(runDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  await transition(runDir, 'saved', { cost_credits_actual: costActual });
  return metadata;
}

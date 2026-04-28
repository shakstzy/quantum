// diag-e2e.mjs -- full UI-drive submit, then observe DOM + network for 3 min
// to find the completion-signal pattern. One real generation (2 credits) for intel.

import { launchContext, hasCaptchaInDom } from './browser.mjs';
import { submitViaUI } from './ui-submit.mjs';
import { initState, slugFromPrompt, timestampForRunId } from './state.mjs';
import { waitForCapturedJwt } from './jwt.mjs';
import { join } from 'node:path';

const URL = 'https://higgsfield.ai/ai/image?model=nano-banana-pro';
const SLUG = 'nano_banana_2';
const PROMPT = 'a single green apple on a wooden table, soft window light, product photography';

async function main() {
  const runId = `${timestampForRunId()}-diag-e2e`;
  const runDir = `/tmp/hf-diag-${runId}`;
  await initState(runDir, {
    run_id: runId, cmd: 'diag', model_frontend: 'nano-banana-pro',
    model_backend: SLUG, tool_url: URL, prompt: PROMPT, params: {}, cost_credits_expected: 2, force_used: false
  });

  const ctx = await launchContext({ force: false, headless: false });
  const jobsResponses = [];
  const notifResponses = [];
  const cloudfrontImgUrls = new Set();

  // Context-level listeners (these actually fire, unlike page.on added post-creation)
  ctx.context.on('response', async resp => {
    try {
      const u = new URL(resp.url());
      if (u.hostname === 'fnf.higgsfield.ai' && u.pathname.includes('/jobs/')) {
        let body = null;
        try { body = await resp.text(); } catch (_) {}
        jobsResponses.push({
          t: Date.now(),
          status: resp.status(),
          method: resp.request().method(),
          path: u.pathname,
          bodyPreview: (body || '').slice(0, 300)
        });
        console.log(`[fnf-jobs] ${resp.status()} ${resp.request().method()} ${u.pathname} bodyLen=${(body || '').length}`);
      }
      if (u.hostname === 'notification.higgsfield.ai') {
        notifResponses.push({ t: Date.now(), status: resp.status(), path: u.pathname });
        console.log(`[notif] ${resp.status()} ${resp.request().method()} ${u.pathname}`);
      }
    } catch (_) {}
  });

  try {
    const page = ctx.page;
    await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    console.log('[diag] page loaded, waiting for JWT capture...');
    const wait = await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    if (!wait.ok) throw new Error('No JWT captured: ' + wait.reason);
    console.log(`[diag] JWT captured (${ctx.jwtCapture.captureCount} obs)`);

    if (await hasCaptchaInDom(page)) throw new Error('Captcha visible before submit');

    console.log('[diag] submitting via UI...');
    const submission = await submitViaUI(page, ctx.context, runDir, { slug: SLUG, prompt: PROMPT, responseTimeoutMs: 45000 });
    const submitAt = Date.now();
    console.log(`[diag] submit OK -- job_uuid=${submission.job_uuid} path=${submission.path}`);

    // Observe for 3 minutes
    for (let t = 5; t <= 180; t += 5) {
      await page.waitForTimeout(5000);
      const snap = await page.evaluate((uuid) => {
        const imgs = Array.from(document.querySelectorAll('img'))
          .map(i => ({ src: i.src, alt: i.alt, visible: i.getBoundingClientRect().width > 0 }))
          .filter(i => /cloudfront|higgs\.ai|higgsfield/.test(i.src));
        const containsUuid = (document.body?.innerText || '').includes(uuid);
        // Look for any element with our uuid in attributes
        const allEls = document.querySelectorAll('*');
        let uuidEls = 0;
        for (const el of allEls) {
          for (const attr of el.attributes) {
            if (attr.value.includes(uuid)) { uuidEls++; break; }
          }
        }
        return {
          imgCount: imgs.length,
          uniqueSrcs: [...new Set(imgs.map(i => i.src))].length,
          containsUuid,
          uuidAttrElements: uuidEls,
          sampleNewImgs: imgs.slice(0, 3).map(i => i.src.slice(0, 120))
        };
      }, submission.job_uuid);
      const cfNewCount = snap.uniqueSrcs - cloudfrontImgUrls.size;
      console.log(`[diag] t+${t}s: imgs=${snap.imgCount} unique=${snap.uniqueSrcs} domHasUuid=${snap.containsUuid} uuidAttrEls=${snap.uuidAttrElements}`);
      if (snap.containsUuid || snap.uuidAttrElements > 0) {
        console.log('  !!! UUID FOUND IN DOM - sample imgs:');
        snap.sampleNewImgs.forEach(s => console.log('     ' + s));
        // Deep-dive: find the element containing uuid
        const details = await page.evaluate((uuid) => {
          for (const el of document.querySelectorAll('*')) {
            for (const attr of el.attributes) {
              if (attr.value.includes(uuid)) {
                const parent = el.closest('[class*="card"],[class*="grid"],[class*="tile"]') || el.parentElement;
                return {
                  tag: el.tagName,
                  attr: attr.name,
                  cls: el.className?.toString().slice(0, 100),
                  parentCls: parent?.className?.toString().slice(0, 100),
                  html: el.outerHTML.slice(0, 400)
                };
              }
            }
          }
          return null;
        }, submission.job_uuid);
        console.log('  DOM element with uuid:', JSON.stringify(details, null, 2));
      }
    }

    console.log(`\n[diag] TOTAL /jobs/ responses observed: ${jobsResponses.length}`);
    jobsResponses.forEach((r, i) => {
      console.log(`  #${i + 1} t=+${Math.round((r.t - submitAt) / 1000)}s ${r.status} ${r.method} ${r.path}`);
      if (r.bodyPreview) console.log(`    body: ${r.bodyPreview}`);
    });
    console.log(`\n[diag] TOTAL notification.higgsfield.ai responses: ${notifResponses.length}`);
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error('DIAG ERROR', e.message); process.exit(1); });

#!/usr/bin/env node
// Walk all entities, identify those whose thread renders the
// "This match has expired" interstitial, and click the in-app Rematch button
// to reset the 24h clock. Live-verified DOM on Lacie 2026-05-03.
//
// Bumble caps free-tier rematches (paywall behavior similar to grok-web's
// SuperGrok Heavy paywall). Detection: post-click, watch for a Radix-style
// dialog covering the viewport with "Premium" / "Upgrade" / "Subscribe" copy.
// If hit, dismiss with Escape and exit cleanly so the cron doesn't loop.
//
// Per-session cap defaults to 5 rematches to stay human-paced. Override with
// QUANTUM_BUMBLE_REMATCH_LIMIT.
//
// Filter modes:
//   QUANTUM_BUMBLE_REMATCH_SLUG=<slug>  rematch only that one entity
//   QUANTUM_BUMBLE_REMATCH_DRY=1        click dry-run: detect interstitial,
//                                       report what WOULD be clicked, no click

import { launchPersistent } from "../src/runtime/profile.mjs";
import { abortIfHalted, setHalt } from "../src/runtime/halt.mjs";
import { listAllEntities, loadEntity, setStatus } from "../src/runtime/entity-store.mjs";
import { logSession } from "../src/runtime/logger.mjs";
import { humanClick, makeCursor, sleep, jitter, idlePause } from "../src/runtime/humanize.mjs";
import { selectors, scanForHalts } from "../src/runtime/detection.mjs";
import { openThread } from "../src/bumble/page.mjs";

await abortIfHalted();

const REMATCH_LIMIT = parseInt(process.env.QUANTUM_BUMBLE_REMATCH_LIMIT || "5", 10);
const ONLY_SLUG = process.env.QUANTUM_BUMBLE_REMATCH_SLUG || null;
const DRY = process.env.QUANTUM_BUMBLE_REMATCH_DRY === "1";

const sels = await selectors();
const interstitialSel = sels.match_expired_interstitial?.selector;
const rematchBtnSel = sels.rematch_button?.selector;
if (!interstitialSel || !rematchBtnSel) {
  throw new Error("missing_selector: match_expired_interstitial / rematch_button. Update config/selectors.json or run scripts/discover-dom.mjs.");
}

// Decide which entities to walk. Prefer those already marked status=expired
// (cheap path, no thread open), then any with expires_at in the past.
const all = await listAllEntities();
const candidates = [];
for (const ent of all) {
  if (ONLY_SLUG && ent.slug !== ONLY_SLUG) continue;
  if (ent.meta.status === "unmatched") continue;
  const isExpired = ent.meta.status === "expired"
    || (ent.meta.expires_at && new Date(ent.meta.expires_at).getTime() < Date.now());
  if (isExpired) candidates.push(ent);
}

console.log(`rematch: ${candidates.length} expired candidate(s) (limit=${REMATCH_LIMIT}${DRY ? ", DRY" : ""})`);
if (candidates.length === 0) {
  console.log("nothing to rematch");
  process.exit(0);
}

const todo = candidates.slice(0, REMATCH_LIMIT);

const { ctx, page } = await launchPersistent({ headless: false });
const cursor = await makeCursor(page);

let rematched = 0;
let paywalled = 0;
let interstitial_missing = 0;
let failed = 0;

try {
  for (const ent of todo) {
    try {
      console.log(`opening ${ent.slug} (${ent.meta.match_id.slice(0, 12)}...)`);
      await openThread(page, ent.meta.match_id);
      await scanForHalts(page);
      await sleep(jitter(1500, 2800));

      const interstitial = await page.$(interstitialSel).catch(() => null);
      if (!interstitial) {
        console.log(`  ${ent.slug}: interstitial NOT present (already rematched? bumble UI shifted?). Clearing entity status from 'expired' so triage doesn't re-route.`);
        try { await setStatus(ent.slug, "new"); } catch {}
        interstitial_missing += 1;
        continue;
      }

      if (DRY) {
        console.log(`  ${ent.slug}: DRY — would click Rematch.`);
        continue;
      }

      // Click the Rematch button.
      const btnPresent = await page.$(rematchBtnSel).catch(() => null);
      if (!btnPresent) {
        console.error(`  ${ent.slug}: interstitial present but rematch button selector not found. Skipping.`);
        failed += 1;
        continue;
      }
      await humanClick(cursor, page, rematchBtnSel);
      await sleep(jitter(1800, 3500));

      // Halt scan in case Bumble surfaces verification or rate-limit on rematch.
      await scanForHalts(page);

      // Check for paywall dialog. Bumble uses Radix-style modals for premium gates.
      const paywallSignal = await page.evaluate(() => {
        const dialog = document.querySelector("[role='dialog'], [data-state='open'][role='dialog']");
        if (!dialog) return null;
        const text = (dialog.textContent || "").toLowerCase();
        const isPaywall = /(premium|upgrade|subscribe|out of rematches|run out|reached your limit|need more rematches)/i.test(text);
        if (isPaywall) return { copy: text.slice(0, 300) };
        return null;
      });
      if (paywallSignal) {
        console.error(`  ${ent.slug}: PAYWALLED. Dialog copy: "${paywallSignal.copy.slice(0, 120)}". Dismissing with Escape and stopping the loop.`);
        try { await page.keyboard.press("Escape"); } catch {}
        paywalled += 1;
        // Don't try further rematches this session — they'll all paywall.
        break;
      }

      // Verify the interstitial is gone (success signal). On Bumble the
      // expired view should be replaced with the normal composer.
      const stillExpired = await page.$(interstitialSel).catch(() => null);
      if (stillExpired) {
        console.error(`  ${ent.slug}: clicked Rematch but interstitial still present. Treating as failure.`);
        failed += 1;
        continue;
      }

      console.log(`  ${ent.slug}: rematched, interstitial cleared`);
      try { await setStatus(ent.slug, "new"); } catch {}
      rematched += 1;
      await idlePause({ min: 4500, max: 9500 });
    } catch (e) {
      if (String(e.message || "").startsWith("HALTED")) throw e;
      console.error(`  ${ent.slug}: ${e.message}`);
      failed += 1;
    }
  }
} finally {
  await ctx.close();
}

await logSession({ event: "rematch", rematched, paywalled, interstitial_missing, failed, candidates: candidates.length });
console.log(JSON.stringify({ rematched, paywalled, interstitial_missing, failed, total_candidates: candidates.length }));

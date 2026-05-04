#!/usr/bin/env node
// Drain 04-outbound/approved/ via patchright. Default: up to 2 sends per fire,
// with a 60-180s human-pause between sends. Override with QUANTUM_BUMBLE_SEND_PER_FIRE.
import { launchPersistent } from "../src/runtime/profile.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { listQueue, moveQueueItem, extractDraftedReply } from "../src/runtime/queue.mjs";
import { sendMessage } from "../src/bumble/send.mjs";
import { mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { OUTBOUND_DIR } from "../src/runtime/paths.mjs";

await abortIfHalted();
const approved = await listQueue("approved");
if (approved.length === 0) {
  console.log("no approved drafts to send");
  process.exit(0);
}

// 2026-05-04: per Adithya's auto-send doctrine, transient failures on the
// FIRST item (sidebar rotation, role-guard race, missing selector) shouldn't
// block the whole queue. Try items in order until one sends successfully or
// we exhaust the queue. Hard failures (HALTED, paywall, ambiguous post-click)
// still bubble up.
const TRANSIENT_PATTERNS = [
  /^thread_not_found:/,
  /^role_guard:/,
  /^live_role_guard:/,
  /^min_gap:/,
  /^thread_input not found/,
];
function isTransient(err) {
  const m = String(err?.message || "");
  return TRANSIENT_PATTERNS.some(re => re.test(m));
}

const MAX_PER_FIRE = Math.max(1, parseInt(process.env.QUANTUM_BUMBLE_SEND_PER_FIRE || "2", 10));
const { ctx, page } = await launchPersistent({ headless: false });
let sentCount = 0;
let attempts = 0;
try {
  for (const item of approved) {
    if (sentCount >= MAX_PER_FIRE) break;
    attempts += 1;
    // Refuse legacy placeholder drafts.
    if (item.meta.placeholder === true || item.meta.placeholder === "true") {
      console.error(`skip ${item.id} slug=${item.meta.slug}: placeholder draft (legacy). Discarding.`);
      try { await moveQueueItem(item.id, "approved", "expired"); } catch {}
      continue;
    }
    const text = extractDraftedReply(item.body);
    const lintPassFromMeta = item.meta.lint_pass === true || item.meta.lint_pass === "true";
    const mode = item.meta.mode === "auto" ? "auto" : "hitl";

    try {
      const r = await sendMessage(page, {
        matchId: item.meta.match_id,
        text,
        mode,
        intent: item.meta.intent || "reply",
        draftId: item.id,
        lintScore: lintPassFromMeta ? 1 : 0,
        dryRun: process.env.QUANTUM_BUMBLE_DRY_RUN === "1",
      });
      if (r.sent && !r.dryRun) await moveQueueItem(item.id, "approved", mode === "auto" ? "auto-sent" : "sent");
      console.log(`send_result (attempt ${attempts}, slug=${item.meta.slug}):`, JSON.stringify(r));
      sentCount += 1;
      if (sentCount < MAX_PER_FIRE) {
        // Human-pause before next send so we don't trip min_gap and so the
        // intra-fire cadence doesn't look mechanical. Pulls from the lower
        // half of caps.messages.between_messages_ms to keep the fire short.
        const gapMs = 60000 + Math.floor(Math.random() * 120000); // 60-180s
        console.log(`drain: sent ${sentCount}/${MAX_PER_FIRE}, sleeping ${Math.round(gapMs / 1000)}s before next attempt`);
        await new Promise(r => setTimeout(r, gapMs));
      }
    } catch (e) {
      // CODEX-R6-P0-8: ambiguous send must always quarantine, never retry.
      if (e.ambiguous) {
        const ambDir = resolve(OUTBOUND_DIR, "ambiguous");
        await mkdir(ambDir, { recursive: true });
        const fromPath = resolve(OUTBOUND_DIR, "approved", `${item.id}.md`);
        const toPath = resolve(ambDir, `${item.id}.md`);
        try { await rename(fromPath, toPath); } catch (renameErr) { console.error(`quarantine rename failed: ${renameErr.message}`); }
        console.error(`AMBIGUOUS send for ${item.id} slug=${item.meta.slug}; quarantined.`);
        throw e;
      }
      // HALTED bubbles immediately.
      if (String(e.message || "").startsWith("HALTED")) throw e;
      // stale_match: match is expired/unmatched, never recoverable. Move
      // draft to expired/ so it stops blocking the queue, then continue.
      if (String(e.message || "").startsWith("stale_match:")) {
        console.error(`skip ${item.id} slug=${item.meta.slug} (stale_match): ${e.message}`);
        try { await moveQueueItem(item.id, "approved", "expired"); } catch (mvErr) { console.error(`expire move failed: ${mvErr.message}`); }
        continue;
      }
      // Transient failures: log and try the next item.
      if (isTransient(e)) {
        console.error(`skip ${item.id} slug=${item.meta.slug} (transient): ${e.message}`);
        continue;
      }
      // Unknown failure shape: surface it.
      console.error(`unknown send failure ${item.id} slug=${item.meta.slug}: ${e.message}`);
      throw e;
    }
  }
} finally {
  await ctx.close();
}

if (sentCount === 0) {
  console.log(`no eligible drafts could be sent this fire (attempts=${attempts})`);
  process.exit(0);
}
console.log(`drain complete: sent=${sentCount}/${MAX_PER_FIRE} attempts=${attempts}`);

#!/usr/bin/env node
// Drain 04-outbound/approved/ via patchright (one msg per fire).
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

const { ctx, page } = await launchPersistent({ headless: false });
let sent = false;
let attempts = 0;
try {
  for (const item of approved) {
    if (sent) break;
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
      sent = true;
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

if (!sent) {
  console.log(`no eligible drafts could be sent this fire (attempts=${attempts})`);
  process.exit(0);
}

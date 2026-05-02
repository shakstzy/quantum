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
const item = approved[0];
// CODEX-R3-P1 + R4-P0-1: refuse to send a draft that decide.mjs marked placeholder.
if (item.meta.placeholder === true || item.meta.placeholder === "true") {
  console.error(`refusing to send placeholder draft id=${item.id} slug=${item.meta.slug}. Wire decide.mjs full body before approving.`);
  process.exit(2);
}
const text = extractDraftedReply(item.body);

const { ctx, page } = await launchPersistent({ headless: false });
try {
  const r = await sendMessage(page, {
    matchId: item.meta.match_id,
    text,
    mode: "hitl",
    intent: item.meta.intent || "reply",
    draftId: item.id,
    lintScore: 1,
    dryRun: process.env.QUANTUM_BUMBLE_DRY_RUN === "1",
  });
  if (r.sent && !r.dryRun) await moveQueueItem(item.id, "approved", "sent");
  console.log("send_result:", JSON.stringify(r));
} catch (e) {
  // CODEX-R6-P0-8: ambiguous send (post-click failure could be partial delivery).
  // Quarantine to 04-outbound/ambiguous/ so cron does NOT retry and double-text.
  if (e.ambiguous) {
    const ambDir = resolve(OUTBOUND_DIR, "ambiguous");
    await mkdir(ambDir, { recursive: true });
    const fromPath = resolve(OUTBOUND_DIR, "approved", `${item.id}.md`);
    const toPath = resolve(ambDir, `${item.id}.md`);
    try { await rename(fromPath, toPath); } catch (renameErr) { console.error(`quarantine rename failed: ${renameErr.message}`); }
    console.error(`AMBIGUOUS send for ${item.id}; quarantined to 04-outbound/ambiguous/. Verify in Bumble UI before re-sending or trashing.`);
  }
  throw e;
} finally {
  await ctx.close();
}

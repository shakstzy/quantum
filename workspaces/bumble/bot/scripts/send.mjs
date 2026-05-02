#!/usr/bin/env node
// Drain 04-outbound/approved/ via patchright (one msg per fire).
import { launchPersistent } from "../src/runtime/profile.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { listQueue, moveQueueItem, extractDraftedReply } from "../src/runtime/queue.mjs";
import { sendMessage } from "../src/bumble/send.mjs";

await abortIfHalted();
const approved = await listQueue("approved");
if (approved.length === 0) {
  console.log("no approved drafts to send");
  process.exit(0);
}
const item = approved[0];
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
} finally {
  await ctx.close();
}

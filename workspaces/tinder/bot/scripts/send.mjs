#!/usr/bin/env node
// Drains 04-outbound/approved/ via patchright. One message per invocation by default
// (cron schedules invocations across the day). Pass --all to drain everything in one session.

import { launchPersistent } from "../src/runtime/profile.mjs";
import { sendMessage } from "../src/tinder/send.mjs";
import { listQueue, moveQueueItem, extractDraftedReply, readQueueItem } from "../src/runtime/queue.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { ensureSelectorsHealthy } from "../src/runtime/detection.mjs";
import { logSession } from "../src/runtime/logger.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";

const drainAll = process.argv.includes("--all");
const dryRun = process.argv.includes("--dry-run");
await abortIfHalted();

const queue = await listQueue("approved");
if (queue.length === 0) {
  console.log("approved_queue:empty");
  process.exit(0);
}

const limit = drainAll ? queue.length : 1;
const todo = queue.slice(0, limit);

const { ctx, page } = await launchPersistent({ headless: false });
let sent = 0;
let failed = 0;
try {
  await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
  await ensureSelectorsHealthy(page);

  for (const item of todo) {
    const text = extractDraftedReply(item.body);
    try {
      const result = await sendMessage(page, {
        matchId: item.meta.match_id,
        text,
        mode: item.meta.mode,
        draftId: item.meta.draft_id,
        lintScore: item.meta.lint_pass ? 1 : 0,
        dryRun,
      });
      // CODEX-IMP: in dry-run, do NOT move the queue item — leave for inspection.
      if (!dryRun && result?.sent) {
        await moveQueueItem(item.id, "approved", item.meta.mode === "auto" ? "auto-sent" : "sent");
      }
      sent += 1;
      if (drainAll && todo.length > 1) await sleep(jitter(45000, 180000));
    } catch (e) {
      failed += 1;
      console.error(`send_failed ${item.id}: ${e.message}`);
      if (/HALTED/.test(e.message)) break;
    }
  }
  await logSession({ event: "send", sent, failed, queue_remaining: queue.length - sent, dryRun });
  console.log(JSON.stringify({ sent, failed, queue_remaining: queue.length - sent, dryRun }));
} finally {
  await ctx.close();
}

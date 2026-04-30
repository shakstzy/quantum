#!/usr/bin/env node
// Drains 04-outbound/approved/ via patchright. One message per invocation by default
// (cron schedules invocations across the day). Pass --all to drain everything in one session.

import { launchPersistent } from "../src/runtime/profile.mjs";
import { sendMessage } from "../src/tinder/send.mjs";
import { listQueue, moveQueueItem, extractDraftedReply, readQueueItem } from "../src/runtime/queue.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
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
let sent = 0;       // truly delivered
let dryRunCount = 0; // typed-but-not-sent (dry-run only)
let failed = 0;
try {
  await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
  // Wait for matches list to render (cheap proxy for "session is alive + selectors healthy")
  try { await page.waitForSelector("a[href^='/app/messages/']", { timeout: 15000 }); }
  catch { console.error("matches list never rendered; halting"); process.exit(1); }

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
      // CODEX-R3-3: only count + move queue when truly sent. dry-run leaves
      // queue items in place for inspection and tracks count separately.
      if (result?.sent) {
        await moveQueueItem(item.id, "approved", item.meta.mode === "auto" ? "auto-sent" : "sent");
        sent += 1;
        // CODEX-R3-4: only sleep between REAL sends — dry-run validation should be fast.
        if (drainAll && todo.length > 1) await sleep(jitter(45000, 180000));
      } else if (result?.dryRun) {
        dryRunCount += 1;
      }
    } catch (e) {
      failed += 1;
      console.error(`send_failed ${item.id}: ${e.message}`);
      if (/HALTED/.test(e.message)) break;
    }
  }
  await logSession({ event: "send", sent, dryRun: dryRunCount, failed, queue_remaining: queue.length - sent });
  console.log(JSON.stringify({ sent, dryRunCount, failed, queue_remaining: queue.length - sent, dryRun }));
} finally {
  await ctx.close();
}

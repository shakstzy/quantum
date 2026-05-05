#!/usr/bin/env node
// Daily pull: dump inbox + each recent thread + invites into raw/linkedin/.
// Read-only on LinkedIn. Per-action budget gating.

import { launchPersistent } from "../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../src/linkedin/session.mjs";
import { LinkedInExtractor } from "../src/linkedin/extractor.mjs";
import { upsertPerson } from "../src/runtime/entity-store.mjs";
import { toSlug } from "../src/runtime/slug.mjs";
import { gate, record } from "../src/policy/rate-limits.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";
import { loadCaps } from "../src/runtime/caps.mjs";
import { sprinkleBetween, tickBurst, maybeGetDistracted } from "../src/runtime/messy-human.mjs";

const args = parseArgs(process.argv.slice(2));
const threadLimit = Number(args["thread-limit"] ?? 10);

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const ext = new LinkedInExtractor(page);

  // Inbox
  const inbox = await ext.getInbox({ limit: threadLimit });
  console.log(`[pull] inbox refs: ${inbox.threads.length}`);

  // Each thread
  for (const t of inbox.threads.slice(0, threadLimit)) {
    await maybeGetDistracted();
    await sprinkleBetween(page);
    try { await gate("get_profile"); } catch { console.log("[pull] budget exhausted, stopping thread enrichment"); break; }
    try {
      const conv = await ext.getConversation({ threadId: t.threadId });
      const slug = toSlug(t.name || t.threadId);
      await upsertPerson({
        slug,
        frontmatter: { slug, linkedin_thread_id: t.threadId, name: t.name || null, source: "thread_sync", last_pulled_at: new Date().toISOString() },
        profileSnapshot: null,
        threadEvent: { direction: "system", text: `Pulled thread snapshot (${(conv.sections.conversation || "").length} chars)`, ts: new Date().toISOString() },
      });
      await record("get_profile", { target: t.threadId });
    } catch (err) {
      console.error(`[pull] thread ${t.threadId} skipped: ${err.code ?? "ERR"} ${err.message}`);
    }
    const [lo, hi] = (await loadCaps()).pacing.inter_action_seconds;
    await sleep(jitter(lo * 1000, hi * 1000));
    await tickBurst(page);
  }

  // Invitations (received + sent)
  for (const direction of ["received", "sent"]) {
    await sprinkleBetween(page);
    try {
      const inv = await ext.listInvites({ direction });
      console.log(`[pull] invites (${direction}): ${(inv.sections.invites || "").length} chars`);
    } catch (err) {
      console.error(`[pull] invites ${direction} skipped: ${err.code ?? "ERR"} ${err.message}`);
    }
  }

  console.log("[pull] done");
} catch (err) {
  console.error(`[pull] ${err.code ?? "ERR"} ${err.message}`);
  exit = 1;
} finally {
  await ctx.close();
  process.exit(exit);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--thread-limit") out["thread-limit"] = argv[++i];
  }
  return out;
}

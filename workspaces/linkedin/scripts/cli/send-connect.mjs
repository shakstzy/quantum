#!/usr/bin/env node
// Send a connection request. Default --dry-run. Pass --send to execute.
// Uses LinkedIn's /preload/custom-invite/?vanityName=<id> deeplink, no Connect-button DOM hunt.

import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInExtractor } from "../../src/linkedin/extractor.mjs";
import { gate, record } from "../../src/policy/rate-limits.mjs";
import { enforcePendingCeiling } from "../../src/policy/pending-budget.mjs";
import { urlOrIdToPublicId } from "../../src/runtime/identity.mjs";
import { upsertPerson } from "../../src/runtime/entity-store.mjs";
import { toSlug } from "../../src/runtime/slug.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.profile) {
  console.error("Usage: send-connect.mjs --profile <public_id_or_url> [--note \"...\"] [--send] [--skip-ceiling]");
  process.exit(1);
}
const publicId = urlOrIdToPublicId(args.profile);
if (!publicId) { console.error("Cannot derive public_id from input."); process.exit(1); }
const dryRun = !args.send;

await gate("send_connect");

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const ext = new LinkedInExtractor(page);

  // Pending-ceiling enforcement (P0 fix from codex r2 + r3). FAIL CLOSED: if we can't count
  // OR if remaining-after-withdraw is still above the ceiling, we don't send. Override with
  // --skip-ceiling for dev only. Surfaces the BLOCKED message in dry-run too (Codex r3 P2).
  if (!args["skip-ceiling"]) {
    const { gate: gateFn, record: recordFn } = await import("../../src/policy/rate-limits.mjs");
    const ceiling = await enforcePendingCeiling(page, ext, { dryRun, gate: gateFn, record: recordFn });
    console.log(`[pending-ceiling] ${JSON.stringify(ceiling)}`);
    if (!ceiling.ok) {
      const reason = ceiling.reason ?? ceiling.action;
      console.error(`[send-connect] BLOCKED by pending-ceiling: ${reason}`);
      if (!dryRun) process.exit(2);
      // dry-run: surface the block but exit cleanly (no live action attempted)
      process.exit(0);
    }
  }

  const result = await ext.connectWithPerson(publicId, { note: args.note ?? null, dryRun });
  console.log(`[send-connect] ${JSON.stringify(result)}`);
  if (result.ok && !dryRun) {
    await record("send_connect", { target: publicId });
    const slug = toSlug(publicId);
    await upsertPerson({
      slug,
      frontmatter: { linkedin_public_id: publicId, linkedin_url: result.url, connection_status: result.status === "accepted" ? "connected" : "pending", source: "manual_url" },
      threadEvent: { direction: "system", text: `Connection ${result.status}${args.note ? " (with note)" : " (no note)"}`, ts: new Date().toISOString() },
    });
  }
} catch (err) {
  console.error(`[send-connect] ${err.code ?? "ERR"} ${err.message}`);
  exit = 1;
} finally {
  await ctx.close();
  process.exit(exit);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--note") out.note = argv[++i];
    else if (a === "--send") out.send = true;
    else if (a === "--skip-ceiling") out["skip-ceiling"] = true;
  }
  return out;
}

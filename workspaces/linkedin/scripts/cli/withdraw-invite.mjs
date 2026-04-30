#!/usr/bin/env node
// Withdraw an outstanding sent invite by username. Default --dry-run.

import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInExtractor } from "../../src/linkedin/extractor.mjs";
import { gate, record } from "../../src/policy/rate-limits.mjs";
import { urlOrIdToPublicId } from "../../src/runtime/identity.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.profile) {
  console.error("Usage: withdraw-invite.mjs --profile <public_id_or_url> [--send]");
  process.exit(1);
}
const publicId = urlOrIdToPublicId(args.profile);
if (!publicId) { console.error("Cannot derive public_id."); process.exit(1); }
const dryRun = !args.send;

await gate("withdraw_invite");

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const ext = new LinkedInExtractor(page);
  const result = await ext.withdrawInvite(publicId, { dryRun });
  console.log(`[withdraw-invite] ${JSON.stringify(result)}`);
  if (result.ok && !dryRun) await record("withdraw_invite", { target: publicId });
} catch (err) {
  console.error(`[withdraw-invite] ${err.code ?? "ERR"} ${err.message}`);
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
    else if (a === "--send") out.send = true;
  }
  return out;
}

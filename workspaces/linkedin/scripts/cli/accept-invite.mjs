#!/usr/bin/env node
// Accept an incoming connection request by username. Uses connectWithPerson which
// detects state=incoming_request and clicks the inline Accept button on the profile.
// Default --dry-run. Pass --send to actually accept.

import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInExtractor } from "../../src/linkedin/extractor.mjs";
import { gate, record } from "../../src/policy/rate-limits.mjs";
import { urlOrIdToPublicId } from "../../src/runtime/identity.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.profile) {
  console.error("Usage: accept-invite.mjs --profile <public_id_or_url> [--send]");
  process.exit(1);
}
const publicId = urlOrIdToPublicId(args.profile);
if (!publicId) { console.error("Cannot derive public_id."); process.exit(1); }
const dryRun = !args.send;

await gate("accept_invite");

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const ext = new LinkedInExtractor(page);
  const result = await ext.connectWithPerson(publicId, { dryRun });
  console.log(`[accept-invite] ${JSON.stringify(result)}`);
  if (result.ok && !dryRun) await record("accept_invite", { target: publicId });
} catch (err) {
  console.error(`[accept-invite] ${err.code ?? "ERR"} ${err.message}`);
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

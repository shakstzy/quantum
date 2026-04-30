#!/usr/bin/env node
// Send a DM via LinkedIn's compose deeplink (?profileUrn=&recipient=&screenContext=NON_SELF_PROFILE_VIEW&interop=msgOverlay).
// Default --dry-run. Pass --send to execute.

import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInExtractor } from "../../src/linkedin/extractor.mjs";
import { gate, record } from "../../src/policy/rate-limits.mjs";
import { urlOrIdToPublicId } from "../../src/runtime/identity.mjs";
import { upsertPerson } from "../../src/runtime/entity-store.mjs";
import { toSlug } from "../../src/runtime/slug.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.profile || !args.text) {
  console.error("Usage: send-dm.mjs --profile <id> --text \"...\" [--send] [--to-connection] [--profile-urn <urn>]");
  process.exit(1);
}
const publicId = urlOrIdToPublicId(args.profile);
if (!publicId) { console.error("Cannot derive public_id from input."); process.exit(1); }
const dryRun = !args.send;
const action = args["to-connection"] ? "send_dm_to_connection" : "send_dm_to_non_connection";

await gate(action);

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const ext = new LinkedInExtractor(page);
  const result = await ext.sendMessage(publicId, args.text, { confirmSend: !dryRun, profileUrn: args["profile-urn"] ?? null });
  console.log(`[send-dm] ${JSON.stringify(result)}`);
  if (result.ok && !dryRun) {
    await record(action, { target: publicId });
    const slug = toSlug(publicId);
    await upsertPerson({
      slug,
      frontmatter: { linkedin_public_id: publicId, linkedin_url: result.url, source: "manual_url" },
      threadEvent: { direction: "outbound", text: args.text, ts: new Date().toISOString() },
    });
  }
} catch (err) {
  console.error(`[send-dm] ${err.code ?? "ERR"} ${err.message}`);
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
    else if (a === "--text") out.text = argv[++i];
    else if (a === "--profile-urn") out["profile-urn"] = argv[++i];
    else if (a === "--send") out.send = true;
    else if (a === "--to-connection") out["to-connection"] = true;
  }
  return out;
}

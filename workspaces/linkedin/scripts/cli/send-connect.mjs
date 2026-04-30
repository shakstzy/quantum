#!/usr/bin/env node
// Default is dry-run. Pass `--send` (literal token) to actually send.
import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInClient } from "../../src/linkedin/client.mjs";
import { sendConnectViaDom } from "../../src/linkedin/dom/connect.mjs";
import { enforcePendingCeiling } from "../../src/policy/pending-budget.mjs";
import { gate, record } from "../../src/policy/rate-limits.mjs";
import { urlOrIdToPublicId } from "../../src/runtime/identity.mjs";
import { upsertPerson } from "../../src/runtime/entity-store.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.profile) {
  console.error("Usage: send-connect.mjs --profile <public_id_or_url> [--send]");
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
  const client = new LinkedInClient({ ctx, page });

  // Pending-ceiling enforcement: if total pending > 400, withdraw oldest before adding more.
  const ceilingCheck = await enforcePendingCeiling(client, { dryRun });
  console.log(`[pending-ceiling] ${JSON.stringify(ceilingCheck)}`);

  const result = await sendConnectViaDom(page, { publicId, dryRun });
  console.log(`[send-connect] ${JSON.stringify(result)}`);
  if (result.ok && !dryRun) {
    await record("send_connect", { target: publicId });
    await upsertPerson({
      slug: `temp-${publicId}`,
      frontmatter: { linkedin_public_id: publicId, connection_status: "pending", source: "manual_url" },
      threadEvent: { direction: "system", text: "Connection request sent (no note)", ts: new Date().toISOString() },
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
    else if (a === "--send") out.send = true;
  }
  return out;
}

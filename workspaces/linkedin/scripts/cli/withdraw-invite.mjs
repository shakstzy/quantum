#!/usr/bin/env node
import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInClient } from "../../src/linkedin/client.mjs";
import { withdrawInvite } from "../../src/linkedin/voyager/connections.mjs";
import { gate, record } from "../../src/policy/rate-limits.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args["invitation-urn"]) {
  console.error("Usage: withdraw-invite.mjs --invitation-urn <urn> [--send]");
  process.exit(1);
}
const dryRun = !args.send;
await gate("withdraw_invite");

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const client = new LinkedInClient({ ctx, page });
  if (dryRun) {
    console.log(`[dry-run] would withdraw ${args["invitation-urn"]}`);
  } else {
    const r = await withdrawInvite(client, { invitationUrn: args["invitation-urn"] });
    await record("withdraw_invite", { target: args["invitation-urn"] });
    console.log(`[withdraw-invite] ${args["invitation-urn"]} status=${r._status}`);
  }
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
    if (a === "--invitation-urn") out["invitation-urn"] = argv[++i];
    else if (a === "--send") out.send = true;
  }
  return out;
}

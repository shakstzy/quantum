#!/usr/bin/env node
import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInClient } from "../../src/linkedin/client.mjs";
import { listPendingInvites, pendingSentCount } from "../../src/linkedin/voyager/connections.mjs";

const args = parseArgs(process.argv.slice(2));
const direction = args.direction ?? "received";
const limit = Number(args.limit ?? 50);

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const client = new LinkedInClient({ ctx, page });
  const invites = await listPendingInvites(client, { direction, limit });
  let sentTotal = null;
  if (direction === "sent") sentTotal = await pendingSentCount(client);
  if (args.json) {
    console.log(JSON.stringify({ direction, total_outstanding: sentTotal, invites }, null, 2));
  } else {
    if (sentTotal !== null) console.log(`Total outstanding sent invites: ${sentTotal}`);
    for (const inv of invites) {
      const ts = inv.sentAt ? new Date(inv.sentAt).toISOString() : "?";
      console.log(`${ts}  ${inv.type ?? "?"}  ${inv.invitationUrn}`);
      if (inv.message) console.log(`    note: ${inv.message.slice(0, 120)}`);
    }
  }
} catch (err) {
  console.error(`[list-invites] ${err.code ?? "ERR"} ${err.message}`);
  exit = 1;
} finally {
  await ctx.close();
  process.exit(exit);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--direction") out.direction = argv[++i];
    else if (a === "--limit") out.limit = argv[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

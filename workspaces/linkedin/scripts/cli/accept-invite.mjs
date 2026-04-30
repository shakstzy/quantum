#!/usr/bin/env node
import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInClient } from "../../src/linkedin/client.mjs";
import { acceptInvite, ignoreInvite, listPendingInvites } from "../../src/linkedin/voyager/connections.mjs";
import { gate, record } from "../../src/policy/rate-limits.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args["invitation-urn"] && !args.all) {
  console.error("Usage: accept-invite.mjs (--invitation-urn <urn> --shared-secret <s> | --all) [--ignore] [--send]");
  process.exit(1);
}
const ignore = !!args.ignore;
const action = ignore ? "ignore_invite" : "accept_invite";
const dryRun = !args.send;

await gate(action);

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const client = new LinkedInClient({ ctx, page });

  let targets;
  if (args.all) {
    const list = await listPendingInvites(client, { direction: "received", limit: 50 });
    targets = list;
  } else {
    targets = [{ invitationUrn: args["invitation-urn"], sharedSecret: args["shared-secret"] }];
  }

  for (const t of targets) {
    if (dryRun) {
      console.log(`[dry-run] would ${ignore ? "ignore" : "accept"} ${t.invitationUrn}`);
      continue;
    }
    const r = ignore
      ? await ignoreInvite(client, { invitationUrn: t.invitationUrn, sharedSecret: t.sharedSecret })
      : await acceptInvite(client, { invitationUrn: t.invitationUrn, sharedSecret: t.sharedSecret });
    await record(action, { target: t.invitationUrn });
    console.log(`[${action}] ${t.invitationUrn} status=${r._status}`);
  }
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
    if (a === "--invitation-urn") out["invitation-urn"] = argv[++i];
    else if (a === "--shared-secret") out["shared-secret"] = argv[++i];
    else if (a === "--all") out.all = true;
    else if (a === "--ignore") out.ignore = true;
    else if (a === "--send") out.send = true;
  }
  return out;
}

#!/usr/bin/env node
// One-time interactive login. Launches the persistent Chrome profile headful, waits up to
// 5 minutes for the user to complete login by hand, then sanity-checks via Voyager.
//
// We do NOT auto-fill credentials. 2FA + checkpoints + comply gates need a human.

import { launchPersistent } from "../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../src/linkedin/session.mjs";
import { LinkedInClient } from "../src/linkedin/client.mjs";
import { getSelfProfile } from "../src/linkedin/voyager/profile.mjs";
import { abortIfHalted, isHalted } from "../src/runtime/halt.mjs";

if (await isHalted()) {
  console.error("Workspace is halted. Inspect ~/.quantum/linkedin/.halt before re-running login.");
  process.exit(2);
}
await abortIfHalted();

console.log("[login] launching persistent Chrome profile…");
const { ctx, page } = await launchPersistent({ headless: false });
let exitCode = 0;
try {
  await ensureLoggedIn(page, { allowInteractive: true, interactiveTimeoutMs: 5 * 60_000 });
  console.log("[login] /feed reached. Verifying Voyager session via getSelfProfile…");
  const client = new LinkedInClient({ ctx, page });
  const me = await getSelfProfile(client);
  console.log("[login] OK. Self profile:");
  console.log(JSON.stringify({ urn: me.urn, publicId: me.publicIdentifier, fullName: me.fullName, headline: me.headline }, null, 2));
} catch (err) {
  console.error(`[login] failed: ${err.code ?? "ERR"} ${err.message}`);
  exitCode = 1;
} finally {
  await ctx.close();
  process.exit(exitCode);
}

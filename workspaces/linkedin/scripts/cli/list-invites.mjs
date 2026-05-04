#!/usr/bin/env node
import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInExtractor } from "../../src/linkedin/extractor.mjs";

const args = parseArgs(process.argv.slice(2));
const direction = args.direction ?? "received";

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const ext = new LinkedInExtractor(page);
  const result = await ext.listInvites({ direction });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Invitations (${direction}) at ${result.url}:`);
    console.log(`Entries (${result.entries.length}):`);
    for (const e of result.entries) console.log(`  ${e.slug}\t${e.displayName ?? ""}`);
    console.log("\n--- raw page text (truncated) ---");
    console.log((result.sections.invites || "").slice(0, 2000));
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
    else if (a === "--json") out.json = true;
  }
  return out;
}

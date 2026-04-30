#!/usr/bin/env node
import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInExtractor } from "../../src/linkedin/extractor.mjs";

const args = parseArgs(process.argv.slice(2));
const limit = Number(args.limit ?? 20);

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const ext = new LinkedInExtractor(page);
  const result = await ext.getInbox({ limit });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Inbox (${result.threads.length} thread refs):`);
    for (const t of result.threads) console.log(`  ${t.threadId}  ${t.name}`);
    console.log("\n--- raw inbox text (truncated) ---");
    console.log((result.sections.inbox || "").slice(0, 1500));
  }
} catch (err) {
  console.error(`[list-threads] ${err.code ?? "ERR"} ${err.message}`);
  exit = 1;
} finally {
  await ctx.close();
  process.exit(exit);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") out.limit = argv[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

#!/usr/bin/env node
import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInExtractor } from "../../src/linkedin/extractor.mjs";
import { gate, record } from "../../src/policy/rate-limits.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.query) {
  console.error("Usage: search-people.mjs --query \"...\" [--location \"...\"] [--json]");
  process.exit(1);
}
await gate("search_people");

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const ext = new LinkedInExtractor(page);
  const result = await ext.searchPeople({ query: args.query, location: args.location ?? null });
  await record("search_people", { target: args.query, extra: { hits: result.profiles?.length ?? 0 } });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Found ${result.profiles.length} profile links:`);
    for (const p of result.profiles.slice(0, 25)) console.log(`  ${p.username}`);
    console.log("\n--- raw search text (truncated) ---");
    console.log((result.sections.search_results || "").slice(0, 2000));
  }
} catch (err) {
  console.error(`[search-people] ${err.code ?? "ERR"} ${err.message}`);
  exit = 1;
} finally {
  await ctx.close();
  process.exit(exit);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--query") out.query = argv[++i];
    else if (a === "--location") out.location = argv[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

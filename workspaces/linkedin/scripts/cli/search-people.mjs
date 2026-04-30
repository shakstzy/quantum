#!/usr/bin/env node
import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInClient } from "../../src/linkedin/client.mjs";
import { searchPeople } from "../../src/linkedin/voyager/search.mjs";
import { gate } from "../../src/policy/rate-limits.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.query) {
  console.error("Usage: search-people.mjs --query <q> [--limit 25] [--json]");
  process.exit(1);
}
await gate("search_people");

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const client = new LinkedInClient({ ctx, page });
  const hits = await searchPeople(client, { query: args.query, limit: Number(args.limit ?? 25) });
  if (args.json) console.log(JSON.stringify(hits, null, 2));
  else for (const h of hits) console.log(`${h.title ?? "?"}  -  ${h.subtitle ?? ""}  ${h.navigationUrl ?? ""}`);
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
    else if (a === "--limit") out.limit = argv[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

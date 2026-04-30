#!/usr/bin/env node
import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInClient } from "../../src/linkedin/client.mjs";
import { listThreads } from "../../src/linkedin/voyager/messaging.mjs";

const args = parseArgs(process.argv.slice(2));
const limit = Number(args.limit ?? 20);

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const client = new LinkedInClient({ ctx, page });
  const threads = await listThreads(client, { limit });
  if (args.json) {
    console.log(JSON.stringify(threads, null, 2));
  } else {
    for (const t of threads) {
      const ts = t.lastActivityAt ? new Date(t.lastActivityAt).toISOString() : "?";
      console.log(`${ts}  unread=${t.unreadCount}  ${t.title ?? "(no title)"}`);
      if (t.lastMessagePreview) console.log(`    ${t.lastMessagePreview.slice(0, 120)}`);
      console.log(`    urn=${t.conversationUrn}`);
    }
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

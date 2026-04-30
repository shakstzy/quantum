#!/usr/bin/env node
// Read a single conversation by --thread <id> or --profile <username>.
import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInExtractor } from "../../src/linkedin/extractor.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.thread && !args.profile) {
  console.error("Usage: get-conversation.mjs (--thread <id> | --profile <username>) [--json]");
  process.exit(1);
}

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const ext = new LinkedInExtractor(page);
  const result = await ext.getConversation({ threadId: args.thread, username: args.profile });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Conversation @ ${result.url}\n`);
    console.log(result.sections.conversation || "(empty)");
  }
} catch (err) {
  console.error(`[get-conversation] ${err.code ?? "ERR"} ${err.message}`);
  exit = 1;
} finally {
  await ctx.close();
  process.exit(exit);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--thread") out.thread = argv[++i];
    else if (a === "--profile") out.profile = argv[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

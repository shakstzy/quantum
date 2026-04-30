#!/usr/bin/env node
// Send a DM. Default dry-run. Resolves target via either an existing conversationUrn
// (--thread <urn>) or a public_id (--profile <id>) which goes through findOrCreateConversation.

import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInClient } from "../../src/linkedin/client.mjs";
import { sendMessage, findOrCreateConversation } from "../../src/linkedin/voyager/messaging.mjs";
import { getProfile, getSelfProfile } from "../../src/linkedin/voyager/profile.mjs";
import { gate, record } from "../../src/policy/rate-limits.mjs";
import { upsertPerson } from "../../src/runtime/entity-store.mjs";
import { profileToSlug, urlOrIdToPublicId } from "../../src/runtime/identity.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.text || (!args.profile && !args.thread)) {
  console.error("Usage: send-dm.mjs (--profile <id> | --thread <conv_urn>) --text <message> [--send] [--to-connection]");
  process.exit(1);
}
const dryRun = !args.send;
const action = args["to-connection"] ? "send_dm_to_connection" : "send_dm_to_non_connection";

await gate(action);

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const client = new LinkedInClient({ ctx, page });
  const me = await getSelfProfile(client);

  let conversationUrn = args.thread ?? null;
  let slug = null;
  let publicId = null;

  if (!conversationUrn) {
    publicId = urlOrIdToPublicId(args.profile);
    const profile = await getProfile(client, publicId);
    slug = profileToSlug(profile);
    if (dryRun) {
      console.log(`[dry-run] would create thread to ${profile.fullName ?? publicId} (${profile.urn}) and send: ${args.text}`);
    } else {
      const r = await findOrCreateConversation(client, page, {
        targetUrn: profile.urn, mailboxUrn: me.urn, text: args.text,
      });
      console.log(`[create-conversation] ${JSON.stringify(r)}`);
      conversationUrn = r.conversationUrn;
      if (!conversationUrn && r.dom) {
        // DOM fallback path: composer is now visible. Caller can integrate dom/compose later.
        console.log(`[send-dm] DOM compose required (not implemented in v0). Aborting safely.`);
        return;
      }
    }
  } else if (dryRun) {
    console.log(`[dry-run] would send into thread ${conversationUrn}: ${args.text}`);
  }

  if (!dryRun && conversationUrn) {
    const r = await sendMessage(client, { conversationUrn, mailboxUrn: me.urn, text: args.text });
    console.log(`[send-message] status=${r._status}`);
    await record(action, { target: publicId ?? conversationUrn });
    if (slug) {
      await upsertPerson({
        slug,
        frontmatter: { linkedin_public_id: publicId, source: "manual_url" },
        threadEvent: { direction: "outbound", text: args.text },
      });
    }
  }
} catch (err) {
  console.error(`[send-dm] ${err.code ?? "ERR"} ${err.message}`);
  exit = 1;
} finally {
  await ctx.close();
  process.exit(exit);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--thread") out.thread = argv[++i];
    else if (a === "--text") out.text = argv[++i];
    else if (a === "--send") out.send = true;
    else if (a === "--to-connection") out["to-connection"] = true;
  }
  return out;
}

#!/usr/bin/env node
// Daily pull: invitations (received) + recent threads + new messages.
// Writes/updates raw/linkedin/<slug>-linkedin.md per participant.
// Read-only on LinkedIn (no sends). Rate-budgeted via gate("get_profile") for the profile fetches.

import { launchPersistent } from "../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../src/linkedin/session.mjs";
import { LinkedInClient } from "../src/linkedin/client.mjs";
import { getSelfProfile, getProfile } from "../src/linkedin/voyager/profile.mjs";
import { listThreads, getThread } from "../src/linkedin/voyager/messaging.mjs";
import { listPendingInvites, pendingSentCount } from "../src/linkedin/voyager/connections.mjs";
import { upsertPerson } from "../src/runtime/entity-store.mjs";
import { profileToSlug } from "../src/runtime/identity.mjs";
import { gate, record } from "../src/policy/rate-limits.mjs";
import { interActionSpacing } from "../src/runtime/humanize.mjs";
import { sprinkleBetween, tickBurst, maybeGetDistracted } from "../src/runtime/messy-human.mjs";

const args = parseArgs(process.argv.slice(2));
const threadLimit = Number(args["thread-limit"] ?? 10);
const inviteLimit = Number(args["invite-limit"] ?? 25);

const { ctx, page } = await launchPersistent({ headless: false });
let exit = 0;
try {
  await ensureLoggedIn(page);
  const client = new LinkedInClient({ ctx, page });

  // Self
  await gate("get_profile");
  const me = await getSelfProfile(client);
  console.log(`[pull] self: ${me.fullName} (${me.urn})`);

  // Pending sent count (cheap, useful for surfacing pending-ceiling pressure)
  const sentTotal = await pendingSentCount(client);
  console.log(`[pull] outstanding sent invites: ${sentTotal}`);

  // Inbound invitations
  await sprinkleBetween(page);
  const invitesIn = await listPendingInvites(client, { direction: "received", limit: inviteLimit });
  console.log(`[pull] received invites: ${invitesIn.length}`);

  // Threads
  await sprinkleBetween(page);
  const threads = await listThreads(client, { limit: threadLimit });
  console.log(`[pull] recent threads: ${threads.length}`);

  for (const t of threads) {
    await maybeGetDistracted();
    await sprinkleBetween(page);
    const msgs = await getThread(client, t.conversationUrn, { limit: 25 });
    // Best-effort: enrich participants once per pull. We only fetch profiles for participants
    // we don't already have (cheap heuristic: iterate participants except me).
    for (const pUrn of t.participantUrns) {
      if (!pUrn || pUrn === me.urn) continue;
      try {
        await gate("get_profile");
      } catch {
        break; // budget hit; skip the rest of enrichment this pull
      }
      const profile = await getProfileSafe(client, pUrn);
      if (!profile) continue;
      const slug = profileToSlug(profile);
      const lastMsg = msgs[msgs.length - 1];
      await upsertPerson({
        slug,
        frontmatter: {
          slug,
          linkedin_public_id: profile.publicIdentifier,
          linkedin_urn: profile.urn,
          name: profile.fullName,
          headline: profile.headline,
          source: "thread_sync",
          last_message_at: lastMsg ? new Date(lastMsg.deliveredAt).toISOString() : null,
        },
        threadEvent: lastMsg ? {
          direction: lastMsg.senderUrn === me.urn ? "outbound" : "inbound",
          text: lastMsg.text ?? "(no text)",
          ts: new Date(lastMsg.deliveredAt).toISOString(),
        } : null,
      });
      await record("get_profile", { target: profile.publicIdentifier ?? pUrn });
      await interActionSpacing();
    }
    await tickBurst(page);
  }

  console.log(`[pull] done`);
} catch (err) {
  console.error(`[pull] ${err.code ?? "ERR"} ${err.message}`);
  exit = 1;
} finally {
  await ctx.close();
  process.exit(exit);
}

async function getProfileSafe(client, urnOrId) {
  try {
    // Voyager's profile endpoint accepts both fsd_profile URN and public_id when given via the
    // memberIdentity facet. URN takes the form urn:li:fsd_profile:<id>; we feed the id portion.
    const id = String(urnOrId).split(":").pop();
    return await getProfile(client, id);
  } catch (err) {
    console.error(`[pull] getProfile(${urnOrId}) skipped: ${err.code ?? "ERR"} ${err.message}`);
    return null;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--thread-limit") out["thread-limit"] = argv[++i];
    else if (a === "--invite-limit") out["invite-limit"] = argv[++i];
  }
  return out;
}

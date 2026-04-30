#!/usr/bin/env node
import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInClient } from "../../src/linkedin/client.mjs";
import { getProfile, getContactInfo } from "../../src/linkedin/voyager/profile.mjs";
import { upsertPerson } from "../../src/runtime/entity-store.mjs";
import { profileToSlug } from "../../src/runtime/identity.mjs";
import { gate, record } from "../../src/policy/rate-limits.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.profile) {
  console.error("Usage: get-profile.mjs --profile <public_id_or_url> [--with-contact-info] [--no-write] [--json]");
  process.exit(1);
}

await gate("get_profile");

const { ctx, page } = await launchPersistent({ headless: false });
let exitCode = 0;
try {
  await ensureLoggedIn(page);
  const client = new LinkedInClient({ ctx, page });
  const profile = await getProfile(client, args.profile);
  let contact = null;
  if (args["with-contact-info"] && profile.publicIdentifier) {
    contact = await getContactInfo(client, profile.publicIdentifier);
  }
  const slug = profileToSlug(profile);

  if (!args["no-write"]) {
    const fm = {
      slug,
      linkedin_public_id: profile.publicIdentifier,
      linkedin_urn: profile.urn,
      name: profile.fullName,
      headline: profile.headline,
      industry: profile.industryName,
      location: profile.locationName,
      email: contact?.emailAddress ?? null,
      phone: contact?.phoneNumbers?.[0]?.number ?? null,
      source: "manual_url",
    };
    const summary =
      `**${profile.fullName ?? "(no name)"}**  \n` +
      `${profile.headline ?? ""}  \n` +
      `${profile.locationName ? `Location: ${profile.locationName}  \n` : ""}` +
      `${profile.industryName ? `Industry: ${profile.industryName}  \n` : ""}` +
      (profile.summary ? `\n${profile.summary}\n` : "");
    const file = await upsertPerson({ slug, frontmatter: fm, profileSnapshot: summary });
    await record("get_profile", { target: profile.publicIdentifier, extra: { slug, file } });
    if (args.json) {
      console.log(JSON.stringify({ profile, contact, slug, file }, null, 2));
    } else {
      console.log(`OK ${profile.fullName ?? profile.publicIdentifier}  ->  ${file}`);
    }
  } else {
    if (args.json) console.log(JSON.stringify({ profile, contact }, null, 2));
    else console.log(`${profile.fullName ?? profile.publicIdentifier}: ${profile.headline ?? ""}`);
  }
} catch (err) {
  console.error(`[get-profile] ${err.code ?? "ERR"} ${err.message}`);
  exitCode = 1;
} finally {
  await ctx.close();
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--with-contact-info") out["with-contact-info"] = true;
    else if (a === "--no-write") out["no-write"] = true;
    else if (a === "--json") out.json = true;
  }
  return out;
}

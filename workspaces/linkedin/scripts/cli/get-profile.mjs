#!/usr/bin/env node
import { launchPersistent } from "../../src/runtime/profile.mjs";
import { ensureLoggedIn } from "../../src/linkedin/session.mjs";
import { LinkedInExtractor } from "../../src/linkedin/extractor.mjs";
import { upsertPerson } from "../../src/runtime/entity-store.mjs";
import { toSlug } from "../../src/runtime/slug.mjs";
import { urlOrIdToPublicId } from "../../src/runtime/identity.mjs";
import { gate, record } from "../../src/policy/rate-limits.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.profile) {
  console.error("Usage: get-profile.mjs --profile <public_id_or_url> [--no-write] [--json]");
  process.exit(1);
}

await gate("get_profile");
const publicId = urlOrIdToPublicId(args.profile);
if (!publicId) { console.error("Cannot derive public_id from input."); process.exit(1); }

const { ctx, page } = await launchPersistent({ headless: false });
let exitCode = 0;
try {
  await ensureLoggedIn(page);
  const ext = new LinkedInExtractor(page);
  const result = await ext.getPersonProfile(publicId);
  const slug = result.displayName ? toSlug(result.displayName) : toSlug(publicId);

  if (!args["no-write"]) {
    const fm = {
      slug,
      linkedin_public_id: publicId,
      linkedin_url: result.url,
      linkedin_urn: result.profileUrn,
      name: result.displayName,
      source: "manual_url",
      last_pulled_at: new Date().toISOString(),
    };
    const file = await upsertPerson({ slug, frontmatter: fm, profileSnapshot: result.sections.main_profile });
    await record("get_profile", { target: publicId, extra: { slug, file } });
    if (args.json) {
      console.log(JSON.stringify({ slug, file, displayName: result.displayName, profileUrn: result.profileUrn, url: result.url }, null, 2));
    } else {
      console.log(`OK  ${result.displayName ?? publicId}  ->  ${file}`);
    }
  } else {
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.sections.main_profile.slice(0, 600));
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
    else if (a === "--no-write") out["no-write"] = true;
    else if (a === "--json") out.json = true;
  }
  return out;
}

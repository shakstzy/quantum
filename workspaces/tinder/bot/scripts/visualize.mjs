#!/usr/bin/env node
// One-time visual ingest pass over all entity files.
//
// For each entity in raw/tinder/<slug>.md that doesn't yet have a ## Visual section:
//  1. Open her thread, capture image URLs from the profile pane DOM
//  2. Download the photos to workspaces/tinder/.photos/<slug>/<i>.jpg (gitignored)
//  3. Send all photos in one cloud-llm call (gemini cycle → claude fallback)
//  4. Append structured ## Visual section to the entity markdown
//
// Hard rules:
// - Halt loud if cloud-llm fails. No graceful degradation.
// - Skip entities that already have a ## Visual section (one-time ingest, no re-run).
// - Never describe facial features (safety rule baked into prompt).
// - Serial loop, one entity at a time. Tinder's natural pace + one cloud call per match.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { listAllEntities, loadEntity, saveEntity, upsertMatch } from "../src/runtime/entity-store.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { logSession } from "../src/runtime/logger.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";
import { readThreadProfile } from "../src/tinder/page.mjs";
import { describeImages, CloudLLMUnreachable } from "../../../../_core/skills/cloud-llm/scripts/cycle.mjs";

const PHOTOS_DIR = resolve(process.cwd(), "bot/.photos");

const VISUAL_PROMPT = `You are analyzing a Tinder profile to help draft a contextual opening message.
Look at the photos and produce a STRUCTURED block. Do NOT describe facial features, body, or appearance.
Focus only on objective non-facial signal that could anchor a conversation.

Reply with EXACTLY this format (markdown bullets, fill in or write "(none observed)"):

- vibe: <one short phrase, e.g. "outdoorsy soft-grunge", "preppy cozy-girl", "techwear rave kid">
- settings: <comma-separated list of locations/environments seen, e.g. "ATX rooftop bars, hill country, music festivals, beach">
- activities: <comma-separated, e.g. "lifting, climbing, brunching, yoga, gaming">
- props: <distinctive objects: instruments, books visible, drinks, art, etc>
- pets: <species + notable details if visible, else "(none observed)">
- group_context: <"alone in most photos" | "lots of friend group shots" | "kids visible (probably nieces/nephews/own?)" | other>
- style_signals: <fashion / aesthetic markers: tattoos, piercings, hair-style-direction, outfits, dress style — NO facial features>
- environments: <home / outdoor / travel / nightlife mix>
- notable_signals: <anything specific worth anchoring on: a Stratocaster, a marathon medal, a specific city named on apparel, a published book, etc>
- red_flags: <heavy filtering, only-friend-group photos, AI-generated suspicion, mismatched apparent ages between photos — only flag if confident>

Return only the bullets. No preamble, no other prose.`;

async function captureProfilePhotoUrls(page, matchId) {
  await page.goto(`https://tinder.com/app/messages/${matchId}`, { waitUntil: "domcontentloaded" });
  await sleep(jitter(3500, 5000));

  // Photos can come from three places in modern Tinder builds:
  //   (1) the carousel <img>, swappable via Next button or ArrowRight keypress
  //   (2) <img srcset="..."> with multiple resolution variants
  //   (3) inline style backgroundImage on stacked-layout cards
  // Snapshot pulls all three. Container scope is widened from the inner
  // profileContent div up to its enclosing dialog/section so stacked layouts
  // (where photos live as siblings, not children) still get caught.
  const collected = new Set();

  async function snapshotPaneUrls() {
    const urls = await page.evaluate(() => {
      const inner = document.querySelector("[class*='profileContent']");
      if (!inner) return [];
      const root = inner.closest("section, dialog, [role='dialog'], [class*='profileCard'], [class*='profileWrap']") || inner;
      const hits = new Set();
      const collect = (s) => { if (s && s.includes("images-ssl.gotinder.com")) hits.add(s); };
      for (const img of root.querySelectorAll("img")) {
        collect(img.src);
        collect(img.currentSrc);
        if (img.srcset) for (const part of img.srcset.split(",")) collect(part.trim().split(/\s+/)[0]);
      }
      for (const el of root.querySelectorAll("*")) {
        const bg = (el.style && el.style.backgroundImage) || "";
        const m = bg.match(/url\("([^"]*images-ssl\.gotinder\.com[^"]*)"/);
        if (m) hits.add(m[1]);
      }
      return [...hits];
    });
    for (const u of urls) collected.add(u);
  }

  // Force lazy-loaded photos in stacked layouts to mount by scrolling the pane to bottom.
  async function scrollPaneToBottom() {
    await page.evaluate(() => {
      const inner = document.querySelector("[class*='profileContent']");
      if (!inner) return;
      const scroller = inner.closest("[class*='profileScroll'], [class*='profileWrap'], section, dialog, [role='dialog']") || inner;
      try { scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" }); } catch { scroller.scrollTop = scroller.scrollHeight; }
    });
  }

  // Initial capture
  await snapshotPaneUrls();

  // Strategy A: scroll the pane (cheap; covers stacked layouts where photos
  // are vertical siblings, not carousel slides). Repeat while it keeps
  // revealing new URLs.
  for (let i = 0; i < 6; i++) {
    const before = collected.size;
    await scrollPaneToBottom();
    await sleep(jitter(900, 1300));
    await snapshotPaneUrls();
    if (collected.size === before) break;
  }

  // Strategy B: explicit Next button if present.
  try {
    const carouselNext = await page.$("[class*='profileContent'] button[aria-label*='Next' i], [class*='profileContent'] [class*='carousel'] button[aria-label*='Next' i]");
    if (carouselNext) {
      for (let i = 0; i < 12; i++) {
        const before = collected.size;
        try { await carouselNext.click({ timeout: 800 }); } catch { break; }
        await sleep(jitter(1100, 1600));
        await snapshotPaneUrls();
        if (collected.size === before) {
          // Lazy-load can lag the click. Give it one more pass before declaring done.
          await sleep(900);
          await snapshotPaneUrls();
          if (collected.size === before) break;
        }
      }
    }
  } catch { /* selector miss is OK */ }

  // Strategy C: keyboard arrow-right with focus. Click pane first, then press.
  try {
    const pane = await page.$("[class*='profileContent']");
    if (pane) await pane.click({ timeout: 800 }).catch(() => {});
    for (let i = 0; i < 12; i++) {
      const before = collected.size;
      await page.keyboard.press("ArrowRight").catch(() => {});
      await sleep(jitter(1100, 1600));
      await snapshotPaneUrls();
      if (collected.size === before) {
        await sleep(900);
        await snapshotPaneUrls();
        if (collected.size === before) break;
      }
    }
  } catch { /* fine */ }

  // Strategy D: click the right edge of the visible carousel image (some
  // Tinder builds advance only on tap-right, not on keyboard or button).
  try {
    const carouselImg = await page.$("[class*='profileContent'] img[src*='images-ssl.gotinder.com']");
    if (carouselImg) {
      const box = await carouselImg.boundingBox();
      if (box) {
        for (let i = 0; i < 12; i++) {
          const before = collected.size;
          await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2).catch(() => {});
          await sleep(jitter(1100, 1600));
          await snapshotPaneUrls();
          if (collected.size === before) {
            await sleep(900);
            await snapshotPaneUrls();
            if (collected.size === before) break;
          }
        }
      }
    }
  } catch { /* fine */ }

  return [...collected];
}

async function downloadPhotos(ctx, urls, slug) {
  const slugDir = resolve(PHOTOS_DIR, slug);
  await mkdir(slugDir, { recursive: true });
  const paths = [];
  for (let i = 0; i < urls.length; i++) {
    const path = resolve(slugDir, `${i}.jpg`);
    try {
      const resp = await ctx.request.get(urls[i]);
      const buf = await resp.body();
      if (buf.length < 5000) continue; // skip nav-thumb stragglers
      await writeFile(path, buf);
      paths.push(path);
    } catch (e) {
      console.error(`download failed ${urls[i]}: ${e.message}`);
    }
  }
  return paths;
}

function hasVisualSection(ent) {
  // entity-store splitSections doesn't know about ## Visual yet. We grep the raw file body.
  // The body is reconstructed from sections; easiest: re-read raw markdown.
  // (Caller passes the slug-loaded ent; we just check the .md file directly.)
  return ent._raw?.includes("\n## Visual\n") || false;
}

function buildVisualSection(visualOutput, engine, account, ts) {
  return [
    `<!-- engine=${engine} account=${account || "(n/a)"} ts=${ts} -->`,
    "",
    visualOutput.trim(),
  ].join("\n");
}

// Write the ## Visual section via saveEntity (canonical path through entity-store
// so the section is preserved by all other writers — diff path, message append,
// status change). visualBody is the rendered bullet-list block (no heading).
async function writeVisualToEntity(slug, visualBody) {
  const ent = await loadEntity(slug);
  const mode = ent.visual && ent.visual.trim() ? "replaced" : "inserted";
  await saveEntity({
    slug,
    meta: ent.meta,
    profile: ent.profile,
    conversation: ent.conversation,
    outbound: ent.outbound,
    profile_changes: ent.profile_changes,
    visual: visualBody,
  });
  return { mode };
}

async function entityHasVisual(slug) {
  try {
    const ent = await loadEntity(slug);
    return !!(ent.visual && ent.visual.trim());
  } catch { return false; }
}

async function main() {
  await abortIfHalted();
  await mkdir(PHOTOS_DIR, { recursive: true });

  // QUANTUM_TINDER_VISUALIZE_FORCE = comma-separated slugs to re-run even if
  // they already have a ## Visual section. Useful for redoing matches whose
  // earlier run hit a regression (e.g. carousel only captured 1 photo, or
  // gemini surfaced an in-band file-access error).
  const forceSlugs = new Set((process.env.QUANTUM_TINDER_VISUALIZE_FORCE || "")
    .split(",").map(s => s.trim()).filter(Boolean));

  const allEntities = await listAllEntities();
  const candidates = [];
  for (const ent of allEntities) {
    if (ent.meta.status === "unmatched" || ent.meta.status === "gone_dark") continue;
    if (forceSlugs.has(ent.slug)) { candidates.push(ent); continue; }
    if (forceSlugs.size > 0) continue; // FORCE mode: only the named slugs
    if (await entityHasVisual(ent.slug)) continue;
    candidates.push(ent);
  }

  const testLimit = parseInt(process.env.QUANTUM_TINDER_VISUALIZE_LIMIT || "0", 10);
  const todo = testLimit > 0 ? candidates.slice(0, testLimit) : candidates;
  console.log(`visualize: ${candidates.length} ${forceSlugs.size > 0 ? "forced" : "need visual"}; processing ${todo.length}`);

  const { ctx, page } = await launchPersistent({ headless: false });
  let done = 0, failed = 0, skipped_no_photos = 0;
  try {
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    try { await page.waitForSelector("a[href^='/app/messages/']", { timeout: 15000 }); }
    catch { console.error("matches list never rendered; halting"); process.exit(1); }

    for (const ent of todo) {
      try {
        // captureProfilePhotoUrls navigates to the thread + waits for pane render.
        // We piggy-back the same pane visit to (1) full-profile re-scrape, then
        // (2) photo carousel walk. One sweep, all the data.
        const urls = await captureProfilePhotoUrls(page, ent.meta.match_id);

        // Re-scrape the FULL profile pane while we're here (Essentials, Looking
        // for, Bio, Basics, Lifestyle, Interests, Dream job, height, school,
        // job, pronouns, sexuality, photo_verified, lives_in). upsertMatch
        // handles diff vs. existing Profile and emits a profile_changes block
        // for any field deltas; Visual section is preserved by saveEntity.
        let profileRescrapeStatus = "skipped";
        try {
          const profile = await readThreadProfile(page);
          const meaningful = profile && (profile.name || profile.age || profile.bio || profile.looking_for
            || (profile.basics && Object.keys(profile.basics).length)
            || (profile.lifestyle && Object.keys(profile.lifestyle).length)
            || (Array.isArray(profile.interests) && profile.interests.length)
            || (Array.isArray(profile.jobs) && profile.jobs.length)
            || (Array.isArray(profile.schools) && profile.schools.length));
          if (meaningful) {
            await upsertMatch({
              matchId: ent.meta.match_id,
              personId: ent.meta.person_id || null,
              name: profile.name || ent.meta.first_name,
              source: "tinder",
              profile,
            });
            profileRescrapeStatus = "rescraped";
          }
        } catch (e) {
          console.error(`${ent.slug}: profile re-scrape failed (continuing): ${e.message}`);
        }

        if (urls.length === 0) {
          console.log(`${ent.slug}: no photos found (profile=${profileRescrapeStatus}), skipping visual`);
          skipped_no_photos += 1;
          continue;
        }
        const paths = await downloadPhotos(ctx, urls, ent.slug);
        if (paths.length === 0) {
          console.log(`${ent.slug}: all photo downloads failed (profile=${profileRescrapeStatus}), skipping visual`);
          skipped_no_photos += 1;
          continue;
        }
        const result = await describeImages(paths, VISUAL_PROMPT);
        const ts = new Date().toISOString();
        const body = buildVisualSection(result.output, result.engine, result.account, ts);
        const wrote = await writeVisualToEntity(ent.slug, body);
        done += 1;
        console.log(`${ent.slug}: ${paths.length} photos, ${result.engine} (${result.account || "—"}), ${wrote.mode}, profile=${profileRescrapeStatus}`);
        // Pace between matches: random gap to look human-ish to Tinder + give cloud breathing room
        await sleep(jitter(4000, 9000));
      } catch (e) {
        if (e instanceof CloudLLMUnreachable) {
          console.error(`HALT: cloud-llm exhausted at ${ent.slug}: ${e.message}`);
          process.exit(2);
        }
        failed += 1;
        console.error(`${ent.slug}: ${e.message}`);
      }
    }
    await logSession({ event: "visualize", done, failed, skipped_no_photos, total: todo.length });
    console.log(JSON.stringify({ done, failed, skipped_no_photos, total: todo.length }));
  } finally {
    await ctx.close();
  }
}

await main();

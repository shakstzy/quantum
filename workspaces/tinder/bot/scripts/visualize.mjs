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
import { listAllEntities, loadEntity, saveEntity } from "../src/runtime/entity-store.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { logSession } from "../src/runtime/logger.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";
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
  await sleep(jitter(3000, 4500));

  // Tinder shows ONE carousel slide by default. To get all 4-7 photos we need to
  // advance through the carousel. The "next photo" button lives in the profile
  // pane carousel. Easiest: send keyboard arrow-right inside the pane focus,
  // capturing URLs after each advance. Stop when no new URL appears (looped).
  const collected = new Set();

  async function snapshotPaneUrls() {
    const urls = await page.evaluate(() => {
      const pane = document.querySelector("[class*='profileContent']");
      if (!pane) return [];
      const hits = new Set();
      for (const img of pane.querySelectorAll("img")) {
        if (img.src && img.src.includes("images-ssl.gotinder.com")) hits.add(img.src);
      }
      for (const el of pane.querySelectorAll("*")) {
        const bg = (el.style && el.style.backgroundImage) || "";
        const m = bg.match(/url\("([^"]*images-ssl\.gotinder\.com[^"]*)"/);
        if (m) hits.add(m[1]);
      }
      return [...hits];
    });
    for (const u of urls) collected.add(u);
  }

  // Initial capture
  await snapshotPaneUrls();

  // Click the carousel to focus, then advance with arrow-right up to 10 times.
  try {
    const carouselNext = await page.$("[class*='profileContent'] button[aria-label*='Next' i], [class*='profileContent'] [class*='carousel'] button[aria-label*='Next' i]");
    if (carouselNext) {
      // Some Tinder builds expose a clickable "next" button — preferred when present.
      for (let i = 0; i < 10; i++) {
        const before = collected.size;
        try { await carouselNext.click({ timeout: 800 }); } catch { break; }
        await sleep(jitter(500, 900));
        await snapshotPaneUrls();
        if (collected.size === before) break; // looped or no more
      }
    } else {
      // Fallback: keyboard arrow-right on the pane. Click the pane first to focus.
      const pane = await page.$("[class*='profileContent']");
      if (pane) await pane.click({ timeout: 800 }).catch(() => {});
      for (let i = 0; i < 10; i++) {
        const before = collected.size;
        await page.keyboard.press("ArrowRight").catch(() => {});
        await sleep(jitter(500, 900));
        await snapshotPaneUrls();
        if (collected.size === before) break;
      }
    }
  } catch { /* selector miss is OK; we still have the initial capture */ }

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

  const allEntities = await listAllEntities();
  const candidates = [];
  for (const ent of allEntities) {
    if (ent.meta.status === "unmatched" || ent.meta.status === "gone_dark") continue;
    if (await entityHasVisual(ent.slug)) continue;
    candidates.push(ent);
  }

  const testLimit = parseInt(process.env.QUANTUM_TINDER_VISUALIZE_LIMIT || "0", 10);
  const todo = testLimit > 0 ? candidates.slice(0, testLimit) : candidates;
  console.log(`visualize: ${candidates.length} need visual; processing ${todo.length}`);

  const { ctx, page } = await launchPersistent({ headless: false });
  let done = 0, failed = 0, skipped_no_photos = 0;
  try {
    await page.goto("https://tinder.com/app/matches", { waitUntil: "domcontentloaded" });
    try { await page.waitForSelector("a[href^='/app/messages/']", { timeout: 15000 }); }
    catch { console.error("matches list never rendered; halting"); process.exit(1); }

    for (const ent of todo) {
      try {
        const urls = await captureProfilePhotoUrls(page, ent.meta.match_id);
        if (urls.length === 0) {
          console.log(`${ent.slug}: no photos found, skipping`);
          skipped_no_photos += 1;
          continue;
        }
        const paths = await downloadPhotos(ctx, urls, ent.slug);
        if (paths.length === 0) {
          console.log(`${ent.slug}: all photo downloads failed, skipping`);
          skipped_no_photos += 1;
          continue;
        }
        const result = await describeImages(paths, VISUAL_PROMPT);
        const ts = new Date().toISOString();
        const body = buildVisualSection(result.output, result.engine, result.account, ts);
        const wrote = await writeVisualToEntity(ent.slug, body);
        done += 1;
        console.log(`${ent.slug}: ${paths.length} photos, ${result.engine} (${result.account || "—"}), ${wrote.mode}`);
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

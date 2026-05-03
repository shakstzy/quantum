#!/usr/bin/env node
// One-time visual ingest pass over all Bumble entity files.
//
// For each entity in raw/bumble/<slug>.md that doesn't yet have a ## Visual section:
//  1. Open her thread, capture image URLs from the profile pane DOM
//  2. Download photos to workspaces/bumble/.photos/<slug>/<i>.jpg (gitignored)
//  3. Send all photos in one cloud-llm call (gemini cycle -> claude fallback)
//  4. Append a structured ## Visual section to the entity markdown
//
// Mirrors workspaces/tinder/bot/scripts/visualize.mjs. Bumble-specific deltas:
//  - photo carousel uses `img.media-box__picture-image` with bumbcdn.com hosts
//  - thread is opened by clicking [data-qa-uid] on the contact row (no per-thread URL)
//  - profile pane is `.page__profile`; `readThreadProfile` already exposes photos[]
//  - Bumble photos are signed URLs with `&size=__size__` placeholders; we strip
//    them when building dedup keys but keep the original src for download
//
// Hard rules (mirrors tinder):
//  - Halt loud if cloud-llm fails. No graceful degradation.
//  - Skip entities that already have ## Visual unless QUANTUM_BUMBLE_VISUALIZE_FORCE.
//  - Never describe facial features (safety rule baked into prompt).
//  - Serial loop, one entity at a time. Bumble's natural pace + one cloud call.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchPersistent } from "../src/runtime/profile.mjs";
import { listAllEntities, loadEntity, saveEntity, upsertMatch } from "../src/runtime/entity-store.mjs";
import { abortIfHalted } from "../src/runtime/halt.mjs";
import { logSession } from "../src/runtime/logger.mjs";
import { sleep, jitter } from "../src/runtime/humanize.mjs";
import { openThread, readThreadProfile } from "../src/bumble/page.mjs";
import { scanForHalts } from "../src/runtime/detection.mjs";
import { describeImages, CloudLLMUnreachable } from "../../../../_core/skills/cloud-llm/scripts/cycle.mjs";
import { BOT_ROOT } from "../src/runtime/paths.mjs";

const PHOTOS_DIR = resolve(BOT_ROOT, ".photos");

const VISUAL_PROMPT = `You are analyzing a Bumble profile to help draft a contextual reply message.
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

// Walk the thread profile pane to capture every photo URL. Bumble's pane stacks
// photos vertically (no carousel; photos are siblings inside .page__profile),
// so scrolling the pane bottom is enough — no Next-button or arrow-key dance.
async function captureProfilePhotoUrls(page, matchId) {
  await openThread(page, matchId);
  await sleep(jitter(2400, 3500));
  await scanForHalts(page);

  // Wait for the profile pane to actually render before snapshotting. Lazy
  // photo carousel can take a beat to mount.
  try { await page.waitForSelector(".page__profile img.media-box__picture-image, .page__profile img[class*='profile__photo']", { timeout: 8000 }); }
  catch { /* pane might be empty profile or load slower */ }

  const collected = new Set();

  async function snapshotPaneUrls() {
    const urls = await page.evaluate(() => {
      const root = document.querySelector(".page__profile") || document;
      const hits = new Set();
      const collect = (s) => {
        if (!s) return;
        let u = s;
        if (u.startsWith("//")) u = "https:" + u;
        if (!u.includes("bumbcdn.com")) return;
        // Skip non-photo asset URLs (lifestyle badge icons, sprite sheets, etc.)
        if (u.includes("/lifestyle_badges/") || u.includes("/assets/")) return;
        hits.add(u);
      };
      // Encounters surface uses .media-box__picture-image; thread pane uses .profile__photo.
      // Both share host bumbcdn.com but differ on class.
      for (const img of root.querySelectorAll("img.media-box__picture-image, img.profile__photo, img[class*='profile__photo'], img[class*='media-box']")) {
        collect(img.src);
        collect(img.currentSrc);
        if (img.srcset) for (const part of img.srcset.split(",")) collect(part.trim().split(/\s+/)[0]);
      }
      // Some Bumble layouts use background-image inline styles for portrait stacks.
      for (const el of root.querySelectorAll("*")) {
        const bg = (el.style && el.style.backgroundImage) || "";
        const m = bg.match(/url\(["']?([^"')]*bumbcdn\.com[^"')]*)/);
        if (m) hits.add(m[1].startsWith("//") ? "https:" + m[1] : m[1]);
      }
      return [...hits];
    });
    for (const u of urls) collected.add(u);
  }

  async function scrollPaneToBottom() {
    await page.evaluate(() => {
      const root = document.querySelector(".page__profile") || document.scrollingElement;
      try { root.scrollTo({ top: root.scrollHeight, behavior: "instant" }); }
      catch { root.scrollTop = root.scrollHeight; }
    });
  }

  await snapshotPaneUrls();
  for (let i = 0; i < 8; i++) {
    const before = collected.size;
    await scrollPaneToBottom();
    await sleep(jitter(900, 1400));
    await snapshotPaneUrls();
    if (collected.size === before) break;
  }

  // Diagnostic: if we got 0, dump whatever IS in the pane to help debug.
  if (collected.size === 0) {
    try {
      const diag = await page.evaluate(() => {
        const root = document.querySelector(".page__profile");
        if (!root) return { found: false, candidates: [...document.querySelectorAll("[class*='profile']")].slice(0, 5).map(e => e.className).join(" | ") };
        const imgs = [...root.querySelectorAll("img")].slice(0, 6).map(i => ({ src: (i.src || "").slice(0, 100), cls: (i.className || "").slice(0, 80) }));
        return { found: true, htmlSize: root.innerHTML.length, imgCount: root.querySelectorAll("img").length, sampleImgs: imgs };
      });
      console.error(`captureProfilePhotoUrls diag for ${matchId.slice(0, 12)}: ${JSON.stringify(diag)}`);
    } catch {}
  }

  return [...collected];
}

// Bumble's signed photo URLs include `&size=__size__` and `&ck=<hash>` query
// params used for dedup; we keep the original URL for download but build a
// normalized key so the same photo at multiple resolutions doesn't double-count.
function normalizePhotoKey(url) {
  return url.split("&size=")[0].split("&ck=")[0];
}

async function downloadPhotos(ctx, urls, slug) {
  const slugDir = resolve(PHOTOS_DIR, slug);
  await mkdir(slugDir, { recursive: true });
  const paths = [];
  const seenKeys = new Set();
  for (let i = 0; i < urls.length; i++) {
    const key = normalizePhotoKey(urls[i]);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const path = resolve(slugDir, `${i}.jpg`);
    try {
      const resp = await ctx.request.get(urls[i]);
      const buf = await resp.body();
      if (buf.length < 5000) continue; // nav-thumb / placeholder
      await writeFile(path, buf);
      paths.push(path);
    } catch (e) {
      console.error(`download failed ${urls[i].slice(0, 80)}: ${e.message}`);
    }
  }
  return paths;
}

function buildVisualSection(visualOutput, engine, account, ts) {
  return [
    `<!-- engine=${engine} account=${account || "(n/a)"} ts=${ts} -->`,
    "",
    visualOutput.trim(),
  ].join("\n");
}

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

  // QUANTUM_BUMBLE_VISUALIZE_FORCE = comma-separated slugs to re-run.
  const forceSlugs = new Set((process.env.QUANTUM_BUMBLE_VISUALIZE_FORCE || "")
    .split(",").map(s => s.trim()).filter(Boolean));
  const onlySlug = process.env.QUANTUM_BUMBLE_VISUALIZE_SLUG || null;

  const allEntities = await listAllEntities();
  const candidates = [];
  for (const ent of allEntities) {
    if (ent.meta.status === "unmatched" || ent.meta.status === "expired") continue;
    if (onlySlug && ent.slug !== onlySlug) continue;
    if (forceSlugs.size > 0 && !forceSlugs.has(ent.slug)) continue;
    candidates.push(ent);
  }

  const testLimit = parseInt(process.env.QUANTUM_BUMBLE_VISUALIZE_LIMIT || "0", 10);
  const todo = testLimit > 0 ? candidates.slice(0, testLimit) : candidates;
  console.log(`visualize: ${candidates.length} ${forceSlugs.size > 0 ? "forced" : "candidates"}; processing ${todo.length}`);

  const { ctx, page } = await launchPersistent({ headless: false });
  let done = 0, failed = 0, skipped_no_photos = 0;
  try {
    for (const ent of todo) {
      try {
        const skipVisualLlm = !forceSlugs.has(ent.slug) && await entityHasVisual(ent.slug);
        const urls = await captureProfilePhotoUrls(page, ent.meta.match_id);

        // Re-scrape full profile while we're in the pane (uniform field coverage).
        let profileRescrapeStatus = "skipped";
        try {
          const profile = await readThreadProfile(page);
          const meaningful = profile && (profile.name || profile.age || profile.bio
            || profile.work || profile.school
            || (Array.isArray(profile.lifestyle_badges) && profile.lifestyle_badges.length)
            || (Array.isArray(profile.prompts) && profile.prompts.length));
          if (meaningful) {
            await upsertMatch({
              matchId: ent.meta.match_id,
              personId: ent.meta.person_id || null,
              name: profile.name || ent.meta.first_name,
              source: "bumble",
              profile,
            });
            profileRescrapeStatus = "rescraped";
          }
        } catch (e) {
          console.error(`${ent.slug}: profile re-scrape failed (continuing): ${e.message}`);
        }

        if (skipVisualLlm) {
          console.log(`${ent.slug}: visual=already-done, profile=${profileRescrapeStatus}`);
          await sleep(jitter(2000, 4000));
          continue;
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

#!/usr/bin/env node
// upload.mjs — fill DistroKid /new/ for one track and submit.
// Usage: node scripts/upload.mjs --wav /path/to/x.wav --title "Title" --cover /path/to/cover.jpg

import { chromium } from "patchright";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- args ----
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, a) => {
    if (v.startsWith("--")) acc.push([v.slice(2), a[i + 1]]);
    return acc;
  }, [])
);
const WAV = args.wav;
const TITLE = args.title;
const COVER = args.cover;
const SUBMIT = args.submit !== "false"; // default true (full auto per Adithya)
const DEBUG = !!args.debug;

if (!WAV || !TITLE || !COVER) {
  console.error("usage: --wav <path> --title <str> --cover <path> [--submit false] [--debug]");
  process.exit(2);
}
for (const [k, v] of [["wav", WAV], ["cover", COVER]]) {
  if (!existsSync(v)) { console.error(`${k} not found: ${v}`); process.exit(2); }
}

const PROFILE_DIR = join(homedir(), ".quantum/chrome-profiles/distrokid");
const RUN_DIR = join(homedir(), ".quantum/distrokid/runs", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(RUN_DIR, { recursive: true });
console.log(`[run] ${RUN_DIR}`);
console.log(`[wav] ${WAV} (${(statSync(WAV).size / 1e6).toFixed(1)}MB)`);
console.log(`[cover] ${COVER} (${(statSync(COVER).size / 1e6).toFixed(1)}MB)`);
console.log(`[title] ${TITLE}`);
console.log(`[submit] ${SUBMIT}`);

// ---- launch ----
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  channel: "chrome",
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  timezoneId: "America/Chicago",
  args: ["--disable-blink-features=AutomationControlled", "--window-size=1440,900"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

async function snap(name) {
  const p = join(RUN_DIR, `${Date.now()}-${name}.png`);
  try { await page.screenshot({ path: p, fullPage: false }); console.log(`[snap] ${name}`); } catch {}
}

async function step(name, fn) {
  console.log(`[step] ${name}`);
  try {
    await fn();
  } catch (e) {
    console.error(`[FAIL] ${name}: ${e.message}`);
    await snap(`fail-${name.replace(/[^a-z0-9]+/gi, "-")}`);
    throw e;
  }
}

try {
  await step("nav", async () => {
    await page.goto("https://distrokid.com/new/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.bringToFront();
    await page.waitForTimeout(4000);
  });

  await step("dismiss-cookies", async () => {
    const btn = page.locator(".osano-cm-deny, .osano-cm-accept").first();
    if (await btn.count()) await btn.click({ timeout: 2000 }).catch(() => {});
  });

  await step("dismiss-upgrade", async () => {
    const btn = page.locator(".upgrade-ultimate-dismissal");
    if (await btn.count()) await btn.first().click({ timeout: 2000 }).catch(() => {});
  });

  await step("snapchat-opt-in", async () => {
    const cb = page.locator("#chksnap");
    if (!(await cb.isChecked())) {
      await cb.click({ force: true });
      await page.waitForTimeout(1000);
      // Modal: "Do you own 100% of the publishing rights"
      const yes = page.locator("button, a, input[type=button], input[type=submit]")
        .filter({ hasText: /yes,?\s*i\s*own\s*100%/i }).first();
      if (await yes.count()) {
        await yes.click({ force: true });
        await page.waitForTimeout(800);
      }
    }
  });

  await step("roblox-opt-in", async () => {
    const cb = page.locator("#chkroblox");
    if (!(await cb.isChecked())) {
      await cb.click({ force: true });
      await page.waitForTimeout(1200);
      // Modal: 4 eligibility checkboxes inside a dialog. Check all unchecked checkboxes that are visible.
      const dialogScope = page.locator(".modal:visible, [role=dialog]:visible, .ui-dialog:visible").first();
      const scope = (await dialogScope.count()) ? dialogScope : page;
      const checks = scope.locator("input[type=checkbox]");
      const n = await checks.count();
      for (let i = 0; i < n; i++) {
        const c = checks.nth(i);
        if (await c.isVisible() && !(await c.isChecked())) {
          await c.click({ force: true }).catch(() => {});
        }
      }
      // continue
      const cont = scope.locator("button, a, input[type=button], input[type=submit]")
        .filter({ hasText: /^continue$/i }).first();
      if (await cont.count()) {
        await cont.click({ force: true });
        await page.waitForTimeout(800);
      }
    }
  });

  await step("previously-released-no", async () => {
    // already default-checked but ensure
    const r = page.locator('input[type=radio][name^="previouslyReleased_"][value="0"]').first();
    if (await r.count() && !(await r.isChecked())) await r.click({ force: true });
  });

  await step("artist-shak-stzy", async () => {
    await page.selectOption("#artistName", { label: "Shak STZY" }).catch(() => {});
  });

  await step("facebook-yes-group", async () => {
    const r = page.locator("#facebookProfileArtistID1Yes");
    if (await r.count() && !(await r.isChecked())) {
      await r.click({ force: true });
    }
  });

  await step("release-date-today", async () => {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const yyyy = today.getFullYear();
    const iso = `${yyyy}-${mm}-${dd}`;
    await page.locator("#release-date-dp").fill(iso);
    await page.locator("#release-date-dp").press("Tab");
  });

  await step("record-label-outerscope", async () => {
    const inp = page.locator("#recordLabel");
    const cur = (await inp.inputValue()).trim();
    if (cur !== "Outerscope Records") {
      await inp.fill("Outerscope Records");
    }
  });

  await step("language-english", async () => {
    await page.selectOption("#language", { label: "English" }).catch(() => {});
  });

  await step("primary-genre-hiphop", async () => {
    await page.selectOption("#genrePrimary", { label: "Hip Hop/Rap" });
  });

  await step("secondary-genre-pop", async () => {
    await page.selectOption("#genreSecondary", { label: "Pop" }).catch(async () => {
      // some forms use plain Pop or "Pop (Inter)"
      await page.selectOption("#genreSecondary", { label: "Pop" });
    });
  });

  await step("upload-cover", async () => {
    await page.setInputFiles("#artwork", COVER);
    // wait for upload + cropper to settle
    await page.waitForTimeout(4000);
    // if a cropper "Save" or "Done" button surfaces, click it
    const saveBtn = page.locator("button, a, input[type=button], input[type=submit]")
      .filter({ hasText: /^(save|done|crop|use this image|confirm)$/i }).first();
    if (await saveBtn.count() && await saveBtn.isVisible()) {
      await saveBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  });

  await step("track-title", async () => {
    const inp = page.locator(".uploadFileTitle.track_1, input[id^='title_']").first();
    await inp.fill(TITLE);
  });

  await step("upload-wav", async () => {
    await page.setInputFiles("#js-track-upload-1", WAV);
    // S3 upload starts; wait for it to register but don't block on full transfer
    await page.waitForTimeout(3000);
  });

  await step("songwriter-name", async () => {
    await page.locator('input[name="songwriter_real_name_first1"]').fill("Adithya");
    await page.locator('input[name="songwriter_real_name_middle1"]').fill("Shakthi");
    await page.locator('input[name="songwriter_real_name_last1"]').fill("Kumar");
  });

  await step("songwriter-role-music-and-lyrics", async () => {
    const sel = page.locator(".songwriter_real_name_role").first();
    if (await sel.count()) {
      await sel.selectOption({ label: "Music and lyrics" }).catch(() => {});
    }
  });

  await step("explicit-yes", async () => {
    await page.locator("#js-explicit-radio-button-1").click({ force: true });
  });

  await step("apple-credits", async () => {
    // Click any "Add credits" / expand toggle if present
    const expand = page.locator("a, button, span")
      .filter({ hasText: /add credits for each song/i }).first();
    if (await expand.count()) await expand.click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);

    // Performer name
    const perf = page.locator('input[name*="performer"][type="text"], input[placeholder*="erformer"], input.performer-name').first();
    if (await perf.count()) {
      await perf.fill("Shak STZY").catch(() => {});
    }
    // Producer name
    const prod = page.locator('input[name*="producer"][type="text"], input[placeholder*="roducer"], input.producer-name').first();
    if (await prod.count()) {
      await prod.fill("Shak STZY").catch(() => {});
    }
  });

  await step("mandatory-checkboxes", async () => {
    // .areyousure checkboxes are jQuery-styled: real <input> is CSS-hidden, label wraps it.
    // Skip the actionability check entirely and flip them in JS, dispatching change.
    const flipped = await page.evaluate(() => {
      const out = [];
      const all = document.querySelectorAll("input.areyousure[type=checkbox], input[type=checkbox][id^='areyousure']");
      all.forEach((el) => {
        if (!el.checked) {
          el.checked = true;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("click", { bubbles: true }));
        }
        out.push({ id: el.id, checked: el.checked });
      });
      return out;
    });
    console.log(`  flipped ${flipped.length} mandatory boxes:`, flipped.map((b) => b.id).join(", "));
  });

  await snap("pre-submit");

  if (SUBMIT) {
    await step("click-continue", async () => {
      const btn = page.locator("#doneButton");
      // wait for WAV upload to complete first — DistroKid disables submit until done
      await page.waitForTimeout(8000);
      // scroll into view + click
      await btn.scrollIntoViewIfNeeded();
      await btn.click({ force: true });
    });

    await step("post-submit-wait", async () => {
      // Either nav happens, or a validation toast appears. Wait up to 30s.
      await Promise.race([
        page.waitForURL(/distrokid\.com\/(?!new)/, { timeout: 30000 }).catch(() => null),
        page.waitForTimeout(15000),
      ]);
      await snap("post-submit");
      console.log(`[url] ${page.url()}`);
    });
  } else {
    console.log("[skip-submit] form filled, leaving open for review (--submit false)");
    await page.waitForTimeout(60000);
  }

  // Save run metadata
  const meta = {
    title: TITLE, wav: WAV, cover: COVER, submit: SUBMIT,
    runDir: RUN_DIR, finalUrl: page.url(), at: new Date().toISOString(),
  };
  await writeFile(join(RUN_DIR, "metadata.json"), JSON.stringify(meta, null, 2));
  console.log("[done]");
} catch (e) {
  console.error(`[fatal] ${e.stack || e.message}`);
  await snap("fatal");
  process.exitCode = 1;
} finally {
  if (DEBUG) {
    console.log("[debug] holding open 60s for inspection");
    await page.waitForTimeout(60000);
  }
  await ctx.close();
}

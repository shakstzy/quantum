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

async function snap(name, { fullPage = true } = {}) {
  const p = join(RUN_DIR, `${Date.now()}-${name}.png`);
  try { await page.screenshot({ path: p, fullPage }); console.log(`[snap] ${name}`); } catch {}
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

  // Facebook profile: leave default ("No - Shak STZY doesn't yet have a profile").
  // Choosing "Yes - group" requires a real FB artist URL we don't have, and
  // DistroKid rejects submission with "Please enter a valid Facebook Profile URL".

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
    // Find the "Add credits..." expander by walking the DOM; click + scroll.
    const expanded = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("a, button, div, span, p"));
      const hit = all.find((el) => {
        const t = (el.textContent || "").trim();
        return /add credits for each song on this release/i.test(t)
          && t.length < 200
          && el.getBoundingClientRect().width > 0;
      });
      if (!hit) return { found: false };
      hit.scrollIntoView({ block: "center" });
      hit.click();
      // Bubble up — sometimes the handler is on a parent.
      let p = hit.parentElement;
      for (let i = 0; i < 3 && p; i++) { try { p.click(); } catch {} p = p.parentElement; }
      return { found: true, tag: hit.tagName, text: hit.textContent.trim().slice(0, 80) };
    });
    console.log(`  expand:`, expanded);
    await page.waitForTimeout(1500);

    // Fill performer + producer inputs that should now be visible.
    const fills = await page.evaluate(() => {
      const out = { performer: false, producer: false, candidates: [] };
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      const visible = inputs.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      for (const el of visible) {
        const ctx = `${el.placeholder || ""} ${el.name || ""} ${el.id || ""} ${el.className || ""}`.toLowerCase();
        out.candidates.push({ ph: el.placeholder, name: el.name, id: el.id, cls: (el.className||"").slice(0,40) });
        if (!out.performer && /performer/.test(ctx) && !el.value) {
          el.value = "Shak STZY";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          out.performer = true;
        }
        if (!out.producer && /producer/.test(ctx) && !el.value) {
          el.value = "Shak STZY";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          out.producer = true;
        }
      }
      return out;
    });
    console.log(`  performer-filled=${fills.performer}, producer-filled=${fills.producer}`);

    // Role dropdowns are required ("Performer role required", "Producer role required").
    // Identify each select by its option list: performer has "Singing & vocals",
    // producer has a literal "Producer" option.
    const roles = await page.evaluate(() => {
      const out = { performer: null, producer: null };
      const selects = Array.from(document.querySelectorAll("select")).filter((s) => {
        const r = s.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      for (const s of selects) {
        const opts = Array.from(s.options).map((o) => (o.text || o.textContent || "").trim());
        const sIdx = opts.findIndex((t) => /^singing\s*&?\s*vocals/i.test(t));
        const pIdx = opts.findIndex((t) => /^producer$/i.test(t));
        if (sIdx >= 0 && out.performer === null) {
          s.selectedIndex = sIdx;
          s.dispatchEvent(new Event("change", { bubbles: true }));
          out.performer = opts[sIdx];
        } else if (pIdx >= 0 && out.producer === null && (out.performer || sIdx < 0)) {
          // skip the songwriter "Music and lyrics" select (also has Producer? no — only the credits one)
          // Producer select is one whose options start with "Select a role" then producer roles
          if (opts[0] && /select a role/i.test(opts[0])) {
            s.selectedIndex = pIdx;
            s.dispatchEvent(new Event("change", { bubbles: true }));
            out.producer = opts[pIdx];
          }
        }
      }
      return out;
    });
    console.log(`  performer-role=${roles.performer}, producer-role=${roles.producer}`);
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
      // Wait for WAV upload + cropper to settle. DistroKid hides #doneButton
      // and enables a different #saveAndContinue button only after S3 ack.
      await page.waitForTimeout(15000);
      await snap("just-before-click");
      // Try multiple submit-button candidates in priority order.
      const candidates = [
        "#saveAndContinue:visible",
        "#doneButton:visible",
        'button:visible:has-text("Save and continue")',
        'button:visible:has-text("Looks good")',
        'input[type=submit]:visible',
      ];
      let clicked = false;
      for (const sel of candidates) {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
          const txt = await loc.evaluate((el) => (el.value || el.textContent || "").trim().slice(0, 60)).catch(() => "?");
          console.log(`  trying: ${sel} text="${txt}"`);
          await loc.scrollIntoViewIfNeeded();
          await page.waitForTimeout(500);
          await loc.click({ force: true });
          clicked = true;
          console.log(`  clicked: ${sel}`);
          break;
        }
      }
      if (!clicked) console.log("  WARN: no submit button matched");
    });

    await step("post-click-diag", async () => {
      await page.waitForTimeout(3000);
      const diag = await page.evaluate(() => {
        const errs = [];
        document.querySelectorAll(".error, .invalid, [class*='error' i]:not(.areyousure):not(div):not(form)").forEach((el) => {
          const r = el.getBoundingClientRect();
          const t = (el.textContent || "").trim();
          if (r.width > 0 && r.height > 0 && t && t.length < 200) errs.push(t);
        });
        const dialogs = [];
        document.querySelectorAll('[role=dialog], .modal, .ui-dialog, [class*="modal" i][style*="display: block"]').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const t = (el.textContent || "").trim().slice(0, 200);
            const btns = Array.from(el.querySelectorAll('button, input[type=submit], input[type=button], a.button')).map(b => (b.value || b.textContent || "").trim()).filter(Boolean);
            dialogs.push({ text: t, buttons: btns });
          }
        });
        return { errs, dialogs, url: location.href };
      });
      console.log("[diag] url:", diag.url);
      console.log("[diag] errors:", diag.errs.length);
      diag.errs.forEach((e) => console.log("  ERR:", e));
      console.log("[diag] dialogs:", diag.dialogs.length);
      diag.dialogs.forEach((d, i) => {
        console.log(`  DLG${i}.text:`, d.text);
        console.log(`  DLG${i}.btns:`, d.buttons.join(" | "));
      });
    });

    await step("post-submit-wait", async () => {
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

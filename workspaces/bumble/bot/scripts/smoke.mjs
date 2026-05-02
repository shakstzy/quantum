#!/usr/bin/env node
// Read-only live smoke test. Verifies every selector the bot needs WITHOUT
// performing any irreversible action (no swipe, no send, no extend).
//
// Reports:
//   - encounters-user text (active rec card)
//   - conversation list count + first 5 names + expiry status
//   - selected thread: header name + last 3 messages with directions
//   - presence of all halt selectors (must NOT fire when site is healthy)

import { launchPersistent } from "../src/runtime/profile.mjs";
import { sleep } from "../src/runtime/humanize.mjs";
import { selectors, scanForHalts } from "../src/runtime/detection.mjs";

const sels = await selectors();

const { ctx, page } = await launchPersistent({ headless: false });
const out = { passed: [], failed: [], data: {} };

function ok(name, value) { out.passed.push({ name, value }); console.log(`OK   ${name.padEnd(28)} ${typeof value === "string" ? value.slice(0, 80) : JSON.stringify(value).slice(0, 80)}`); }
function fail(name, reason) { out.failed.push({ name, reason }); console.error(`FAIL ${name.padEnd(28)} ${reason}`); }

try {
  await page.goto("https://bumble.com/app", { waitUntil: "domcontentloaded", timeout: 25000 });
  await sleep(5000);

  // Halt scan (must NOT throw if site is healthy)
  try {
    await scanForHalts(page);
    ok("scanForHalts (no halts)", "clean");
  } catch (e) {
    fail("scanForHalts", e.message);
  }

  // === Encounters card ===
  try {
    const cardText = await page.$eval(sels.rec_card.selector, el => (el.textContent || "").trim());
    if (cardText) {
      const m = cardText.match(/^([\p{L}\p{N}\s'-]+),\s*(\d+)/u);
      out.data.rec_card = { rawText: cardText.slice(0, 200), name: m?.[1]?.trim(), age: m ? parseInt(m[2]) : null };
      if (m) ok("rec_card_name+age", `${m[1].trim()}, ${m[2]}`);
      else ok("rec_card (raw text only)", cardText.slice(0, 80));
    } else {
      fail("rec_card", "selector resolved but textContent empty");
    }
  } catch (e) { fail("rec_card", e.message); }

  // === Like / Pass / SuperSwipe button presence (do NOT click) ===
  for (const k of ["like_button", "pass_button", "super_like_button"]) {
    try {
      const found = await page.$(sels[k].selector);
      if (found) ok(k, "present");
      else fail(k, "not present");
    } catch (e) { fail(k, e.message); }
  }

  // === Conversations sidebar ===
  try {
    const contacts = await page.$$eval(sels.matches_list_item.selector, els => els.map(e => {
      const name = e.querySelector(".contact__user-name, [class*='name']")?.textContent?.trim()
                || e.textContent?.trim()?.split("\n")[0]?.slice(0, 40);
      const expiry = e.querySelector(".contact__expiration-status-text")?.textContent?.trim() || null;
      const yourMove = !!e.querySelector("[class*='your-move'], [class*='move-prompt']") || (e.textContent || "").includes("Your move");
      return { name, expiry, yourMove };
    }));
    out.data.contacts = contacts;
    ok("matches_list_item count", contacts.length);
    for (const c of contacts.slice(0, 5)) {
      console.log(`     - ${c.name} | expiry=${c.expiry || "—"} | yourMove=${c.yourMove}`);
    }
  } catch (e) { fail("matches_list_item", e.message); }

  // === Open one thread (click the FIRST contact in sidebar, then read) ===
  try {
    const clicked = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.click();
      return true;
    }, sels.matches_list_item.selector);
    if (!clicked) throw new Error("no contact to click");
    await sleep(3500);

    // Header name
    const headerName = await page.$eval(sels.thread_header_name?.selector || ".messages-header__name", el => (el.textContent || "").trim()).catch(() => null);
    if (headerName) ok("thread_header_name", headerName);
    else fail("thread_header_name", "not found in opened thread");

    // Messages
    const messages = await page.$$eval(sels.thread_messages.selector, els => els.slice(-5).map(e => {
      const cls = e.getAttribute("class") || "";
      const direction = /\bmessage--out\b|\bmessage--from-me\b/.test(cls) ? "out"
                    : /\bmessage--in\b/.test(cls) ? "in" : "?";
      const text = (e.querySelector(".message__content")?.textContent || e.textContent || "").trim().slice(0, 120);
      return { direction, text, cls: cls.slice(0, 80) };
    }));
    out.data.messages = messages;
    ok("thread_messages count (last 5)", messages.length);
    for (const m of messages) {
      console.log(`     [${m.direction}] ${m.text}`);
    }

    // Input + Send button
    const inputPresent = !!(await page.$(sels.thread_input.selector));
    if (inputPresent) ok("thread_input", "present");
    else fail("thread_input", "not present");

    const sendPresent = !!(await page.$(sels.thread_send.selector));
    if (sendPresent) ok("thread_send", "present");
    else fail("thread_send", "not present");

    // Profile pane (right side)
    const paneText = await page.$eval(sels.thread_profile_pane.selector, el => (el.textContent || "").trim().slice(0, 200)).catch(() => null);
    if (paneText) ok("thread_profile_pane head", paneText.replace(/\s+/g, " ").slice(0, 80));
    else fail("thread_profile_pane", "not found");
  } catch (e) {
    fail("thread surface", e.message);
  }

} finally {
  await ctx.close();
}

console.log(`\n=== SMOKE SUMMARY: ${out.passed.length} OK / ${out.failed.length} FAIL ===`);
process.exit(out.failed.length > 0 ? 1 : 0);

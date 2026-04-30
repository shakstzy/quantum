// LinkedInExtractor: navigate-to-URL + extract-innerText pattern.
// Ported (simplified) from stickerdaniel/linkedin-mcp-server scraping/extractor.py.
//
// Design rules (per their AGENTS.md):
// - One section = one navigation. No combining endpoints.
// - Minimize DOM dependence. innerText > class-name selectors.
// - When DOM access is unavoidable, use generic href / aria-label / role selectors only.
// - Tools return {url, sections: { name: raw_text }}. The LLM parses on the receiving end.

import { detectRateLimit, handleModalClose, scrollMainScrollable, waitForMainText } from "./page-actions.mjs";
import { detectConnectionState, readActionSignals } from "./connection-state.mjs";
import { sleep, jitter, humanType } from "../runtime/humanize.mjs";
import { ProfileInaccessibleError, BanSignalError } from "../runtime/exceptions.mjs";

const DIALOG_SELECTOR = 'dialog[open], [role="dialog"]';
const DIALOG_TEXTAREA_SELECTOR = '[role="dialog"] textarea, dialog textarea';
const COMPOSE_LINK_SELECTOR = 'main a[href*="/messaging/compose/"]';
const COMPOSE_BOX_SELECTORS = [
  'div[role="textbox"][contenteditable="true"][aria-label*="Write a message"]',
  'main div[role="textbox"][contenteditable="true"]',
  'main [contenteditable="true"][aria-label*="message"]',
];
const SEND_BUTTON_SELECTOR = [
  'button[type="submit"]:not([disabled])',
  'button[aria-label*="Send"]:not([disabled])',
  'button[aria-label*="send"]:not([disabled])',
].join(", ");

export class LinkedInExtractor {
  constructor(page) {
    this.page = page;
  }

  // ── Reads ────────────────────────────────────────────────────────────

  async navigateTo(url) {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await detectRateLimit(this.page);
    await waitForMainText(this.page);
    await handleModalClose(this.page);
    await sleep(jitter(500, 1300));
  }

  async getMainText() {
    return await this.page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? (main.innerText || "") : (document.body?.innerText || "");
    });
  }

  // Person profile: navigate to /in/<username>/, return innerText sections.
  async getPersonProfile(username) {
    const url = `https://www.linkedin.com/in/${encodeURIComponent(username)}/`;
    await this.navigateTo(url);
    const text = await this.getMainText();
    if (!text) {
      throw new ProfileInaccessibleError(`Empty profile page for ${username}`, { publicId: username });
    }
    const profileUrn = await this._extractProfileUrn();
    const displayName = await this._readProfileDisplayName();
    return {
      url,
      username,
      profileUrn,
      displayName,
      sections: { main_profile: text },
    };
  }

  // Inbox: navigate to /messaging/, scroll, return raw inbox text + thread refs.
  async getInbox({ limit = 20 } = {}) {
    const url = "https://www.linkedin.com/messaging/";
    await this.navigateTo(url);
    const scrolls = Math.max(1, Math.floor(limit / 10));
    await scrollMainScrollable(this.page, { attempts: scrolls, pauseMs: 500 });
    const text = await this.getMainText();
    const threads = await this._extractInboxThreadRefs(limit);
    return { url, sections: { inbox: text }, threads };
  }

  async _extractInboxThreadRefs(limit) {
    // Prefer structural href anchors (a[href*="/messaging/thread/"]). Fall back
    // to clicking the listitem (LinkedIn's sidebar uses JS click handlers in
    // some variants) and reading location.href change.
    return await this.page.evaluate(async ({ limit }) => {
      const out = [];
      const anchors = Array.from(document.querySelectorAll('main a[href*="/messaging/thread/"]'));
      for (const a of anchors.slice(0, limit)) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/messaging\/thread\/([^/?#]+)/);
        if (!m) continue;
        const li = a.closest("li");
        const labelEl = li?.querySelector('label[aria-label^="Select conversation"]');
        const ariaName = (labelEl?.getAttribute("aria-label") || "").replace(/^Select conversation with\s*/i, "").trim();
        const fallbackName = (a.innerText || a.textContent || "").trim().split("\n")[0] || null;
        out.push({ name: ariaName || fallbackName, threadId: m[1], url: `/messaging/thread/${m[1]}/` });
      }
      if (out.length > 0) return out;
      // Fallback: legacy listitem-click strategy.
      const labels = Array.from(document.querySelectorAll('main label[aria-label^="Select conversation"]'));
      for (let i = 0; i < Math.min(labels.length, limit); i++) {
        const label = labels[i];
        const aria = label.getAttribute("aria-label") || "";
        const name = aria.replace(/^Select conversation with\s*/i, "").trim();
        const li = label.closest("li");
        // Try multiple click targets in order of preference.
        const click = li?.querySelector('a[href*="/messaging/thread/"]')
          || li?.querySelector('div[class*="listitem__link"]')
          || li;
        if (!click) continue;
        click.click();
        await new Promise((r) => setTimeout(r, 300));
        const m = location.href.match(/\/messaging\/thread\/([^/?#]+)/);
        if (m) out.push({ name, threadId: m[1], url: `/messaging/thread/${m[1]}/` });
      }
      return out;
    }, { limit });
  }

  // Conversation: navigate to /messaging/thread/<id>/.
  async getConversation({ threadId, username } = {}) {
    if (!threadId && !username) throw new Error("getConversation: need threadId or username");
    if (threadId) {
      await this.navigateTo(`https://www.linkedin.com/messaging/thread/${encodeURIComponent(threadId)}/`);
    } else {
      await this.navigateTo("https://www.linkedin.com/messaging/");
      const opened = await this._searchInboxAndOpen(username);
      if (!opened) {
        throw new Error(`getConversation: thread not found for username=${username}`);
      }
    }
    if (!/\/messaging\/thread\//.test(this.page.url())) {
      throw new Error(`getConversation: did not land on /messaging/thread/, got ${this.page.url()}`);
    }
    await scrollMainScrollable(this.page, { attempts: 3, pauseMs: 500, position: "top" });
    const text = await this.getMainText();
    return { url: this.page.url(), sections: { conversation: text } };
  }

  async _searchInboxAndOpen(username) {
    try {
      const search = this.page.getByRole("searchbox").first();
      await search.click({ timeout: 5000 });
      await this.page.keyboard.type(username, { delay: 30 });
      await sleep(800);
      await this.page.keyboard.press("Enter");
      await sleep(1500);
      // Click the first conversation thread anchor that matches.
      const opened = await this.page.evaluate((u) => {
        const a = Array.from(document.querySelectorAll('main a[href*="/messaging/thread/"]'))
          .find((el) => (el.innerText || "").toLowerCase().includes(u.toLowerCase())) || document.querySelector('main a[href*="/messaging/thread/"]');
        if (!a) return false;
        a.click();
        return true;
      }, username).catch(() => false);
      if (!opened) return false;
      await sleep(1500);
    } catch { return false; }
    // Verify we landed on a thread URL.
    if (!/\/messaging\/thread\//.test(this.page.url())) return false;
    return true;
  }

  // People search.
  async searchPeople({ query, location = null } = {}) {
    if (!query) throw new Error("searchPeople: query required");
    const params = new URLSearchParams({ keywords: query, origin: "GLOBAL_SEARCH_HEADER" });
    if (location) params.set("location", location);
    const url = `https://www.linkedin.com/search/results/people/?${params.toString()}`;
    await this.navigateTo(url);
    await scrollMainScrollable(this.page, { attempts: 2, pauseMs: 600 });
    const text = await this.getMainText();
    const profiles = await this._extractProfileLinks();
    return { url, sections: { search_results: text }, profiles };
  }

  async _extractProfileLinks() {
    return await this.page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const anchors = document.querySelectorAll('main a[href*="/in/"]');
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/in\/([^/?#]+)/);
        if (!m) continue;
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        out.push({ username: m[1], href });
      }
      return out;
    });
  }

  // List invites: navigate to invitation manager, extract innerText.
  async listInvites({ direction = "received" } = {}) {
    const path = direction === "sent"
      ? "/mynetwork/invitation-manager/sent/"
      : "/mynetwork/invitation-manager/";
    const url = `https://www.linkedin.com${path}`;
    await this.navigateTo(url);
    await scrollMainScrollable(this.page, { attempts: 3, pauseMs: 500 });
    const text = await this.getMainText();
    return { url, sections: { invites: text } };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  async _extractProfileUrn() {
    // The profile compose anchor's `recipient` query param is the profile URN.
    const href = await this.page.evaluate(() => {
      const a = document.querySelector('main a[href*="/messaging/compose/"]');
      return a ? (a.getAttribute("href") || a.href || null) : null;
    }).catch(() => null);
    if (!href || typeof href !== "string") return null;
    try {
      const u = new URL(href, "https://www.linkedin.com");
      return u.searchParams.get("recipient");
    } catch { return null; }
  }

  async _readProfileDisplayName() {
    const name = await this.page.evaluate(() => {
      const norm = (v) => (v || "").replace(/\s+/g, " ").trim();
      const h = document.querySelector("main h1");
      if (h) {
        const t = norm(h.innerText || h.textContent || "");
        if (t) return t;
      }
      const main = document.querySelector("main");
      if (!main) return "";
      const lines = (main.innerText || "").split("\n").map(norm).filter(Boolean);
      return lines[0] || "";
    }).catch(() => "");
    return (name && typeof name === "string") ? name.trim() || null : null;
  }

  // ── Writes ───────────────────────────────────────────────────────────

  // Connect via deeplink: /preload/custom-invite/?vanityName=<x>. No DOM Connect-button click.
  // Falls back to "Accept" inline button when state is incoming_request.
  async connectWithPerson(username, { note = null, dryRun = true } = {}) {
    const url = `https://www.linkedin.com/in/${encodeURIComponent(username)}/`;
    const profile = await this.getPersonProfile(username);
    const text = profile.sections.main_profile;
    const signals = await readActionSignals(this.page);
    const state = detectConnectionState(text, signals);

    if (state === "self_profile" || state === "already_connected" || state === "pending") {
      return { url, status: state, ok: false, reason: `state=${state}` };
    }
    // Per MCP reference: deeplink only valid for connectable / follow_only.
    // unavailable means the action area didn't expose any actionable signal.
    if (state !== "connectable" && state !== "follow_only" && state !== "incoming_request") {
      return { url, status: "connect_unavailable", ok: false, reason: `state=${state}` };
    }
    if (dryRun) {
      return { url, status: `would_${state === "incoming_request" ? "accept" : "connect"}`, ok: true, dryRun: true, state };
    }

    if (state === "incoming_request") {
      // Inline Accept button on profile (no modal). Locale-dependent fallback.
      const clicked = await this._clickButtonByText("Accept", "main");
      if (!clicked) return { url, status: "send_failed", ok: false, reason: "accept_not_found" };
      await sleep(jitter(800, 1500));
      const verified = await this.getPersonProfile(username);
      const verifiedSignals = await readActionSignals(this.page);
      const verifiedState = detectConnectionState(verified.sections.main_profile, verifiedSignals);
      if (verifiedState !== "already_connected") {
        return { url, status: "send_failed", ok: false, reason: `verify_state=${verifiedState}` };
      }
      return { url, status: "accepted", ok: true };
    }

    // Connectable: navigate to the deeplink to open the invite dialog directly.
    const inviteUrl = `https://www.linkedin.com/preload/custom-invite/?vanityName=${encodeURIComponent(username)}`;
    await this.page.goto(inviteUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await detectRateLimit(this.page);
    const submitted = await this._submitInviteDialog(note);
    if (!submitted.ok) return { url, status: "send_failed", ok: false, reason: submitted.reason };
    // Verify with a real navigateTo (waits for main, dismisses modals) before re-reading signals.
    await this.navigateTo(url);
    const verifiedSignals = await readActionSignals(this.page);
    const stillConnectable = verifiedSignals.hasInvite;
    return {
      url,
      status: stillConnectable ? "send_failed" : "sent",
      ok: !stillConnectable,
      noteSent: submitted.noteSent,
    };
  }

  async _clickButtonByText(text, scope = "main") {
    const root = scope === "main" ? this.page.locator("main") : this.page;
    try {
      const btn = root.getByRole("button", { name: text, exact: false }).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click({ timeout: 3000 });
        return true;
      }
    } catch { /* fall through */ }
    return false;
  }

  async _dialogIsOpen({ timeoutMs = 4000 } = {}) {
    try {
      await this.page.waitForSelector(DIALOG_SELECTOR, { state: "visible", timeout: timeoutMs });
      return true;
    } catch { return false; }
  }

  async _dismissDialog() {
    try {
      // Press Escape — works for most dialogs.
      await this.page.keyboard.press("Escape").catch(() => {});
      await sleep(200);
    } catch { /* ignore */ }
  }

  // Submit the invite dialog opened by the deeplink. Positional button indexing,
  // no localized text matching. (Mirror of MCP _submit_invite_dialog.)
  async _submitInviteDialog(note) {
    if (!(await this._dialogIsOpen({ timeoutMs: 5000 }))) {
      return { ok: false, reason: "dialog_not_open" };
    }
    let noteSent = false;
    if (note) {
      const textareaCount = await this.page.locator(DIALOG_TEXTAREA_SELECTOR).count();
      if (textareaCount === 0) {
        // Reveal note via the secondary action. Layouts have 3 buttons (dismiss, secondary, primary).
        const buttons = this.page.locator(`${DIALOG_SELECTOR} button, ${DIALOG_SELECTOR} [role='button']`);
        const count = await buttons.count();
        if (count >= 3) {
          await buttons.nth(count - 2).click().catch(() => {});
          await this.page.waitForSelector(DIALOG_TEXTAREA_SELECTOR, { state: "visible", timeout: 3000 }).catch(() => {});
        }
      }
      const ta = this.page.locator(DIALOG_TEXTAREA_SELECTOR).first();
      if (await ta.count()) {
        await ta.click().catch(() => {});
        await humanType(this.page, note);
        noteSent = true;
      } else {
        await this._dismissDialog();
        return { ok: false, reason: "note_textarea_unavailable" };
      }
    }
    // Click last button (primary/Send).
    const buttons = this.page.locator(`${DIALOG_SELECTOR} button, ${DIALOG_SELECTOR} [role='button']`);
    const count = await buttons.count();
    if (count === 0) {
      await this._dismissDialog();
      return { ok: false, reason: "no_buttons" };
    }
    try {
      await buttons.nth(count - 1).click({ timeout: 4000 });
    } catch {
      try {
        await buttons.nth(count - 1).focus();
        await this.page.keyboard.press("Enter");
      } catch {
        await this._dismissDialog();
        return { ok: false, reason: "submit_click_failed" };
      }
    }
    // Wait for dialog to close.
    try {
      await this.page.waitForSelector(DIALOG_SELECTOR, { state: "hidden", timeout: 5000 });
    } catch {
      await this._dismissDialog();
      return { ok: false, reason: "dialog_did_not_close" };
    }
    return { ok: true, noteSent };
  }

  // Withdraw an outstanding sent invite by username (we navigate to the manager,
  // find the row matching the username, click the row's Withdraw button).
  async withdrawInvite(username, { dryRun = true } = {}) {
    const url = "https://www.linkedin.com/mynetwork/invitation-manager/sent/";
    await this.navigateTo(url);
    if (dryRun) return { url, status: "would_withdraw", ok: true, dryRun: true };

    // Find a card whose href contains /in/<username>/, then click its Withdraw button.
    // NOTE: ":has-text(...)" is a Playwright pseudo-selector — invalid in raw querySelector.
    // We use innerText matching instead.
    const rowFound = await this.page.evaluate((u) => {
      const cards = Array.from(document.querySelectorAll('main li, main [data-test-id*="invitation"]'));
      for (const card of cards) {
        const a = card.querySelector(`a[href*="/in/${u}/"]`);
        if (!a) continue;
        const ariaBtn = card.querySelector('button[aria-label*="Withdraw"]');
        if (ariaBtn) { ariaBtn.click(); return true; }
        const textBtn = Array.from(card.querySelectorAll("button"))
          .find((b) => /withdraw/i.test(b.innerText || ""));
        if (textBtn) { textBtn.click(); return true; }
      }
      return false;
    }, username).catch(() => false);
    if (!rowFound) return { url, status: "not_found", ok: false };
    // Confirm in modal (Withdraw confirmation).
    await sleep(jitter(500, 1200));
    if (await this._dialogIsOpen({ timeoutMs: 3000 })) {
      const confirm = this.page.locator(`${DIALOG_SELECTOR} button`).last();
      await confirm.click().catch(() => {});
      await this.page.waitForSelector(DIALOG_SELECTOR, { state: "hidden", timeout: 4000 }).catch(() => {});
    }
    return { url, status: "withdrawn", ok: true };
  }

  // Send a message via the magic compose URL (requires profile URN — we read it from the profile page).
  async sendMessage(username, message, { confirmSend = false, profileUrn = null } = {}) {
    if (!username || !message) throw new Error("sendMessage: username and message required");
    const profileUrl = `https://www.linkedin.com/in/${encodeURIComponent(username)}/`;
    let urn = profileUrn;
    if (!urn) {
      await this.navigateTo(profileUrl);
      urn = await this._extractProfileUrn();
    }

    let composeUrl;
    if (urn) {
      // Normalize once to the bare profile id so both query params agree.
      // MCP reference: profileUrn = encoded "urn:li:fsd_profile:<id>", recipient = bare <id>.
      const profileId = urn.replace(/^urn:li:fsd_profile:/, "");
      const encodedProfileUrn = encodeURIComponent(`urn:li:fsd_profile:${profileId}`);
      composeUrl = `https://www.linkedin.com/messaging/compose/?profileUrn=${encodedProfileUrn}&recipient=${encodeURIComponent(profileId)}&screenContext=NON_SELF_PROFILE_VIEW&interop=msgOverlay`;
    } else {
      // Fall back to the visible Message-button anchor's href (1st-degree only).
      const href = await this.page.evaluate((sel) => {
        const a = document.querySelector(sel);
        return a ? (a.getAttribute("href") || a.href || null) : null;
      }, COMPOSE_LINK_SELECTOR).catch(() => null);
      if (!href) {
        return { url: profileUrl, status: "message_unavailable", ok: false, reason: "no_compose_anchor" };
      }
      composeUrl = href.startsWith("http") ? href : `https://www.linkedin.com${href}`;
    }

    if (!confirmSend) {
      return { url: profileUrl, composeUrl, status: "would_send", ok: true, dryRun: true };
    }

    await this.page.goto(composeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await detectRateLimit(this.page);
    await waitForMainText(this.page);
    await handleModalClose(this.page);
    await sleep(jitter(800, 1600));

    // Find the compose box. MCP reference: prefer count() > 0 + JS focus over isVisible
    // (Patchright can time out on React-hydrated contenteditables).
    const deadline = Date.now() + 8000;
    let boxSelector = null;
    while (Date.now() < deadline) {
      for (const sel of COMPOSE_BOX_SELECTORS) {
        const c = await this.page.locator(sel).count().catch(() => 0);
        if (c > 0) { boxSelector = sel; break; }
      }
      if (boxSelector) break;
      await sleep(300);
    }
    if (!boxSelector) {
      return { url: profileUrl, composeUrl, status: "send_failed", ok: false, reason: "compose_box_not_found" };
    }
    // Focus + click the box via JS (more reliable than locator.click on contenteditable).
    await this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.focus(); el.click?.(); }
    }, boxSelector).catch(() => {});
    await sleep(jitter(200, 500));
    await humanType(this.page, message);
    await sleep(jitter(500, 1100));

    // Verify the typed message is in the compose box before clicking Send.
    const typedOk = await this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const t = (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
      return t.length > 0;
    }, boxSelector).catch(() => false);
    if (!typedOk) {
      return { url: profileUrl, composeUrl, status: "send_failed", ok: false, reason: "compose_typing_failed" };
    }

    const send = this.page.locator(SEND_BUTTON_SELECTOR).first();
    let clickedSend = false;
    if ((await send.count().catch(() => 0)) > 0) {
      await send.click().catch(() => {});
      clickedSend = true;
    }
    if (!clickedSend) {
      // Keyboard fallback. Use both Meta and Control for cross-OS.
      try { await this.page.keyboard.press("Meta+Enter"); } catch { /* ignore */ }
      try { await this.page.keyboard.press("Control+Enter"); } catch { /* ignore */ }
    }
    await sleep(jitter(800, 1600));

    // Verify send: compose box should be empty (message sent + cleared) AND the message
    // text should appear in the message thread surface.
    const sendVerified = await this.page.evaluate(({ sel, expected }) => {
      const box = document.querySelector(sel);
      const boxText = (box?.innerText || box?.textContent || "").replace(/\s+/g, " ").trim();
      const main = document.querySelector("main");
      const mainText = (main?.innerText || "").replace(/\s+/g, " ");
      const expectedNorm = expected.replace(/\s+/g, " ").trim();
      // Compose box cleared OR the message is visible somewhere on the page.
      return (!boxText || boxText.length === 0) || mainText.includes(expectedNorm.slice(0, 60));
    }, { sel: boxSelector, expected: message }).catch(() => false);

    if (!sendVerified) {
      return { url: profileUrl, composeUrl, status: "send_failed", ok: false, reason: "send_unverified" };
    }
    return { url: profileUrl, composeUrl, status: "sent", ok: true };
  }
}

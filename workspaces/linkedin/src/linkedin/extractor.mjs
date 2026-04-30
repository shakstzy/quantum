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
    return await this.page.evaluate(async ({ limit }) => {
      const labels = Array.from(document.querySelectorAll('main label[aria-label^="Select conversation"]'));
      const out = [];
      for (let i = 0; i < Math.min(labels.length, limit); i++) {
        const label = labels[i];
        const aria = label.getAttribute("aria-label") || "";
        const name = aria.replace(/^Select conversation with\s*/i, "").trim();
        const click = label.closest("li")?.querySelector('div[class*="listitem__link"]');
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
      // Open via inbox search by username.
      await this.navigateTo("https://www.linkedin.com/messaging/");
      await this._searchInboxAndOpen(username);
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
    } catch { /* fall through */ }
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
    // Verify by re-reading the profile.
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
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
    const rowFound = await this.page.evaluate((u) => {
      const cards = Array.from(document.querySelectorAll('main li, main [data-test-id*="invitation"]'));
      for (const card of cards) {
        const a = card.querySelector(`a[href*="/in/${u}/"]`);
        if (!a) continue;
        const btn = card.querySelector('button[aria-label*="Withdraw"], button:has-text("Withdraw")');
        if (btn) { btn.click(); return true; }
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
      const encoded = encodeURIComponent(`urn:li:fsd_profile:${urn.replace(/^urn:li:fsd_profile:/, "")}`);
      composeUrl = `https://www.linkedin.com/messaging/compose/?profileUrn=${encoded}&recipient=${encodeURIComponent(urn)}&screenContext=NON_SELF_PROFILE_VIEW&interop=msgOverlay`;
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

    // Find the compose box.
    let box = null;
    for (const sel of COMPOSE_BOX_SELECTORS) {
      const loc = this.page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) { box = loc; break; }
    }
    if (!box) return { url: profileUrl, composeUrl, status: "send_failed", ok: false, reason: "compose_box_not_found" };

    await box.click().catch(() => {});
    await humanType(this.page, message);
    await sleep(jitter(500, 1100));

    const send = this.page.locator(SEND_BUTTON_SELECTOR).first();
    if (!(await send.isVisible({ timeout: 4000 }).catch(() => false))) {
      // Send button still disabled? Try Cmd+Enter / Ctrl+Enter.
      try { await this.page.keyboard.press("Meta+Enter"); }
      catch { try { await this.page.keyboard.press("Control+Enter"); } catch { /* ignore */ } }
    } else {
      await send.click().catch(() => {});
    }
    await sleep(jitter(800, 1600));
    return { url: profileUrl, composeUrl, status: "sent", ok: true };
  }
}

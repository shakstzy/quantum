#!/usr/bin/env node
// Tags raw/contacts/<slug>.md entries with category=person|business|noise.
// Runs after ingest.mjs. Respects manual `category:` overrides set by user.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(__dirname, "../../..", "raw/contacts");

const BUSINESS_NAME_RE = /\b(Inc|LLC|Co\.|Corp|Ltd|GmbH|Pte|Pty|Support|Service|Pharmacy|Bank|Insurance|Hospital|Clinic|Office|Concierge|Reservations|Help|Helpdesk|Wireless|Telecom)\b/i;
const KNOWN_BRANDS_RE = /\b(Apple|Google|Microsoft|Amazon|Meta|Facebook|Uber|Lyft|DoorDash|Postmates|Instacart|FedEx|UPS|USPS|Verizon|AT&T|Sprint|T-Mobile|Comcast|Xfinity|Spectrum|PGE|Pacific Gas|Geico|StateFarm|Allstate|Progressive|Wells Fargo|Chase|BofA|Bank of America|Citi|Capital One|Discover|Schwab|Fidelity|Vanguard|TD Ameritrade|Robinhood|Coinbase|Stripe|Square|Venmo|PayPal|Cash App|Zelle)\b/i;
const NOREPLY_DOMAIN_RE = /^(noreply|no-reply|donotreply|notifications|alerts|support|info|admin|hello|contact)@/i;

function looksLikeShortcode(rawPhone) {
  if (!rawPhone) return false;
  const trimmed = rawPhone.trim();
  if (trimmed.startsWith("+")) return false;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 3 && digits.length <= 7;
}

function looksLikeMnemonic(rawPhone) {
  return /[A-Z]/.test(rawPhone || "") && /[0-9]/.test(rawPhone || "");
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  return { rawFm: m[1], body: m[2] };
}

function get(rawFm, key) {
  const m = rawFm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!m) return null;
  const v = m[1].trim();
  if (v === "null" || v === "[]") return null;
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

function getArray(rawFm, key) {
  const re = new RegExp(`^${key}:\\s*(\\[.*?\\]|null|\\[\\])$|^${key}:\\s*\\n((?:\\s+- .+\\n?)+)`, "m");
  const m = rawFm.match(re);
  if (!m) return [];
  if (m[1]) {
    if (m[1] === "null" || m[1] === "[]") return [];
    try { return JSON.parse(m[1]); } catch { return []; }
  }
  return m[2].split("\n").filter(Boolean).map(line => {
    const t = line.replace(/^\s+- /, "").trim();
    try { return JSON.parse(t); } catch { return t; }
  });
}

function setFrontmatterField(rawFm, key, value) {
  const formatted = typeof value === "string" ? JSON.stringify(value) : String(value);
  const re = new RegExp(`^${key}:\\s*.+$`, "m");
  if (re.test(rawFm)) return rawFm.replace(re, `${key}: ${formatted}`);
  return rawFm + `\n${key}: ${formatted}`;
}

// A "human first-name pattern" = a single ascii word, 2+ letters, capitalized,
// no business-noise tokens. If the firstName slot looks like that, default to person
// even if the rest of the name contains employer/brand words (e.g. "Amy" / "Yensuang Coinbase APM").
function looksLikeHumanFirstName(s) {
  if (!s) return false;
  const trimmed = s.trim();
  if (trimmed.length < 2) return false;
  if (!/^[A-Z][a-zA-Z'\-]+$/.test(trimmed)) return false;
  if (BUSINESS_NAME_RE.test(trimmed)) return false;
  if (KNOWN_BRANDS_RE.test(trimmed)) return false;
  return true;
}

function classify({ rawFm }) {
  const fullName = get(rawFm, "full_name") || "";
  const firstName = get(rawFm, "first_name") || "";
  const lastName = get(rawFm, "last_name") || "";
  const organization = get(rawFm, "organization") || "";
  const emails = getArray(rawFm, "emails");
  const phones = getArray(rawFm, "phones");
  const rawPhonesLine = (rawFm.match(/raw_phones:\s*(\[.*?\])/m) || [, "[]"])[1];
  let rawPhones = [];
  try { rawPhones = JSON.parse(rawPhonesLine); } catch {}

  // Hard signals (overrule first-name check): these are unambiguously business.
  if (rawPhones.some(looksLikeShortcode)) return "business";
  if (rawPhones.some(looksLikeMnemonic)) return "business";
  if (emails.length && emails.every(e => NOREPLY_DOMAIN_RE.test(e))) return "business";

  // If the first-name field looks like a real human, trust it — even if employer/brand
  // appears later in the name. "Amy Yensuang Coinbase APM" is a person; "Apple Support" is not.
  const humanFirst = looksLikeHumanFirstName(firstName);
  if (!humanFirst) {
    const nameForChecks = `${fullName} ${organization}`;
    if (BUSINESS_NAME_RE.test(nameForChecks)) return "business";
    if (KNOWN_BRANDS_RE.test(nameForChecks)) return "business";
  }

  // Noise: nothing identifying at all.
  if (firstName.length <= 1 && !lastName && phones.length === 0 && emails.length === 0) return "noise";

  return "person";
}

async function main() {
  const files = (await readdir(RAW_DIR).catch(() => [])).filter(f => f.endsWith(".md"));
  const counts = { person: 0, business: 0, noise: 0, manual_override: 0, unchanged: 0, updated: 0 };
  for (const f of files) {
    const path = resolve(RAW_DIR, f);
    const text = await readFile(path, "utf8");
    const parsed = parseFrontmatter(text);
    if (!parsed) continue;
    const { rawFm, body } = parsed;

    // detect manual override: a category set to non-default value with a manual marker
    const categoryLine = rawFm.match(/^category:\s*(.+?)(\s+#\s*manual)?$/m);
    if (categoryLine && categoryLine[2]) {
      counts.manual_override += 1;
      const cur = categoryLine[1].replace(/^"|"$/g, "");
      counts[cur] = (counts[cur] || 0) + 1;
      continue;
    }

    const category = classify({ rawFm });
    const currentCat = (categoryLine ? categoryLine[1] : "person").replace(/^"|"$/g, "");
    if (currentCat === category) {
      counts[category] += 1;
      counts.unchanged += 1;
      continue;
    }
    const newFm = setFrontmatterField(rawFm, "category", category);
    await writeFile(path, `---\n${newFm}\n---\n${body}`);
    counts[category] += 1;
    counts.updated += 1;
  }
  console.log(JSON.stringify(counts, null, 2));
}

await main();

// Cross-reference a Tinder match with iMessage activity.
// v1: reads macOS Contacts via osascript to find phone for a name, then scans
//     raw/imessage/YYYY-MM.ndjson for messages with that handle.
// v2 TODO: switch to graphify lookups once a dedicated Apple Contacts ingest workspace exists.

import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { QUANTUM_ROOT } from "./paths.mjs";

const execFile = promisify(_execFile);

function normalizeDigits(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.startsWith("+")) return raw;
  return null;
}

// C4 FIX: require BOTH first AND last name. First-name-only fuzzy match was
// catastrophic — with 2,277 contacts, multiple Sarahs/Annas/Emilys all match,
// and the bot would condition Tinder drafts on the wrong person's iMessage history.
// If only first name is known (typical for Tinder), return null and skip the
// side-channel entirely. Better to default to "tinder_only" than draft against
// the wrong human.
export async function findPhoneByName(firstName, lastName = null) {
  if (!firstName) return null;
  if (!lastName) return null; // explicit refusal: no side-channel without last-name confirmation
  const safeFirst = firstName.replace(/"/g, '\\"');
  const safeLast = lastName.replace(/"/g, '\\"');
  const script = `
    tell application "Contacts"
      set theMatches to (every person whose first name is "${safeFirst}" and last name is "${safeLast}")
      if (count of theMatches) is 0 then return ""
      if (count of theMatches) is greater than 1 then return ""
      set thePerson to item 1 of theMatches
      set thePhones to value of phones of thePerson
      if (count of thePhones) is 0 then return ""
      return item 1 of thePhones
    end tell`;
  try {
    const { stdout } = await execFile("osascript", ["-e", script], { timeout: 8000 });
    return normalizeDigits(stdout.trim());
  } catch { return null; }
}

const IMESSAGE_DIR = resolve(QUANTUM_ROOT, "raw/imessage");

async function* iterRecentImessageShards(daysBack = 60) {
  let files;
  try { files = await readdir(IMESSAGE_DIR); }
  catch { return; }
  const shards = files.filter(f => /^\d{4}-\d{2}\.ndjson$/.test(f)).sort().reverse();
  const cutoff = new Date(Date.now() - daysBack * 86400000);
  const cutoffShard = cutoff.toISOString().slice(0, 7);
  for (const f of shards) {
    if (f.slice(0, 7) < cutoffShard) break;
    yield resolve(IMESSAGE_DIR, f);
  }
}

export async function lastImessageActivity(phone, { daysBack = 60 } = {}) {
  if (!phone) return null;
  let lastIn = null;
  let lastOut = null;
  let countIn = 0;
  let countOut = 0;
  for await (const path of iterRecentImessageShards(daysBack)) {
    const text = await readFile(path, "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const handle = row.handle || row.sender_handle || row.from_handle;
      const participants = row.participants || (handle ? [handle] : []);
      if (!participants.some(p => normalizeDigits(p) === phone)) continue;
      const isFromMe = row.is_from_me === true || row.direction === "out";
      const date = row.date || row.ts || row.sent_at;
      if (!date) continue;
      if (isFromMe) { countOut += 1; if (!lastOut || date > lastOut) lastOut = date; }
      else { countIn += 1; if (!lastIn || date > lastIn) lastIn = date; }
    }
  }
  return { phone, lastIn, lastOut, countIn, countOut };
}

export function summarizeImessage(activity) {
  if (!activity) return "no number on file; no iMessage history";
  const { lastIn, lastOut, countIn, countOut } = activity;
  if (!lastIn && !lastOut) return "phone on file but no iMessage history found";
  const lastInDays = lastIn ? Math.floor((Date.now() - new Date(lastIn).getTime()) / 86400000) : null;
  const lastOutDays = lastOut ? Math.floor((Date.now() - new Date(lastOut).getTime()) / 86400000) : null;
  return `iMessage: ${countIn} in / ${countOut} out, last_in=${lastInDays ?? "—"}d ago, last_out=${lastOutDays ?? "—"}d ago`;
}

export function recommendChannel(activity, { silenceThresholdDays = 5 } = {}) {
  if (!activity) return "tinder_only";
  const { lastIn, lastOut } = activity;
  if (!lastIn && !lastOut) return "tinder_only";
  const lastInDays = lastIn ? (Date.now() - new Date(lastIn).getTime()) / 86400000 : Infinity;
  if (lastInDays <= silenceThresholdDays) return "imessage_active";
  return "tinder_reengage";
}

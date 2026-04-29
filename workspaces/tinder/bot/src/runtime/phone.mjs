// Single shared canonicalizer for phone numbers in E.164.
// USE THIS EVERYWHERE that touches a phone — contacts ingest, tinder entity store,
// imessage cross-ref. Three different canonicalizers used to live in the codebase
// and quietly diverged, breaking graphify edges across files. One source of truth.
//
// Output is `+<digits>` or null. Returns null for shortcodes (3-7 digits, no `+`),
// mnemonic numbers (1-800-MY-APPLE), and anything that can't be reliably mapped.
//
// Heuristics:
//   - Starts with `+` -> trust the country code, return `+<digits>`
//   - 10 digits -> assume US, prefix `+1`
//   - 11 digits starting with `1` -> assume US, return `+<digits>`
//   - 11-15 digits NOT starting with `1` -> assume international, prefix `+`
//   - Anything shorter than 10 digits without `+` -> shortcode/spam, return null

export function canonicalPhone(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  // mnemonic numbers (1-800-MY-APPLE etc.) — letters present, treat as business shortcode
  if (/[a-z]/i.test(trimmed.replace(/^1-?800-?/i, ""))) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null; // shortcodes, junk, partial numbers
}

export function isShortcode(raw) {
  if (!raw) return false;
  const trimmed = String(raw).trim();
  if (trimmed.startsWith("+")) return false;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 3 && digits.length <= 7;
}

export function isMnemonic(raw) {
  if (!raw) return false;
  return /[A-Z]/.test(raw) && /[0-9]/.test(raw);
}

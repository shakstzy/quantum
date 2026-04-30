// Canonical kebab-case slug. ASCII only (per QUANTUM raw-deposit rule).
// Used for filenames in raw/linkedin/<slug>-linkedin.md.

const DIACRITICS_RE = /\p{Diacritic}/gu;

export function toSlug(s) {
  if (!s) return "unknown";
  return String(s)
    .normalize("NFKD")
    .replace(DIACRITICS_RE, "")
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

export function rawFilename(slug) {
  return `${slug}-linkedin.md`;
}

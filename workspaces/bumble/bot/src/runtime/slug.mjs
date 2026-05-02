// Slug generator + parser. Format: <first>-<source>-<city>[-<n>].md
// The optional -<n> suffix disambiguates collisions.

const FIRST_NAME_PATTERN = /^[\p{Letter}'\-]+/u;

export function firstName(name) {
  if (!name) return "x";
  const m = name.trim().match(FIRST_NAME_PATTERN);
  return m ? m[0].toLowerCase().replace(/'/g, "") : "x";
}

export function buildSlug({ name, source, city, suffix = null }) {
  const first = firstName(name);
  const parts = [first, source, city];
  if (suffix) parts.push(String(suffix));
  return parts.join("-");
}

export async function uniqueSlug({ name, source, city }, existingSlugs) {
  const base = buildSlug({ name, source, city });
  if (!existingSlugs.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = buildSlug({ name, source, city, suffix: i });
    if (!existingSlugs.has(candidate)) return candidate;
  }
  throw new Error(`could not generate unique slug for ${name} in ${city}`);
}

export function parseSlug(slug) {
  const parts = slug.split("-");
  if (parts.length < 3) return null;
  let suffix = null;
  if (/^\d+$/.test(parts[parts.length - 1])) {
    suffix = parseInt(parts.pop(), 10);
  }
  const city = parts.pop();
  const source = parts.pop();
  const first = parts.join("-");
  return { first, source, city, suffix };
}

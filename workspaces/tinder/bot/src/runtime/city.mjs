// City resolver. Buckets a Tinder profile into a city slug for graph linking.
// Strategy: if phone known + area code maps -> use that. Else use Tinder distance from home (Austin).
// SHAKOS-imported and current-day data both default to "austin" when distance < 100mi.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CONFIG_DIR } from "./paths.mjs";

let _cache = null;
async function loadCities() {
  if (_cache) return _cache;
  _cache = JSON.parse(await readFile(resolve(CONFIG_DIR, "cities.json"), "utf8"));
  return _cache;
}

function areaCodeOf(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1, 4);
  if (digits.length === 10) return digits.slice(0, 3);
  return null;
}

export async function resolveCity({ phone = null, distance_mi = null } = {}) {
  const cities = await loadCities();

  if (phone) {
    const ac = areaCodeOf(phone);
    if (ac) {
      for (const [slug, def] of Object.entries(cities.buckets)) {
        if ((def.area_codes || []).includes(ac)) return slug;
      }
    }
  }

  if (distance_mi != null) {
    const home = cities.buckets[cities.home];
    if (home && distance_mi <= (home.tx_distance_max_mi ?? 100)) return cities.home;
  }

  return cities.home;
}

export async function citiesList() {
  const c = await loadCities();
  return Object.keys(c.buckets);
}

// City resolver. Buckets a Bumble profile into a city slug for graph linking.
// Resolution order (highest signal first):
//   1. Conversation mention ("I'm in NYC", "just moved to LA") - strongest, overrides all
//   2. Phone area code, if known (E.164 +1 numbers)
//   3. Distance-from-current-location
//   4. Default: home (austin)

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CONFIG_DIR } from "./paths.mjs";
import { detectLocationFromConversation } from "./location.mjs";

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

export async function resolveCity({ phone = null, distance_mi = null, conversation = null } = {}) {
  const cities = await loadCities();

  if (conversation) {
    const detected = detectLocationFromConversation(conversation);
    if (detected?.city) return detected.city;
  }

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

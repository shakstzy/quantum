---
name: real-estate
description: Scrape Redfin and Zillow listings, property details, history, comps, tax records, AI summaries, walk/transit/bike scores, parcel info, permits, polygon/bbox/multi-region searches via a free CLI (curl_cffi TLS impersonation, no paid API). Use for "look up <address>", "find homes in <city>", "search homes in this polygon", "redfin estimate", "zestimate", "comps", "price history", "school ratings", "tax history", "compare <region A> vs <region B>".
---

# real-estate

Free, local CLI for Redfin + Zillow research queries. No paid API. No browser. No bot-detection cat-and-mouse beyond a TLS-impersonating HTTP client (`curl_cffi`).

## When this fires

Trigger phrases (semantic, non-exhaustive):
- "find homes in <city>", "search Redfin for <city>", "houses for sale in <zip>"
- "look up <address>", "details on <Zillow/Redfin URL>"
- "what's the Zestimate for X", "Redfin Estimate for X"
- "price history for <address>", "comps for <address>"
- "tax history for <address>", "school ratings for <address>"
- "compare <address> on Zillow vs Redfin"

Do NOT fire for:
- Aggregate market data (median price, days-on-market trends): different shape, use Redfin Data Center / FRED separately.
- Off-market or expired listings older than ~6 months: data is unreliable.
- Anything outside the US: skill is US-only.
- Login-gated agent tools (Redfin Pro / Zillow Premier): out of scope.

## Auth

None. Both sites are scraped from public HTML. The first request per session warms cookies via `https://www.{site}.com/`. No keys, no proxies, no MCP.

## Procedure

From repo root:

```bash
# THE simple "address -> all the info" path (queries BOTH sites + merges)
_core/skills/real-estate/re lookup "9400 Shady Oaks Dr Austin TX 78729"

# Just the merged top-level view, skip the per-source dumps
_core/skills/real-estate/re lookup "<address>" --merged-only

# With full nested raw payloads for both sources
_core/skills/real-estate/re lookup "<address>" --include-raw

# Basic regional search
_core/skills/real-estate/re redfin search "Austin, TX" --max-price 700000 --min-beds 3 --num-homes 50
_core/skills/real-estate/re zillow search "Austin, TX" --max-price 700000 --min-beds 3

# All filter flags (both sites)
_core/skills/real-estate/re redfin search "Austin, TX" \
  --max-price 700000 --min-beds 3 --min-baths 2 \
  --min-sqft 1500 --max-sqft 3500 --max-hoa 200 \
  --year-built-min 2000 --year-built-max 2020 \
  --lot-size-min 5000 --has-pool --has-garage \
  --new-construction --home-types house,condo \
  --status active --sort newest --page 1

# Custom polygon (lat,lng pairs separated by ;)
_core/skills/real-estate/re redfin search --polygon "30.27,-97.74;30.30,-97.74;30.30,-97.70;30.27,-97.70" --max-price 700000
_core/skills/real-estate/re zillow search --polygon "30.27,-97.74;30.30,-97.74;30.30,-97.70;30.27,-97.70"

# Bounding box (north,east,south,west)
_core/skills/real-estate/re redfin search --bbox "30.30,-97.70,30.27,-97.80" --max-price 700000
_core/skills/real-estate/re zillow search --bbox "30.30,-97.70,30.27,-97.80"

# Multi-region OR (sequential, deduped, throttled)
_core/skills/real-estate/re redfin search --regions "Austin, TX;Round Rock, TX;Cedar Park, TX" --max-price 600000

# Manual Redfin region override (skip Brave; useful when brave-search is unauthed)
_core/skills/real-estate/re redfin search --region-id 30818 --region-type 6 --max-price 700000

# Property details
_core/skills/real-estate/re redfin property "https://www.redfin.com/TX/Austin/.../home/<id>"
_core/skills/real-estate/re zillow property "https://www.zillow.com/homedetails/.../<zpid>_zpid/"

# Property details + full nested API payloads
_core/skills/real-estate/re redfin property "<url>" --include-raw

# Just price + listing history (Redfin)
_core/skills/real-estate/re redfin history "<redfin-url>"

# Comps (Redfin)
_core/skills/real-estate/re redfin comps "<redfin-url>"

# Resolve a free-text query into a Redfin region (no listing fetch)
_core/skills/real-estate/re redfin resolve "78704"
```

## Filter flags reference

Available on both `redfin search` and `zillow search` unless noted:

| Flag | Type | Notes |
|------|------|-------|
| `--max-price`, `--min-price` | int | dollars |
| `--min-beds` | int | |
| `--min-baths` | float | |
| `--min-sqft`, `--max-sqft` | int | |
| `--max-hoa` | int | dollars/month |
| `--year-built-min`, `--year-built-max` | int | |
| `--lot-size-min`, `--lot-size-max` | int | sqft |
| `--has-pool`, `--has-garage` | flag | |
| `--new-construction` | flag | |
| `--home-types` | list | Redfin only: `house,condo,townhouse,multi-family,land,mobile,coop` |
| `--status` | choice | `active` (default), `pending`, `sold`, `coming-soon`, `off-market` (zillow), `contingent` (redfin) |
| `--sort` | choice | `newest`, `price-asc`, `price-desc`, `sqft-asc`, `sqft-desc`, `lot-desc` |
| `--page` | int | 1-indexed pagination |
| `--polygon` | string | `lat,lng;lat,lng;...` ≥3 vertices |
| `--bbox` | string | `north,east,south,west` |
| `--regions` | string | multi-region OR: `City1, ST;City2, ST;...` |
| `--region-id` + `--region-type` | int | Redfin only; manual override (6=city, 2=zip, 1=neighborhood, 5=county, 4=state) |
| `--num-homes` | int | Redfin only; default 50, max 450 |

All commands print one JSON document to stdout. Pipe through `jq` for filtering when results get large:

```bash
./re redfin search "Austin, TX" --max-price 700000 \
  | jq '.homes[] | {address, price, beds, sqft, url}'
```

## How it works

Both sites server-render their React pages and embed every API response into the HTML. We:
1. GET the public HTML page humans visit.
2. Pull the embedded JSON blob (`reactServerState.InitialContext` for Redfin, `__NEXT_DATA__` for Zillow).
3. Reach into the cached API responses and reformat them into a flatter shape.

**Why HTML and not the JSON endpoints directly?** The JSON endpoints (Redfin's `/stingray/do/location-autocomplete`, Zillow's `async-create-search-page-state`) sit behind the same WAF that blocks scrapers. The HTML pages don't, and they contain the same data pre-fetched.

**Why curl_cffi?** It impersonates a real Chrome TLS handshake (JA3 fingerprint, ALPN order, cipher suites). Stock `requests` / `urllib` get fingerprinted as bots within one request. curl_cffi clears the bar at zero ongoing cost.

- Redfin: `chrome131` impersonation works.
- Zillow (PerimeterX): the script auto-rotates across `chrome124`, `safari17_0`, `chrome131`, `chrome120`, `chrome116`, `firefox133`. As of April 2026 chrome124 is primary and safari17_0 is the resilient fallback (PX defaults to detecting Chrome fingerprints). If all profiles fail with `px-captcha`, the IP is softlocked - wait ~30 min or change networks. New profiles ship in curl-cffi releases at https://github.com/lexiforest/curl-cffi/releases; bump `_PROFILE_ROTATION` in `scripts/zillow.py` if PX adapts.

## Region resolution

- **Redfin** uses brave-search to find the canonical city URL: query `site:redfin.com <city>`, parse the `/city/<id>/<state>/<name>` URL pattern, extract the integer region_id. ZIP codes (`/zipcode/<5digit>`) and neighborhood URLs are recognized too. Brave is invoked via `_core/skills/brave-search/search.sh`. If it isn't authed, this falls over; fix brave-search first.
- **Zillow** slugifies free-text directly: `"Austin, TX"` becomes `austin-tx` and the URL becomes `https://www.zillow.com/homes/austin-tx_rb/`. The `_rb` (results-board) path is the one Zillow's frontend uses for filtered queries; the shorter `/austin-tx/` city-guide path also resolves but ignores `searchQueryState` filters in some A/B variants. Bare ZIPs work too (`78704`). Pass a full Zillow URL when slugification fails. Search does an unfiltered fetch first to discover `mapBounds` + `regionSelection`, then re-fetches with filters - without those bounds Zillow falls back to a default region (often Austin).

## Budget and rate limits

- Default cap: **20 requests per task** across both sites combined. Both sites' WAFs throttle aggressively; bursts get the IP softlocked for 30+ minutes.
- Sleep ≥1s between requests when looping more than 5 in a row. Do not parallelize.
- Listings are immutable for the day you scraped them. Cache to `raw/library/real-estate/YYYY-MM-DD/<zpid-or-propertyId>.json` if Adithya asks to keep an artifact.
- This is a **personal-use tool, not a redistribution pipeline**. Both sites' ToS prohibit scraping; the legal exposure on personal-volume queries is low but non-zero. Don't ship results downstream commercially.

## Failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `HTTP 403` on Redfin gis-csv | WAF flagged this IP | wait 30 min, or use mobile hotspot |
| `px-captcha` body on Zillow | curl_cffi impersonation profile out of date | bump `impersonate=` in `scripts/zillow.py` |
| `__NEXT_DATA__ not found` | Zillow A/B-tested layout | re-check page source; Next.js script tag may have moved |
| `brave-search not found` | brave-search skill not installed/authed | fix brave-search first; or pass `--region-id <N> --region-type 6` |
| Redfin search returns 0 homes | the cache key match is wrong | inspect `dataCache` keys with `/stingray/api/gis?` prefix |
| `region not resolvable` | Brave returned no Redfin URL | pass a Redfin URL, or `--region-id <N> --region-type 6` (city) / `2` (zip) |

## Output shape

`search` returns:
```jsonc
{
  "source": "redfin" | "zillow",
  "query": "...",
  "url": "<canonical-search-url>",
  "count": N,
  "homes": [{"address","city","state","zip","price","beds","baths","sqft","year_built","lot_size","url","status",...}, ...]
}
```

`property` returns the flattened union of every cached endpoint Redfin or Zillow embeds in the page. Notable fields beyond the basics:

**Redfin property:**
- `ai_summary`, `ai_property_details` (Redfin's auto-generated narrative)
- `location_score`, `walk_score`, `transit_score`, `bike_score`
- `commute` (commute time estimates), `weather` (monthly averages), `sun_exposure`
- `parcel_info`, `parcel_boundaries`, `zoning`, `permits`
- `neighborhood_stats`, `popularity`, `price_drop`, `home_highlight_tags`
- `nearby_open_houses`, `newest_listings_nearby`
- `tour_insights`, `buying_power`, `avm_historical`
- `listing_agent` (name, license, phone, email, brokerage)
- `mls_id`, `mls_source`, `apn`, `tax_info`
- `photos[]` (full URL list), `photo_count`

**Zillow property:**
- `description`, `home_insights`, `home_status`, `listing_sub_type`, `contingent_listing_type`
- `time_on_zillow`, `date_posted`, `date_sold`
- `zestimate`, `rent_zestimate`, `zestimate_low`, `zestimate_high`, `tax_assessed_value`
- `tax_history`, `price_history`, `value_history`
- `property_tax_rate`, `monthly_hoa_fee`, `annual_homeowners_insurance`
- `parking_features`, `garage_spaces`, `heating`, `cooling`, `appliances`, `fireplace`, `flooring`, `stories`
- `interior_features`, `exterior_features`, `view_description`, `pool_features`
- `is_new_construction`, `mls_id`, `mls_name`
- `listing_agent` (name, phone, license, email, brokerage, brokerage_phone), `co_listing_agents`
- `nearby_homes`, `nearby_cities`, `nearby_neighborhoods`, `nearby_zipcodes`
- `walk_score`, `transit_score`, `bike_score`, `climate_risk`
- `virtual_tour_url`, `open_houses`, `mortgage_rates`, `tour_eligibility`
- `photos[]`, `photo_count`

## Cross-source dedupe

The `dedupe` module merges Redfin + Zillow result sets, keying on `zpid` /
`property_id` first, then lat/lng proximity (≤25 m) AND matching beds AND
sqft within 5%. Output is a unified list where each merged home has an
`_other_sources` array with the duplicate-source rows for side-by-side
price/zestimate comparison.

```python
from scripts import dedupe
merged = dedupe.merge(redfin_homes, zillow_homes)
```

## Dev workflow (no live hits)

If Claude needs to iterate on parsing logic, the rule is **fixture-only**.
See `raw/learnings/2026-04-28-cache-html-during-scraper-dev.md`.

1. Run `scripts/capture_fixtures.py` ONCE (1-2 live hits per site, max).
   Saves full HTML + parsed JSON to `.dev-fixtures/` (gitignored).
2. Run tests via `uv run python -m unittest discover tests`. Tests
   monkey-patch `_fetch_html` / `_get_session` / subprocess to raise
   `NetworkDisabledError`, so any test path that tries to hit live blows
   up loudly.
3. Iterate against the fixtures. Re-capture only when Redfin/Zillow
   visibly changes their layout.

## Notes

- This skill is the primary path for house-research queries. There's no workspace shape because the work is on-demand and query-driven, not stream-ingested.
- If/when free scraping breaks for good, the documented fallback is the Apify Zillow/Redfin scrapers (paid). Don't pre-emptively switch; only switch when this stops working.
- The `re` wrapper auto-locates the skill directory and uses the local `uv` env, so it works from any cwd.

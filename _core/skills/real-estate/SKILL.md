---
name: real-estate
description: Scrape Redfin and Zillow listings, property details, history, comps, and tax records via a free CLI (curl_cffi TLS impersonation, no paid API). Use for "look up <address>", "find homes in <city>", "redfin estimate", "zestimate", "comps", "price history", "school ratings", "tax history".
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
# Search a region
_core/skills/real-estate/re redfin search "Austin, TX" --max-price 700000 --min-beds 3 --num-homes 50
_core/skills/real-estate/re zillow search "Austin, TX" --max-price 700000 --min-beds 3

# Search with property-type filter (Redfin)
_core/skills/real-estate/re redfin search "Austin, TX" --home-types house,condo --max-price 700000

# Manual region override (skip Brave; useful when brave-search is unauthed)
_core/skills/real-estate/re redfin search "anything" --region-id 30818 --region-type 6 --max-price 700000

# Property details
_core/skills/real-estate/re redfin property "https://www.redfin.com/TX/Austin/.../home/<id>"
_core/skills/real-estate/re zillow property "https://www.zillow.com/homedetails/.../<zpid>_zpid/"

# Property details + full nested API payloads
_core/skills/real-estate/re redfin property "<url>" --include-raw

# Just the price + listing history (Redfin)
_core/skills/real-estate/re redfin history "<redfin-url>"

# Comparable / similar listings (Redfin)
_core/skills/real-estate/re redfin comps "<redfin-url>"

# Resolve a free-text query into a Redfin region (no listing fetch)
_core/skills/real-estate/re redfin resolve "78704"
```

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
- Zillow (PerimeterX): only `chrome124` impersonation works as of April 2026. If Zillow returns 403 with "px-captcha" in the body, the profile likely needs bumping; check the fix list at https://github.com/lexiforest/curl-cffi/releases.

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

`property` returns flattened key fields plus full nested `raw` if `--include-raw`. Includes `history`, `tax_history`, `schools`, `risk_factors`, `comps` (Redfin), `zestimate`/`rent_zestimate` (Zillow when present).

## Notes

- This skill is the primary path for house-research queries. There's no workspace shape because the work is on-demand and query-driven, not stream-ingested.
- If/when free scraping breaks for good, the documented fallback is the Apify Zillow/Redfin scrapers (paid). Don't pre-emptively switch; only switch when this stops working.
- The `re` wrapper auto-locates the skill directory and uses the local `uv` env, so it works from any cwd.

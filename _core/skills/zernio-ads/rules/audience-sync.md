# Audience sync

Custom audiences send personally identifiable information (PII) to Meta (and TikTok/Pinterest where supported). This rules file is non-negotiable - audience-sync is gated by LAUNCH-AD AND has additional handling rules below.

## Plaintext, not hashed

Send PII PLAINTEXT in the request body. Zernio SHA-256-hashes server-side per each platform's normalization spec. Do NOT:
- Pre-hash before sending - that produces double-hashed values that fail to match.
- Lowercase, trim, or normalize before sending - Zernio handles per-platform rules (Gmail's dot/plus-suffix stripping for Google, etc.).
- Strip dial codes from phone numbers (Zernio handles E.164 conversion).

## 10,000 row cap per request

Both `create-audience` (when an initial `users[]` is supplied) and `add-audience-users` cap at 10,000 rows per request. The local script enforces it. To sync more, chunk into batches of <=10,000 and call repeatedly. There is no rate limit penalty for sequential calls.

## Lookalikes need a seed and a country

Lookalike audiences (`type: "lookalike"`) require:
- `seedAudienceId` - an existing customer-list or website-retargeting audience ID with enough rows to satisfy Meta's minimum (Meta typically requires 100+ matched users in the seed).
- `country` codes - ISO 3166-1 alpha-2.
- `ratio` - 1-10. Percentage of the target country's population. Lower = more similar to seed, smaller reach. Higher = broader, less similar.

Surface the resulting estimated reach if Meta returns it in the response.

## Special-category compliance

If the audience or downstream ad targets housing, employment, credit, or political content:
- Set `specialAdCategories` on every ad that uses this audience.
- Some targeting fields (age, location specificity, gender) get clamped by Meta automatically.
- Do NOT silently strip restricted fields - return Meta's 422 error to the user so they can adjust.

## Delete is visible

`delete-audience` removes the audience on Meta and locally. Any active campaign or ad set referencing it loses its audience target on Meta's next sync, which can dramatically change delivery. Before deleting, run `list-campaigns` and surface any active campaigns referencing the audience. Ask the user to pause those first.

## Privacy

- Local payload files written to `output/zernio-ads-payload-[ts].json` contain plaintext PII. Save them under `~/.zernio/output/` (gitignored), never inside `raw/` or `graphify-out/`. Treat them as sensitive: do not include audience contents in chat summaries beyond row counts.
- After a successful sync, optionally delete the payload file to minimize on-disk PII. Ask the user before deleting.
- `raw/` is the QUANTUM knowledge graph; PII payloads do NOT belong there. The skill never deposits audience files in `raw/`.

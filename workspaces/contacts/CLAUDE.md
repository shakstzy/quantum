# contacts

macOS Contacts ingest. One markdown file per Apple Contacts entry at `raw/contacts/<slug>.md`. Read-only mirror of the system contacts DB  -  never written back to. Manual humans not in Apple Contacts live in `workspaces/people/` instead.

## Layout

```
scripts/
  ingest.mjs               # JXA dump -> raw/contacts/<slug>.md (idempotent, full rewrite each run)
  classify.mjs             # tags entries category=person|business|noise based on heuristics
  pull.sh                  # cron wrapper
setup/
  com.shakstzy.quantum-contacts.plist
```

## How it runs

Daily 4am via launchd plist. The ingest is idempotent and atomic per-file: each rescrape rewrites the entity file fully. Body sections (`## Notes`) are preserved across rescrapes  -  only frontmatter + the auto-managed sections get rewritten.

## Schema

```markdown
---
slug: caroline-smith
first_name: Caroline
last_name: Smith
full_name: "Caroline Smith"
phones: ["+15125551234", "+18475557890"]
emails: ["caroline@example.com"]
organization: "Acme"
birthday: "1998-03-15"
addresses: ["123 Main St, Austin, TX 78701, USA"]
ic_id: "ABCDE-12345-XYZ"        # Apple Contacts UID, stable across renames
category: person                  # person | business | noise
tags: []
first_seen: 2026-04-28T...
last_seen: 2026-04-28T...
previous_slugs: []
---

## Notes

(user-editable; preserved across rescrapes)

## Source mirror

(auto-generated; reflects current macOS Contacts state — do not edit)
- raw_phones: ["(512) 555-1234", "847-555-7890"]   # original, pre-canonicalization
- raw_emails: ["Caroline@Example.COM"]
- last_modified: 2026-04-28T...
```

## Slug rule

- `<first>-<last>` if both present (lowercase, kebab-case, ASCII-only)
- `<first>-<last4-of-primary-phone>` if no last name (e.g. `gym-7298`)
- `unnamed-<last4-of-primary-phone>` if no name at all
- Collisions get `-2`, `-3`, etc. (very rare given full-name + phone disambiguation)
- `ic_id` (Apple's UID) is the stable key across rescrapes; if a slug would change because the user edited the contact, the old slug goes into `previous_slugs[]`.

## Canonicalization (per QUANTUM root rules)

- Phones: E.164 (+CountryCode + digits, no spaces/parens/dashes). US numbers without country code get `+1` prefixed.
- Emails: lowercase + trimmed.
- Names: trimmed, no leading/trailing whitespace; case preserved.

Original (un-canonicalized) values are kept in the `## Source mirror` section so we never lose fidelity.

## Classification (category)

`classify.mjs` runs after ingest. Default is `person`. Heuristics that flip to `business`:

- Name contains `Inc`, `LLC`, `Co.`, `Corp`, `Support`, `Service`, `Pharmacy`, `Bank`, `Insurance`, `Apple`, `Google`, etc.
- Name is single uppercase word + branded suffix
- Primary phone is a US shortcode (3-7 digits, no country code)
- Phone matches `1-800-MY-APPLE` style mnemonic
- Email domain is on a known business-blocklist (e.g. `noreply@`, `notifications@`)

Heuristics that flip to `noise`:

- Single-letter name with no other identifying fields
- Name is a duplicate of an existing person's number with no other context

User can manually override `category` in frontmatter; classifier respects manual overrides on rescrape.

## Cross-workspace edges

No explicit `links:` array. Graphify draws edges automatically via shared canonical identifiers:

- `phones[]` E.164 values match `raw/tinder/<slug>.md`'s `phone` field -> tinder match link
- `phones[]` E.164 values appear as participants in `raw/imessage/YYYY-MM.ndjson` -> iMessage thread link
- `emails[]` match `raw/email/...` from-fields -> email link
- `slug` is referenced via `[[<slug>]]` wikilinks in `raw/journal/...` or other workspaces -> manual cross-references

This is the ground rule from QUANTUM root CLAUDE.md ("edges form via shared identifier values, not explicit links arrays").

## Triggers

- `pull` -> `bash scripts/pull.sh` (calls ingest.mjs then classify.mjs)
- Cron: daily 4am via launchd

## Related workspaces

- `workspaces/people/`  -  manual humans not in Apple Contacts. Same slug shape, different source. Graphify merges entries with overlapping identifiers.
- `workspaces/tinder/`  -  phone matches in tinder entities trigger automatic graph edges to contacts entries here.
- `workspaces/imessage/`  -  phone-keyed message history; phones in contacts here become discoverable via the canonical E.164 form.

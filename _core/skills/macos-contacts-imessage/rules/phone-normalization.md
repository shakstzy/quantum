# Phone Normalization

Every phone number passed to `contacts.sh` or `imessage.sh` MUST be normalized to E.164 before the script is invoked. E.164 is `+<country><digits>`, no spaces, no punctuation, max 15 digits.

Default region is **US (`+1`)** unless the caller explicitly specifies another country code.

## Rules

Apply in order. First match wins.

1. **Already E.164.** If the input starts with `+` followed by digits only, accept as-is.
2. **Strip non-digits.** Remove spaces, parens, dashes, dots. Example: `(512) 555-0199` -> `5125550199`.
3. **11 digits starting with 1.** Prepend `+`. Example: `15125550199` -> `+15125550199`.
4. **10 digits.** Prepend `+1`. Example: `5125550199` -> `+15125550199`.
5. **Anything else** (9 or fewer digits, 12+ digits without `+`, alpha characters, etc.): **stop and ask**. Do not guess a country code.

## Why E.164

- iMessage and the `buddy` AppleScript lookup key off E.164 internally. `5125550199` may match against `+15125550199` some of the time via Apple heuristics, but it is not guaranteed, and SMS via Continuity fails silently on non-E.164.
- chat.db stores handle identifiers as E.164 for phones (or as full email for Apple IDs). Querying `history` by non-E.164 gets partial hits only via the LIKE `%...%` fuzz.

## Emails

Pass-through. No normalization. Case-preserved (Apple IDs are case-insensitive at lookup time but displayed as stored).

## Non-US callers

If the caller explicitly says "this is a UK number" or passes `--region GB`, apply that region's code instead of `+1`. The skill does NOT currently autodetect region. Ambiguous input (e.g., `5125550199` for a non-US user) should prompt clarification, not guess.

## Testing the normalization

```bash
# These should all produce +15125550199
echo "(512) 555-0199"    # -> +15125550199
echo "512-555-0199"      # -> +15125550199
echo "512.555.0199"      # -> +15125550199
echo "5125550199"        # -> +15125550199
echo "15125550199"       # -> +15125550199
echo "+15125550199"      # -> +15125550199
```

The normalization is currently caller-side (the scripts expect a clean E.164 in `--phone`). If a future version adds an internal normalizer, it lives in `scripts/normalize-phone.sh` and both `contacts.sh` and `imessage.sh` source it.

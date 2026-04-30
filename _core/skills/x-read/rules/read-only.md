# Read-only contract

This skill is read-only. The implementation enforces this at multiple layers.

## Enforcement

1. **Helper layer (`browser.mjs::pageApi`)** — accepts ONLY `method = "GET"`. Any other value throws `E_METHOD_NOT_ALLOWED`. Test before merge.
2. **Verb layer (`run.mjs`)** — exposes only `login`, `whoami`, `thread`, `status`, `reset-breaker`. No verbs that mutate user state. There is no generic `call` verb that could pass arbitrary HTTP methods through.
3. **No write helpers** — no `postTweet`, no `like`, no `follow`, no `dm`, no `bookmark`. These are not deferred; they are explicitly out of scope for this skill forever.

## Why a separate skill for writes

Writes belong to Zernio (`_core/skills/zernio-post/` with `platform: "twitter"`) where the tweet is published via a managed pipeline with its own confirmation gate, AI-disclosure flags, and audit trail. Mixing read primitives with raw write primitives in one skill is how confused-deputy bugs happen.

## What "read-only" means in practice

We do navigate the browser, which means Chrome itself emits requests (telemetry, prefetch, service-worker calls). We can't and don't try to stop X's own client from emitting requests during a page load. What we promise:

- Our explicit replay layer issues only GET requests.
- We never call any GraphQL mutation operation (`Create*`, `Delete*`, `Favorite*`, `Follow*`, etc.) — these are POSTs and would fail at the GET-only gate even if a verb tried.
- We never type into composers or click action buttons.

## If a future caller wants a write primitive

Don't add it here. Either route through `zernio-post`, or open a new skill `_core/skills/x-write/` with its own independent confirmation gate + ToS warning. This skill stays read-only.

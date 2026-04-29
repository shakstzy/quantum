# 05-ship

Publish the finished edits via the existing zernio-post skill. Mandatory PUBLISH gate.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|---------------|---------------|-----|
| Edits | `~/.quantum/ad-factory/edits/<product-slug>/*.mp4` | Full | Files to upload |
| Host social handles | `../../shared/hosts/<host-id>/persona.md` | IG handle, TikTok handle | Account targeting |
| Brief | `inbox/<product-slug>/brief.md` | caption template, hashtags, link | Post body |
| Zernio-post skill | `_core/skills/zernio-post/SKILL.md` | Procedure, confirmation gate | The actual publish |

## Process

1. Verify host has not already shipped this product (check `../../shared/hosts/<host-id>/ship-log.md`). If yes, abort.
2. Build per-platform payloads:
   - IG Reel: `9x16.mp4`, caption from brief, hashtags from research, hashtags + brand mentions.
   - TikTok: `9x16.mp4`, caption, hashtags. Confirm `privacyLevels` and `creator-info` precheck per zernio-post skill.
   - (YouTube Shorts optional v2.)
3. Run zernio-post skill via direct REST: `bash /Users/shakstzy/QUANTUM/_core/skills/zernio-post/scripts/zernio.sh ...`.
4. PUBLISH gate: present full assembled payload; require literal `PUBLISH` from operator. No env override in v1.
5. Capture post IDs and URLs.
6. Append entry to `../../shared/hosts/<host-id>/ship-log.md`: `<date> | <product-slug> | <platform>:<post-url> | clip-count`.
7. Write `output/<product-slug>-shipped.md` with all post URLs and timestamps.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Ship record | `output/<product-slug>-shipped.md` | Markdown: platform, account, post URL, ship time, payload digest |
| Host ship log entry | `../../shared/hosts/<host-id>/ship-log.md` (appended) | Markdown row |

## Audit

- PUBLISH token was provided literally
- All target post URLs are reachable (HEAD 200 within 30s of publish)
- Host ship-log.md was appended (one row per platform shipped)
- No duplicate ship: same host + same product = abort

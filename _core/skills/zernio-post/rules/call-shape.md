# Required Caller Inputs

The skill refuses to run if any required field is missing. This is the function signature.

## Required for every post

| Field | Type | Notes |
|-------|------|-------|
| `targets` | array of `{platform, account_alias}` | `platform` is `instagram`, `youtube`, `tiktok`, or `twitter`. `account_alias` is a human alias mapped in `~/.zernio/accounts.yaml` (e.g. `my-ig`). |
| `media` | array of local file paths | Each path must exist, be non-empty, and match a MIME supported by every target platform. See `preflight.md`. |
| `caption` | string | Feed caption or video description. Platform-specific length caps enforced in preflight. |
| `mode` | `publish` or `schedule` | Default `publish` if unspecified. `schedule` requires an explicit `scheduled_at_utc`. Phrases "publish now", "post this", "drop this" imply `publish`; phrases "schedule for", "queue for", "at 9am tomorrow" imply `schedule` and still require the timestamp. |

## Required only when `mode=schedule`

| Field | Type | Notes |
|-------|------|-------|
| `scheduled_at_utc` | ISO-8601 string in UTC | Caller is responsible for converting from local timezone. QUANTUM default is CST; skill does not auto-convert. |

## Required only when platform is `instagram`

| Field | Type | Notes |
|-------|------|-------|
| `instagram.content_type` | `feed`, `carousel`, `story`, or `reels` | Determines `platformSpecificData.contentType`. `feed` is default (empty contentType). |
| `instagram.share_to_feed` | bool | Reels only. If true, Reel also shows on feed. |

## Required only when platform is `youtube`

| Field | Type | Notes |
|-------|------|-------|
| `youtube.title` | string, max 100 chars | YouTube requires this. No derivation from caption. |
| `youtube.visibility` | `public`, `unlisted`, or `private` | Explicit. No default. |
| `youtube.category_id` | string | See `references/youtube.md` for the enum. Default `22` (People and Blogs) is acceptable only if caller passes it explicitly. |
| `youtube.made_for_kids` | bool | PERMANENT ONCE SET TRUE. Must be explicit. See `references/youtube.md`. |

## Required only when platform is `tiktok`

| Field | Type | Notes |
|-------|------|-------|
| `tiktok.privacy_level` | enum | One of `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY`. MUST be validated against `creator-info` response before posting. |
| `tiktok.allow_comment` | bool | Required by TikTok. No default. |
| `tiktok.content_preview_confirmed` | bool | Required legal flag per TikTok API. Caller sets after review. |
| `tiktok.express_consent_given` | bool | Required legal flag per TikTok API. Caller sets after review. |

## Optional AI-disclosure flags (caller sets, skill does not default)

| Field | Type | Notes |
|-------|------|-------|
| `youtube.contains_synthetic_media` | bool | Set true if the video contains realistic AI-generated content. See `ai-disclosure.md`. |
| `tiktok.video_made_with_ai` | bool | TikTok AIGC label. Set true if content is AI-generated. See `ai-disclosure.md`. |

## Rejection examples

- YouTube target without `title`: stop. Do not derive from caption.
- TikTok target without `privacy_level`: stop. Do not default to `SELF_ONLY` silently.
- TikTok target without `content_preview_confirmed` or `express_consent_given`: stop. These are legal flags required by TikTok; the skill never defaults them true.
- Missing `account_alias` resolution: stop and list available aliases from `~/.zernio/accounts.yaml`. Accept common natural-language forms: "my ig", "my instagram", "my personal ig" all normalize to `my-ig`; "my yt", "my youtube" to `my-youtube`; "my tiktok", "my tt" to `my-tiktok`.
- `mode=schedule` without `scheduled_at_utc`: stop. Ask for a UTC timestamp (caller converts from CST).

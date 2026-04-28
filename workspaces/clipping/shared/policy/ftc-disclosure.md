# FTC Disclosure Policy

Per Adv Review v1 + Business Insider 2026 reporting on FTC clipping enforcement:
paid clipper campaigns are compensated endorsements. Disclosure is legally required.

## When disclosure is required

Any post that meets ALL three of these:

1. The clipper expects compensation (campaign_id is set on the publish_attempt).
2. The post promotes a product, brand, person, or service.
3. The audience would not reasonably know the connection.

If all three are true: disclosure REQUIRED.

For a faceless clip page reposting a creator's content for that creator's bounty, criteria 2 and 3 typically fire: the clip is itself promotional of the creator, and the audience does not know there is a paid relationship.

## How to disclose (per platform)

| Platform | Required tag |
|----------|--------------|
| TikTok | Use the in-app "Branded Content" toggle (we do this via `zernio-post` payload `disclose=true`) AND add `#ad` or `#paidpartnership` in caption |
| Instagram Reels | Use "Paid partnership with @<advertiser>" via Branded Content tools (zernio-post field) AND `#ad` in caption |
| YouTube Shorts | Tick the "video contains paid promotion" box in upload (zernio-post `paidPromotion=true`) AND mention "sponsored" or `#ad` in description |

We never rely on caption-only disclosure. Always set the platform-native flag too.

## Implementation in pipeline

`bot/src/gate.py` `disclosure_check`:

```
def disclosure_check(candidate, target_account):
    campaign = db.get_campaign(candidate.campaign_id)
    if campaign is None:
        return True  # not paid; no disclosure needed
    caption = candidate.caption or ""
    if not re.search(r"#ad\b|#paidpartnership\b|#sponsored\b", caption, re.I):
        return False
    if target_account.platform == "tiktok" and not candidate.tiktok_branded_content:
        return False
    if target_account.platform == "instagram" and not candidate.ig_branded_content:
        return False
    if target_account.platform == "youtube" and not candidate.yt_paid_promotion:
        return False
    return True
```

## Caption template

`shared/prompts/caption.md` enforces this in generation:

```
{HOOK_TEXT}

#ad #{NICHE_TAG} {OTHER_HASHTAGS}
```

The `#ad` is the floor. `#sponsored` and `#paidpartnership` are accepted alternatives.
A caption that fails the regex is auto-rewritten by the caption generator before persistence.

## When in doubt, disclose

Adv Review v1 cited FTC enforcement risk specifically for paid clipping. We default to over-disclosure.
A non-paid creator-fund post still gets `#ad` if it is part of a campaign tracking link.

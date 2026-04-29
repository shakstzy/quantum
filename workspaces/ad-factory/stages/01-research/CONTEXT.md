# 01-research

Scrape top 50 IG + TikTok videos in the product's niche, multimodal-analyze with Gemma, drop the mp4s, keep the learnings.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|---------------|---------------|-----|
| Brief | `inbox/<product-slug>/brief.md` | niche, hashtags, target audience | Drives query |
| Browser-automation skill | `_core/skills/browser-automation/SKILL.md` | Decision matrix: pick patchright | Stealth scrape IG + TikTok |
| Local LLM skill | `_core/skills/local-llm/SKILL.md` | client.py + image_block | Multimodal analysis on each clip |

## Process

1. Read `inbox/<product-slug>/brief.md`. Extract niche keywords + hashtags.
2. For each platform (IG, TikTok), via patchright:
   - Search hashtag feed.
   - Collect top 25 videos by view count.
   - Download mp4 + caption + likes + comments + post date to `~/.quantum/ad-factory/scrape-tmp/<product-slug>/<platform>-<id>.{mp4,json}`.
3. For each scraped video:
   - Sample 3-5 frames (start, mid, end-of-hook).
   - Build a Gemma multimodal prompt: frames + caption + likes/views ratio + comments sample.
   - Ask Gemma: hook structure (first 2s), angle (problem/solution/testimonial/demo/skeptic-flip/...), proof element, CTA pattern, host archetype (gender, age vibe, energy), shot list.
4. Aggregate the 50 Gemma reports into a synthesis: top 5 angles, top 3 hooks, common proof elements, common CTAs, archetype distribution.
5. Write `output/<product-slug>-research.md`.
6. Delete `~/.quantum/ad-factory/scrape-tmp/<product-slug>/`.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| Research synthesis | `output/<product-slug>-research.md` | Markdown sections: Hashtags / Top Angles / Top Hooks / Proof Patterns / CTA Patterns / Archetype Distribution / Sample Quotes |

## Audit

- 50 videos analyzed, or operator confirmed lower count
- `~/.quantum/ad-factory/scrape-tmp/<product-slug>/` is empty after run
- No mp4s leaked into `output/` or repo
- No host PII or session cookies in the synthesis file

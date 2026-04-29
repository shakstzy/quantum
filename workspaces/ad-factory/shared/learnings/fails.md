# Fails learnings

Rewritten by stage 07-learn. Patterns that consistently tank.

## Top fail patterns (last 30d)

(no data yet)

## Known failure modes from source-video analysis (2026-04-28, seed)

- Cutting off mid-sentence at clip boundary (Seedance compresses to 15s and chops audio): fix in 02-script by capping at 4 lines per clip
- Host and guest avatars drifting between clips: fix in 03-render by feeding consistent reference images
- Too much filler ("mhm", reaching for product): fix in 04-edit by trimming
- Wrong actor saying the wrong line (Claude swaps host/guest by accident): fix in 02-script by validating role tags before render

# ad-factory Onboarding Questionnaire

System-level configuration. Per-run details are collected at run start, not here. Pattern 8: ask once, never again.

Adithya's answers (2026-04-28) are baked in below.

---

### Q1: Workspace name
- Answer: `ad-factory`

### Q2: One-sentence purpose
- Answer: Self-improving AI UGC ad pipeline that researches niche winners, writes scripts, renders via Higgsfield, edits, ships, and learns from performance.

### Q3: Workspace type
- Answer: workflow (multi-stage, stateful, no `raw/<ws>/`)

### Q4: Render engine
- Answer: Higgsfield Marketing Studio (UGC preset) via existing `_core/skills/higgsfield/` skill. SDK is NOT used. Browser automation only.

### Q5: Viral research source
- Answer: Instagram + TikTok by hashtag, scraped via patchright (browser-automation skill). Analyzed locally by Gemma (local-llm skill). No paid services (no Apify, no Foreplay, no Minea).

### Q6: Scrape volume per niche per run
- Answer: top 50 videos

### Q7: Scrape cadence
- Answer: per-product (run when a new product enters inbox)

### Q8: Archive policy for scraped mp4s
- Answer: keep learnings only. Delete mp4s after Gemma writes the analysis.

### Q9: Output spec per ad
- Answer: 1 hero edit + 9x16 cut + 1x1 cut. NO platform-specific outputs.

### Q10: Intake mode
- Answer: CLI primary (`bash scripts/cli.sh new <product-slug>`). Folder-drop fallback (drop a `brief.md` into `inbox/<slug>/`).

### Q11: Host library
- Answer: yes. Persistent AI hosts under `shared/hosts/<topic>-<n>/`. One niche per host. Each host has persona.md, look.md, voice.md, reference-images/, ship-log.md, performance.md.

### Q12: Host count v1
- Answer: 0 hosts seeded. Hosts are added on-demand via `bash scripts/cli.sh host-new <topic> <handle>` when a topic is being run. Speculative seeding is forbidden.

### Q13: Host social handles
- Answer: yes, real handles. Each host's `persona.md` tracks the IG/TikTok handle they post from. Same host cannot post the same product twice.

### Q14: Voice synthesis
- Answer: Higgsfield default voice (per render). ElevenLabs upgrade hook reserved for v2.

### Q15: Look consistency
- Answer: anchor each host to a single seed reference image fed into every Higgsfield render. Higgsfield Soul ID is a v2 upgrade.

### Q16: Performance metrics source
- Answer: scrape own posts at 24h / 7d / 30d marks via patchright using each host's profile. Manual-entry fallback in `performance.md`.

### Q17: Winner definition
- Answer: views > 5x the host's median for that host's first 30 ads. Calibrated upward as the host matures.

### Q18: Learning use
- Answer: lightweight v1. Stage 02-script reads `shared/learnings/*.md` as context at script time. Heavyweight prompt rewrites reserved for v2 (>30 ads shipped).

### Q19: Negative learnings (host retirement)
- Answer: agent flags underperforming hosts in stage 07-learn output with `WARN: host <id> below 20% of niche median over last 10 ads`. Only Adithya retires.

### Q20: Claim review
- Answer: skip. Adithya picks his own niches; no FTC-sensitive niches by policy (no supplements, no health, no finance).

### Q21: Client portal
- Answer: skip. This is for Adithya's own products only.

### Q22: Ship gate
- Answer: literal `PUBLISH` token via existing `_core/skills/zernio-post/` confirmation gate. Mandatory.

### Q23: Edit engine
- Answer: ffmpeg primary. Remotion (existing skill at `_core/skills/remotion/`) reserved as v2 upgrade for word-by-word captions.

### Q24: Automation
- Answer: none. All triggers manual.

---

## After Onboarding

Run `python3 _core/skills/icm-audit/scripts/audit.py` to confirm structural compliance. Verify zero `{{` patterns remain.

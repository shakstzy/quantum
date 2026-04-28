# 05-qa

Apply pre-publish gate. Surface for human approval. Persist `qa_reviews` decision.

## Inputs

| Source | File/Location | Section/Scope | Why |
|--------|--------------|---------------|-----|
| Rendered candidate | DB `clip_candidates` where status='rendered' | Full row | Subject |
| Render artifact | from `renders.filepath` | Full file | Visual sanity check |
| Pre-publish gate | `shared/policy/pre-publish-gate.md` | Full file | The contract |
| FTC rules | `shared/policy/ftc-disclosure.md` | Full file | Disclosure required when paid |
| Platform risks | `shared/policy/platform-risks.md` | Full file | Per-platform safety check |

## Process

1. Run `bot/src/gate.py` against the candidate. The gate computes:
   - `rights_check`: source `rights_status` is not `unauthorized`.
   - `disclosure_check`: caption includes required disclosure for paid campaigns.
   - `originality_check`: candidate has at least one transformative element (commentary, hook overlay, custom captions).
   - `duplicate_check`: `duplicate_score < 0.5`.
   - `account_fit_check`: target accounts' niche matches campaign niche.
   - `campaign_fit_check`: clip falls within campaign rules (length, content, language, region).
   - `platform_risk_score`: 0-100 per platform; flags banned-niche keywords, copyright-risky audio, etc.
2. If ALL checks pass and `platform_risk_score < 30` for at least one target platform: write `qa_reviews` with `decision='approve'` and the candidate moves to `status='qa_approved'`.
3. If any check fails: write `qa_reviews` with `decision='reject'` and a structured `reasons` field. Candidate moves to `status='qa_rejected'`.
4. Optional: invoke `_core/skills/local-llm/` (Gemma) for a second-opinion review of caption quality and hook strength. Save the LLM verdict to `qa_reviews.reasons` regardless of pass/fail.
5. Surface ALL rejections to human in `~/.quantum/clipping/logs/qa-YYYY-MM-DD.md` with one row per rejected candidate explaining what to fix.

## Outputs

| Artifact | Location | Format |
|----------|----------|--------|
| QA review row | DB | SQLite |
| Daily QA log | `~/.quantum/clipping/logs/qa-YYYY-MM-DD.md` | Markdown |
| Approved-pre-publish copy | `~/.quantum/clipping/approved/<candidate-id>.mp4` (symlink) | mp4 |

## Audit

- [ ] No candidate moved to `qa_approved` with any failing check.
- [ ] Every approved candidate has caption text that includes required disclosure (when paid).
- [ ] Rejections always have a human-readable `reasons` value.

## Hard Rules

1. The gate is mandatory. There is no human override that can flip a `reject` to `approve` without the underlying check turning green.
2. A single failing check is enough to reject. No "mostly green" exceptions.
3. Disclosure is a legal requirement for compensated bounty posts; never disable that check.

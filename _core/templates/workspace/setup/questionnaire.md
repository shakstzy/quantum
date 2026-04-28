# Onboarding Questionnaire

<!-- Agent instructions: Read this file when the user types "setup" OR when building a new workspace
     (Pattern 17 in `_core/CONVENTIONS.md` mandates auto-run on creation). Ask ALL questions in a
     single conversational pass. The user should be able to answer everything in one message.
     Collect answers. Replace placeholders across the specified files. After all replacements,
     verify no {{ patterns remain in the workspace. -->

<!-- Design rules:
     1. FLAT STRUCTURE
     2. ALL AT ONCE
     3. SYSTEM-LEVEL ONLY
     4. DERIVE, DO NOT ASK
     5. SENSIBLE DEFAULTS
     6. ASK ONCE, NEVER AGAIN
     7. EXAMPLES OVER DESCRIPTIONS -->

### Q1: Workspace name (lowercase-with-hyphens)
- Placeholder: `{{WORKSPACE_NAME}}`
- Files: `CLAUDE.md`
- Type: free text
- Default: (slug of folder name)

### Q2: One-sentence purpose
- Placeholder: `{{ONE_SENTENCE_PURPOSE}}`
- Files: `CLAUDE.md`
- Type: free text
- Example: "Pulls Slack DMs and channel history across Adithya's workspaces into `raw/slack/`."

### Q3: Purpose paragraph (3-5 sentences: source, what lands, why)
- Placeholder: `{{PURPOSE_PARAGRAPH}}`
- Files: `CLAUDE.md`
- Type: free text

### Q4: Ingest source (the external system)
- Placeholder: `{{INGEST_SOURCE}}`
- Files: `CLAUDE.md`
- Type: free text
- Example: "Slack workspaces (3 of them) via xoxp user token", "Apple Health export via macOS share sheet", "Manual journal entries"

### Q5: Pull command (single canonical entrypoint)
- Placeholder: `{{PULL_COMMAND}}`
- Files: `CLAUDE.md`
- Type: free text
- Example: `bash scripts/pull.sh [days]`, `python3 scripts/pull.py --since-watermark`

### Q6: Pull script filename
- Placeholder: `{{PULL_SCRIPT}}`
- Files: `CLAUDE.md`
- Type: free text
- Default: `pull.sh`

### Q7: Output path pattern
- Placeholder: `{{OUTPUT_PATH_PATTERN}}`
- Files: `CLAUDE.md`
- Type: free text
- Default: `YYYY-MM-DD-<slug>.json`
- Example: `YYYY-MM-DD-<channel>.ndjson`, `YYYY-MM.ndjson` (sharded), `YYYY-MM-DD-<account-slug>.json`

### Q8: Slug rule (how `<slug>` is derived)
- Placeholder: `{{SLUG_RULE}}`
- Files: `CLAUDE.md`
- Type: free text
- Example: "account local-part with dots -> hyphens", "channel name lowercased", "ISO date only"

### Q9: Output format
- Placeholder: `{{OUTPUT_FORMAT}}`
- Files: `CLAUDE.md`
- Type: selection
- Options: JSON, NDJSON, Markdown, JSONL, CSV, Parquet, Mixed (specify)

### Q10: Dedupe key (how to detect duplicate records on re-pull)
- Placeholder: `{{DEDUPE_KEY}}`
- Files: `CLAUDE.md`
- Type: free text
- Example: "Slack message `ts` field", "Gmail `Message-ID` header", "Journal entry filename"

### Q11: Is the pull automated via launchd?
- Type: yes/no
- If NO: remove the `{{?AUTOMATED_PULL}}` ... `{{/AUTOMATED_PULL}}` section. Set `{{PULL_AUTOMATION}}` to `manual only`.
- If YES: collect Q12-Q14.

### Q12: launchd plist label (yes-Q11 only)
- Placeholder: `{{PULL_LAUNCHD_LABEL}}`
- Files: `CLAUDE.md`
- Type: free text
- Default: `com.shakstzy.quantum-{{WORKSPACE_NAME}}-pull`

### Q13: Pull frequency (yes-Q11 only)
- Placeholder: `{{PULL_FREQUENCY}}`
- Files: `CLAUDE.md`
- Type: free text
- Example: "every 60 minutes", "every 6 hours", "daily at 03:00 CST"

### Q14: Run at load? (yes-Q11 only)
- Placeholder: `{{PULL_RUN_AT_LOAD}}`
- Files: `CLAUDE.md`
- Type: yes/no
- Default: no

### Q15: Is there a corresponding skill for external mutations on this domain?
- Type: yes/no
- If NO: remove the `{{?SKILL_REFERENCED}}` ... `{{/SKILL_REFERENCED}}` section. Set `{{MUTATION_POINTER}}` to `none, read-only`.
- If YES: collect Q16. Set `{{MUTATION_POINTER}}` to `skill at \`_core/skills/{{SKILL_NAME}}/SKILL.md\``.

### Q16: Skill name (yes-Q15 only)
- Placeholder: `{{SKILL_NAME}}`
- Files: `CLAUDE.md`
- Type: free text
- Example: `slack`, `google-workspace`, `macos-contacts-imessage`

### Q17: Additional workspace-specific conventions (anything else worth recording)
- Placeholder: `{{ADDITIONAL_CONVENTIONS}}`
- Files: `CLAUDE.md`
- Type: free text
- Default: `(none)`

### Q18: Auto-derived: derive `{{PULL_AUTOMATION}}` for the Ingest section
- Placeholder: `{{PULL_AUTOMATION}}`
- Files: `CLAUDE.md`
- Derivation: if Q11=yes, set to `launchd plist {{PULL_LAUNCHD_LABEL}} runs {{PULL_FREQUENCY}}`. If Q11=no, set to `manual only`.

---

## After Onboarding

After all replacements, scan the entire workspace for remaining `{{` patterns. If any remain, ask for the missing info. Then run `python3 _core/playbooks/icm-audit/scripts/audit.py` to confirm structural compliance.

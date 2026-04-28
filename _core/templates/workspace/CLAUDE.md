# {{WORKSPACE_NAME}}

{{ONE_SENTENCE_PURPOSE}}

## Purpose

{{PURPOSE_PARAGRAPH}}

## Triggers

| Keyword | Action |
|---------|--------|
| `setup` | Re-run onboarding questionnaire (`setup/questionnaire.md`) |
| `status` | Show pipeline state (latest deposit timestamp + file count in `raw/{{WORKSPACE_NAME}}/`) |
| `pull` | `{{PULL_COMMAND}}` |

## Layout

```
workspaces/{{WORKSPACE_NAME}}/
├── CLAUDE.md              (this file)
├── setup/
│   └── questionnaire.md
└── scripts/
    └── {{PULL_SCRIPT}}
```

## Ingest

- **Source:** {{INGEST_SOURCE}}
- **Trigger:** `pull` -> `{{PULL_COMMAND}}`
- **Automation:** {{PULL_AUTOMATION}}
- **Output path:** `raw/{{WORKSPACE_NAME}}/{{OUTPUT_PATH_PATTERN}}`
- **Slug rule:** {{SLUG_RULE}}
- **Format:** {{OUTPUT_FORMAT}}
- **Mutations:** {{MUTATION_POINTER}}

## Conventions

- **Dedupe key:** {{DEDUPE_KEY}}
- **Watermark file:** `raw/.ingest-log/{{WORKSPACE_NAME}}.json` (last successful pull cursor)
- **Error log:** `raw/.ingest-log/{{WORKSPACE_NAME}}.errors.log`
- Never edit files in `raw/{{WORKSPACE_NAME}}/`. Re-run `pull` instead.
- {{ADDITIONAL_CONVENTIONS}}

{{?AUTOMATED_PULL}}

## Cadence

- **launchd plist:** `~/Library/LaunchAgents/{{PULL_LAUNCHD_LABEL}}.plist`
- **Frequency:** {{PULL_FREQUENCY}}
- **Log path:** `~/.quantum/logs/{{WORKSPACE_NAME}}-pull.log`
- **RunAtLoad:** {{PULL_RUN_AT_LOAD}}

{{/AUTOMATED_PULL}}

{{?SKILL_REFERENCED}}

## External Mutations (skill pointer)

For send / write / modify operations on this domain, use the skill at `_core/skills/{{SKILL_NAME}}/SKILL.md`. The workspace itself is read-only ingest.

{{/SKILL_REFERENCED}}

# Placeholder Syntax

How the onboarding system works in QUANTUM. Workspaces ship with placeholder variables in their markdown files. The onboarding agent replaces these with real content when a user runs `setup` (or when the agent auto-runs setup per Pattern 17 in `CONVENTIONS.md`).

---

## Basic Syntax

Placeholders use double braces and SCREAMING_SNAKE_CASE:

```
{{WORKSPACE_NAME}}
{{INGEST_SOURCE}}
{{PULL_FREQUENCY}}
```

These are literal strings in markdown files. They are not code variables. The onboarding agent finds them and replaces them with the user's answers through string substitution.

---

## Replacement Rules

1. The onboarding agent reads `setup/questionnaire.md` for the list of questions.
2. Each question maps to one or more placeholders.
3. Each question specifies which files contain its placeholder.
4. The agent asks the questions conversationally, collecting answers.
5. The agent replaces every instance of each placeholder with the corresponding answer.
6. After all replacements, the agent scans the entire workspace for any remaining `{{` patterns.
7. If any remain, the agent flags them and asks the user for the missing information.
8. Onboarding is complete only when zero placeholders remain.
9. The icm-audit skill flags leftover `{{` placeholders as a critical finding.

---

## Where Placeholders Can Appear

Placeholders can appear in any markdown file within a workspace:

- Workspace `CLAUDE.md` body sections (Purpose, Ingest, Conventions, Cadence)
- Stage `CONTEXT.md` Inputs table values (workflow workspaces)
- Reference files (`references/*.md`, `shared/*.md`, `rules/*.md`)
- Shared files

Placeholders should NOT appear in:

- The questionnaire.md itself (the questions are the source, not the target).
- Top-level routing tables that need to work before onboarding runs (folder map, trigger table, routing table headers).
- Anything in `_core/templates/` outside of the workspace template body.

---

## Conditional Sections

Conditional sections wrap content that gets removed if the user indicates it is not needed.

Syntax:

```markdown
{{?SECTION_NAME}}

## Section Heading

Content that may or may not be relevant...

{{/SECTION_NAME}}
```

**Rule: conditional blocks can only wrap entire sections.** A section means a heading and all content below it, up to the next heading of the same or higher level.

Valid:

```markdown
{{?AUTOMATED_PULL}}

## Cadence

- launchd plist: `com.shakstzy.quantum-<ws>-pull.plist`
- Frequency: every 60 minutes
- Log path: `~/.quantum/logs/<ws>-pull.log`

{{/AUTOMATED_PULL}}
```

Invalid:

```markdown
- Item one
{{?OPTIONAL_ITEM}}
- Item two (optional)
{{/OPTIONAL_ITEM}}
- Item three
```

Invalid:

```markdown
The cadence is {{?HOURLY}}every hour{{/HOURLY}}
{{?DAILY}}every day{{/DAILY}}.
```

Why this rule exists: removing inline content leaves orphaned list markers, broken sentences, or malformed markdown. Wrapping complete sections means removal always produces clean markdown.

---

## Naming Conventions

Use descriptive names: `{{WORKSPACE_NAME}}` not `{{WS}}`.

Group related placeholders with common prefixes:

- `{{INGEST_SOURCE}}`, `{{INGEST_AUTH}}`, `{{INGEST_FORMAT}}`
- `{{PULL_COMMAND}}`, `{{PULL_FREQUENCY}}`, `{{PULL_LAUNCHD_LABEL}}`
- `{{SLUG_RULE}}`, `{{SLUG_EXAMPLE}}`

Conditional section names should describe what they wrap:

- `{{?AUTOMATED_PULL}}` for the launchd cadence section
- `{{?SKILL_REFERENCED}}` for an external-mutations pointer section

---

## Questionnaire Mapping

The `setup/questionnaire.md` file is the bridge between questions and placeholders. Each question entry specifies:

- The question text (what the agent asks the user)
- The placeholder(s) it populates
- The file(s) where those placeholders appear
- The input type (free text, multiple choice, yes/no)
- Optional: follow-up questions for vague answers
- Optional: conditional logic (if answer is X, remove section Y)

See `_core/templates/workspace/setup/questionnaire.md` for the format.

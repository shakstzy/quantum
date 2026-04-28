---
name: gh
description: GitHub workflows from the terminal via the official `gh` CLI. Already authenticated as `shakstzy` (keyring, scopes: gist, read:org, repo, workflow). Use for opening PRs, reading issues/PRs/runs, commenting, releases, gist, and `gh api` for anything not covered by a verb. Do NOT use for git plumbing (use `git` directly), GitHub Apps installs, GitHub Actions runner provisioning, or org-admin actions outside the granted scopes.
---

# gh (GitHub CLI)

Trigger doc for routing Claude to `gh` when GitHub work shows up. Tool is already installed and authenticated. No custom script, no keychain plumbing — this skill exists so Claude knows *when* to reach for `gh` and which patterns to use.

## When this fires

Trigger phrases (semantic, non-exhaustive): "ship this", "ship this PR", "open a PR", "create a pull request", "draft a PR", "what PRs are open on <repo>", "merge this PR", "close this issue", "open an issue for X", "comment on PR <N>", "what's failing in CI", "rerun the failed run", "release notes for <tag>", "cut a release", "create a gist of this", "view the latest run on <repo>", "approve this PR", "request changes on PR <N>", "what did <user> ship recently".

Do NOT fire for:
- Pure git operations (commit, branch, rebase, push). Use `git` directly.
- GitHub Enterprise admin (audit log, SCIM, billing) outside the granted scopes.
- GitHub Apps install/manage flows (those need a different OAuth surface).
- Workflow file authoring beyond what `gh workflow run` can trigger.
- Anything on GitLab, Bitbucket, Codeberg, or self-hosted Gitea.

## Auth state (already set up)

- Authenticated as `shakstzy` via macOS keyring.
- Active scopes: `gist`, `read:org`, `repo`, `workflow`.
- Protocol: HTTPS.

If a verb 404s on a private repo, the most likely cause is missing scope (e.g. `admin:org`, `delete_repo`, `project`). Surface the scope ask back to Adithya — do NOT silently re-auth or rotate the token.

## Procedure

1. **Confirm target.** If the user named a repo by short name and you're outside its checkout, prefer `gh <verb> -R owner/repo`. If you're inside a repo checkout, `gh` infers the remote from `origin`.
2. **Read before write.** For any state-changing verb (PR create/merge/close, issue close, release create, gist create), first preview what's about to happen and surface the diff/title/body to Adithya.
3. **Gate visible writes.** PR merges, releases, comments on someone else's PR/issue, and force-push-equivalent actions (`pr edit --base`, repo rename, branch protection edits) require explicit Adithya confirmation in chat. PR open and gist create are fine without a gate.
4. **Execute.** Prefer the highest-level verb that fits. Fall through to `gh api` only when no verb covers it.
5. **Audit.** Run the Audit table below.

## Common patterns

| Intent | Command |
|--------|---------|
| Open a PR from current branch | `gh pr create --fill --web=false` (use HEREDOC body if rich) |
| Open a draft PR | `gh pr create --draft --fill` |
| List open PRs on current repo | `gh pr list --state open` |
| View a PR (incl. checks) | `gh pr view <N> --comments` then `gh pr checks <N>` |
| Diff a PR | `gh pr diff <N>` |
| Merge a PR (squash, default) | `gh pr merge <N> --squash --delete-branch` |
| Latest CI run for a branch | `gh run list --branch <name> --limit 5` |
| Watch a run live | `gh run watch <run-id>` |
| Rerun failed jobs | `gh run rerun <run-id> --failed` |
| Open issue | `gh issue create --title "..." --body "..."` (HEREDOC for body) |
| List your assigned issues | `gh issue list --assignee @me` |
| Cut a release | `gh release create <tag> --generate-notes` |
| Create a gist from a file | `gh gist create <file>` (private by default) |
| Anything not covered | `gh api repos/<owner>/<repo>/<endpoint>` |

For PR/issue/release **bodies**, always pass via HEREDOC to preserve newlines and avoid shell-escape issues:

```bash
gh pr create --title "feat: ..." --body "$(cat <<'EOF'
## Summary
- ...

## Test plan
- [ ] ...
EOF
)"
```

Per Adithya's global rules: never `--no-verify` on the underlying git commit, never force-push to `main`/`master`, never use destructive flags (`gh repo delete`, `gh pr close --delete-branch` on someone else's PR) without explicit confirmation.

## Audit (Pattern 12)

| Check | Pass condition |
|-------|----------------|
| Auth valid | `gh auth status` is clean for `github.com` and the user is `shakstzy` |
| Scope sufficient | Verb's required scope is covered (gist / read:org / repo / workflow). If 404 on private repo, ask for scope, do not silently rotate |
| Target unambiguous | `-R owner/repo` is set OR the working directory is inside the intended repo |
| Body preserved | PR/issue/release bodies passed via HEREDOC, fenced code and newlines intact |
| Write gate honored | PR merge / release / cross-user comments confirmed with Adithya before fire |
| No token leak | `gh` keychain token never echoed to chat or logs |

## Limits

- `gh` rate-limits piggyback on GitHub's REST/GraphQL limits. The CLI surfaces 403 with `X-RateLimit-Remaining: 0` clearly. Sleep until reset, do not tight-loop.
- `gh api --paginate` for large lists; default page is 30.
- Some org actions (require `admin:org`) will 404 silently with current scopes. Read the body of the response.

## Reference

- `gh help` for the verb tree. `gh <verb> --help` for flags.
- Authoritative reference: `https://cli.github.com/manual/`.

## Known limitations

- Single account (`shakstzy`). To add a work account, `gh auth login` again under a different host alias and pass `--hostname` per call.
- No GitHub Apps surface; `gh` is for the user-facing GitHub flow.
- Project (v2) verbs are partial; for complex project ops fall through to `gh api graphql`.

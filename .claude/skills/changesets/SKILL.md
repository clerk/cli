---
name: changesets
description: Create or refresh a `.changeset/<slug>.md` for the current branch, or report that none is required. Triggers on "/changesets create", "add a changeset", "create a changeset", "update the changeset", "refresh the changeset", "do I need a changeset", or any work that touches `packages/**` source files on a feature branch.
argument-hint: "create"
user-invocable: true
disable-model-invocation: false
effort: high
allowed-tools: Bash(git:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(bun changeset status:*), Bash(git add:*), Bash(git commit:*), Read, Write, Edit, Glob
---

# /changesets create

Decide whether the current branch needs a changeset, then either write one or
report that none is required. Full policy lives in
[references/policy.md](references/policy.md); this file is the decision flow
for the `create` subcommand.

## Subcommand

`create` is the only supported subcommand. Any other argument: report
unsupported and stop.

## Workflow

### 1. Resolve the branch and base

```sh
git rev-parse --abbrev-ref HEAD
git fetch origin main --quiet
git diff --name-only --diff-filter=ACMR origin/main...HEAD
```

If the current branch is `main`, stop and tell the user changesets are only
generated on feature branches.

### 2. Classify changed files

A path is **exempt** when it matches any of:

- `.github/**`
- `.changeset/**`
- `docs/**`
- `scripts/**`
- `.claude/**`
- Root dotfiles or docs at repo root: `.gitignore`, `CLAUDE.md`,
  `CONTRIBUTING.md`, `README.md`
- Test-only files inside packages: `packages/**/*.test.ts`,
  `packages/**/__tests__/**`

Anything else (notably non-test files under `packages/cli-core/src/**` or
`packages/cli/**`) is **non-exempt** and requires a changeset.

### 3. Branch on the result

**All files exempt:** run `bun changeset status --since=origin/main` to
confirm. Then report to the user, naming the exempt categories that matched,
and stop without writing a file. Do not create an empty changeset to "be
safe"; the policy forbids it.

**Some files non-exempt and `.changeset/<slug>.md` already exists for this
branch:** treat as a refresh. Read the existing file, then jump to step 5
with the existing slug.

**Some files non-exempt and no changeset file exists:** continue to step 4.

### 4. Pick the slug

Strip the conventional prefix from the branch name and kebab-case the rest.
Drop username segments (`wyattjoh/...`).

| Branch                    | Slug                  |
| ------------------------- | --------------------- |
| `feat/oauth-github`       | `oauth-github`        |
| `fix/login-redirect-loop` | `login-redirect-loop` |
| `wyattjoh/scripts-rules`  | `scripts-rules`       |

If `.changeset/<slug>.md` already exists on `main`, suffix with `-v2`,
`-followup`, or `-part-2`.

### 5. Decide the bump type

Read the cumulative branch diff (not just the latest commit), the PR title
and body if a PR exists (`gh pr view --json title,body 2>/dev/null`), and
recent commit subjects (`git log origin/main..HEAD --pretty=%s`).

| Intent                                                                                                  | Bump               |
| ------------------------------------------------------------------------------------------------------- | ------------------ |
| New user-facing feature, command, or flag                                                               | `minor`            |
| Bug fix, perf, internal refactor with no behavior change                                                | `patch`            |
| Breaking change (removed/renamed flag, incompatible behavior, `feat!`/`fix!`, `BREAKING CHANGE` footer) | `major`            |
| Mixed scope                                                                                             | highest applicable |

**Stop-and-ask gates.** Pause, do not write, and prompt the user when:

1. The classification would be `major`.
2. Intent is genuinely ambiguous (refactor that may change observable
   behavior; dependency bump with unclear downstream effect).
3. The branch is a revert without a stated motivation.

When the split between `minor` and `patch` is unclear but the change is
clearly non-breaking, default to `patch` and note the reasoning in the
response.

### 6. Author the summary

- Imperative-present tense ("Add X", "Fix Y", "Remove Z"). Never past tense.
- User-facing language; a CLI user reads this. No internal file paths, class
  names, or implementation details.
- One sentence ending in a period. Continuation lines only when the change
  genuinely needs more context (each becomes an indented sub-bullet).
- Authored independently from the PR title. The PR title describes the
  work; the summary describes the user-visible result.
- Do not include `(#123)` or `by @user`; `.changeset/changelog.js` appends
  PR, commit, and author links at version time.

### 7. Write the file

Path: `.changeset/<slug>.md`. Content:

```markdown
---
"clerk": <bump>
---

<summary>
```

Only `"clerk"` is valid. `@clerk/cli-core` is in the `ignore` list in
`.changeset/config.json` and must not appear.

Write the file directly with the Write tool. Do not run `bun changeset add`;
it is interactive and `--message` only pre-fills the summary.

### 8. Place the commit

Inspect the branch shape: `git log origin/main..HEAD --oneline | wc -l`.

| Branch shape  | Action                                                       |
| ------------- | ------------------------------------------------------------ |
| Single commit | Stage `.changeset/<slug>.md` and amend the existing commit.  |
| Multi-commit  | Create a new tip commit titled `docs(changeset): <summary>`. |

When refreshing an existing changeset on a multi-commit branch, amend the
existing tip `docs(changeset):` commit instead of stacking another.

**Do not run `git push` or `gh pr edit` from this skill.** Branches in
this repo carry stack metadata in git config; ad-hoc push/edit corrupts it.
Hand off to the `stacked-prs:stacked-prs` skill for any push or PR mutation.

### 9. Report

Tell the user:

- Whether a changeset was written, refreshed, or skipped (with the exempt
  categories that matched).
- The chosen slug, bump type, and summary.
- The commit placement (amended vs. new tip commit).
- Any follow-up: `stacked-prs:stacked-prs` push, PR description sync.

## Examples

### Exempt branch

Branch `wyattjoh/scripts-rules` touches only `.claude/rules/scripts.md`.

Report: "All changes are under `.claude/**` (exempt). No changeset required.
`bun changeset status` will pass."

### New feature

Branch `feat/oauth-github` adds GitHub OAuth to `clerk login`. Single commit.

Write `.changeset/oauth-github.md`:

```markdown
---
"clerk": minor
---

Add GitHub as an OAuth provider for `clerk login`. Set `CLERK_GITHUB_CLIENT_ID` to enable.
```

Stage and amend the existing commit.

### Refresh after new commits

Branch `feat/oauth-github` already has `.changeset/oauth-github.md`
(`minor`). A new commit adds GitLab support. Rewrite the summary to cover
the cumulative diff; bump stays `minor`. Amend the tip `docs(changeset):`
commit (multi-commit branch).

## Anti-patterns

- Empty changeset to bypass enforcement on non-exempt changes (silently
  produces a bumpless release).
- Past-tense or implementation-leaking summaries ("Added oauth.ts with
  GithubProvider class").
- Manually appending `(#123)` or `by @user`; the changelog renderer adds
  these.
- Using `@clerk/cli-core` as the package key.
- Creating a second changeset file on a branch that already has one (one
  changeset per PR).
- Running `git push` or `gh pr edit` directly from this skill.

## References

- Full policy with rationale: [references/policy.md](references/policy.md)
- Changelog renderer: `.changeset/changelog.js`
- Changesets config: `.changeset/config.json`
- Enforcement workflow: `.github/workflows/enforce-changeset.yml`

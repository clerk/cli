---
name: changesets
description: Create or refresh a `.changeset/<slug>.md` for the current branch, or report that none is required. Triggers on "/changesets create", "add a changeset", "create a changeset", "update the changeset", "refresh the changeset", "do I need a changeset", or any work that touches `packages/**` source files on a feature branch.
argument-hint: "create"
user-invocable: true
disable-model-invocation: false
effort: high
allowed-tools: Bash(git:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(bun changeset status:*), Bash(bun changeset --empty:*), Bash(git add:*), Bash(git commit:*), Read, Write, Edit, Glob
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
and stop without writing a file. Do not create an empty changeset for fully
exempt branches; `changeset status` already passes.

**Some files non-exempt and `.changeset/<slug>.md` already exists for this
branch:** treat as a refresh. Read the existing file, then jump to step 5
with the existing slug.

**Some files non-exempt, no changeset file exists, and every commit on the
branch uses a non-user-facing prefix** (`refactor:`, `chore:`, `perf:`,
`build:`, `ci:`, `style:`, `docs:`, `test:`) **and the diff has no
observable effect on the CLI surface**: skip to the empty-changeset path
in step 7a.

**Some files non-exempt, no changeset file exists, and the branch contains
any user-facing commit** (`feat:`, `feat(`, `fix:`, `fix(`, `feat!:`,
`fix!:`) or the diff changes a flag, command, exported API, env var,
output format, or any other user-visible surface: continue to step 4.

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

### 7a. Empty changeset path

When step 3 routed here, the branch touches non-exempt paths but has no
user-facing impact. CI requires a file; an empty one satisfies enforcement
without producing a changelog entry or version bump.

Generate it with:

```sh
bun changeset --empty
```

This writes `.changeset/<slug>.md` with empty frontmatter (no package
keys). Continue to step 8 to place the commit.

Skip steps 4 through 6: there is no slug to pick (the CLI generates one),
no bump to choose, and no summary to author.

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

- Which path the skill took: real changeset, refresh of an existing one,
  empty changeset (internal-only non-exempt change), or skip (fully
  exempt branch). For skip, name the exempt categories that matched.
- For real or refresh: the chosen slug, bump type, and summary.
- For empty: the slug the CLI generated.
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

### Internal-only non-exempt change

Branch `refactor/extract-logger` moves a helper inside
`packages/cli-core/src/lib/`. Single commit, prefix `refactor:`, no flag,
command, or output change. Run `bun changeset --empty`. The CLI writes
`.changeset/<generated-slug>.md` with empty frontmatter. Stage and amend
the existing commit. The next release skips a version bump for this
change but the branch passes enforcement.

## Anti-patterns

- Empty changeset to bypass enforcement on **user-facing** changes
  (silently drops a real bump from the changelog).
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

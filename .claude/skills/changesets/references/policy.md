# Changeset Policy

Canonical rules for generating `.changeset/*.md` entries in this repo. The
`Enforce Changeset` workflow (`.github/workflows/enforce-changeset.yml`)
fails a PR when `packages/**` source changes without a corresponding
changeset.

## Exempt paths

A changeset is NOT required when the branch diff touches only files in
these locations. `bun changeset status` exits 0 in this case because no
tracked workspace package changed.

- `.github/**`
- `.changeset/**`
- `docs/**`
- `scripts/**`
- `.claude/**`
- Root dotfiles and docs at repo root: `.gitignore`, `CLAUDE.md`,
  `CONTRIBUTING.md`, `README.md`
- Test-only changes matching `packages/**/*.test.ts` or
  `packages/**/__tests__/**`

If a branch mixes exempt and non-exempt changes, generate a changeset for
the non-exempt subset only.

## Direct file write (do not use `bun changeset add`)

`@changesets/cli add` is interactive: it prompts for bump type and package
selection. `--message` only pre-fills the summary, and `--empty` writes a
zero-content changeset. Neither mode is suitable for programmatic
generation. Write the file directly with the Write tool.

## Frontmatter schema

```yaml
---
"clerk": patch
---
Imperative-present summary on one line becomes the CHANGELOG bullet.
Optional continuation lines become indented sub-bullets.
```

Rules:

- Only `"clerk"` is a valid key. `@clerk/cli-core` is in
  `.changeset/config.json`'s `ignore` list and must not appear.
- Values are exactly one of `patch`, `minor`, `major`.
- Do not manually include `(#123)` or `by @user` in the body;
  `.changeset/changelog.js` appends PR, commit, and author links at
  `changeset version` time.

## File naming

Kebab-case slug of the branch name with the conventional prefix stripped.
Drop username segments (e.g., `wyattjoh/...`).

| Branch                    | Filename                        |
| ------------------------- | ------------------------------- |
| `feat/oauth-github`       | `oauth-github.md`               |
| `fix/login-redirect-loop` | `login-redirect-loop.md`        |
| `perf/init-cold-start`    | `init-cold-start.md`            |
| `wyattjoh/scripts-rules`  | `scripts-rules.md`              |
| `ci/enforce-changeset`    | n/a (exempt; `.github/**` only) |

If the slug collides with an existing file on `main`, suffix with a short
differentiator (`-v2`, `-followup`, `-part-2`).

## Bump-type decision

Map the PR's dominant intent over the cumulative branch diff, not the
conventional-commit prefix alone. A `fix:` PR that also adds a new public
flag is a `minor`.

| Intent                                                   | Bump    | Signal                                                                                |
| -------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| New user-facing feature, command, flag                   | `minor` | `feat:`, new exported API, new CLI surface                                            |
| Bug fix, perf, internal refactor with no behavior change | `patch` | `fix:`, `perf:`, `refactor:`                                                          |
| Breaking change                                          | `major` | Removed flag, incompatible CLI behavior, `BREAKING CHANGE` footer, `feat!:` / `fix!:` |
| Mixed scope                                              | highest | feat plus fix becomes `minor`                                                         |

### Stop-and-ask gates

Pause and prompt the user. Do not guess.

1. Any classification that would produce `major`. Breaking changes need
   human sign-off.
2. Ambiguous intent (a refactor that may change observable behavior, a
   dependency bump with unclear downstream effects).
3. Revert commits without a stated motivation.

### Default-to-patch rule

If the change is clearly non-breaking but the split between `minor` and
`patch` is genuinely unclear (e.g., internal reorganization that
incidentally exposes a new helper), use `patch` and note the reasoning in
the response to the user.

## Summary authoring

- Imperative-present tense ("Add X", "Fix Y", "Remove Z"). Never past
  tense.
- User-facing language. A CLI user reads this; they do not know internal
  file paths, class names, or implementation details.
- Authored independently from the PR title. The PR title describes the
  work; the summary describes the user-visible result.
- One sentence ending in a period. Continuation lines only when the change
  genuinely needs more context.

Example contrast:

| PR title                                                    | Changeset summary                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `feat(cli): wire up OAuth GitHub provider to login command` | `Add GitHub as an OAuth provider for ` `clerk login` `.`                     |
| `fix(init): register --app option shown in help examples`   | `Fix ` `clerk init --app` ` so it works when invoked from the help example.` |

### Optional body prefixes

`.changeset/changelog.js` recognizes these at the start of the body and
consumes them before rendering. Rarely needed.

| Prefix             | Effect                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `pr: #<number>`    | Override the associated PR link.                                                                                  |
| `commit: <sha>`    | Override the commit link.                                                                                         |
| `author: @<login>` | Manually attribute. Filtered through `EXCLUDED_LOGINS` (`claude`, `claude[bot]`, `claude-code[bot]` are dropped). |

## Commit placement

| Branch shape  | Where the changeset lives                                       |
| ------------- | --------------------------------------------------------------- |
| Single commit | Amended into the same commit as the code change.                |
| Multi-commit  | Its own commit at the tip, titled `docs(changeset): <summary>`. |

Single commits stay self-describing; multi-commit branches keep the
changeset regeneratable by rewriting only the tip commit.

## Update workflow on new commits

When pushing additional commits to a branch that already has a changeset:

1. Read the existing `.changeset/<slug>.md`.
2. Regenerate the summary from the cumulative branch diff vs `main`. Do
   not just append; rewrite so the summary matches the current state of
   the branch.
3. Escalate the bump type if the new commits warrant it:
   - `patch` plus new feat becomes `minor`.
   - Any escalation to `major` triggers the stop-and-ask rule.
4. Commit the regenerated changeset:
   - Single-commit branch: amend.
   - Multi-commit branch: amend the existing tip `docs(changeset):`
     commit. Do not stack a second one.

Do not create a second changeset file on the same branch unless the user
explicitly opts into that. The repo convention is one changeset per PR.

## `bun changeset --empty`

Only valid when the branch is fully exempt. `changeset status` already
passes without a file in that case, so the empty changeset is usually
unnecessary. Do NOT create an empty changeset to bypass enforcement on
non-exempt changes; that silently produces a bumpless release.

## Examples

### Good

`.changeset/oauth-github.md` on branch `feat/oauth-github`:

```markdown
---
"clerk": minor
---

Add GitHub as an OAuth provider for `clerk login`. Set `CLERK_GITHUB_CLIENT_ID` to enable.
```

### Bad: past tense, implementation-leaking

```markdown
---
"clerk": minor
---

Added oauth.ts with GithubProvider class wired into login.ts.
```

### Bad: empty frontmatter used to bypass enforcement

```markdown
---
---

fix something
```

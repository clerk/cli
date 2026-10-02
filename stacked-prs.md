# Stacked PRs for `clerk migrate`

Split `ra/integrate-migration-tool-into-cli` (clerk/cli#479: 88 commits, 112 files, +20,421 / -122) into 14 stacked PRs. Each PR carves existing files out of the branch. Nothing gets rewritten. #479 stays open as the reference until the top of the stack merges.

**#479 stays untouched.** Every PR below is a new branch and a new PR. The stack only reads from #479:

- Nothing is committed or pushed to `ra/integrate-migration-tool-into-cli`, and it's never rebased or force-pushed.
- #479 itself is never edited, retargeted, marked ready, merged, or closed while the stack is in flight. Decide what to do with it after PR 10 merges.
- Files come from commit `cea11672` (the tip of #479 when this plan was written), never by branching from, cherry-picking onto, or merging the PR branch. Pinning the commit means a later push to #479 can't change what the stack carves.

## The stack at a glance

Line counts come from `git diff --numstat origin/main...HEAD`, grouped by file. Counts marked `~` include a test file shared across PRs, so they move a little once you split it.

| PR  | Scope                                                               |   Src |  Tests |  Total |
| --- | ------------------------------------------------------------------- | ----: | -----: | -----: |
| 0a  | Build and CI chores (off `main`, independent)                       |    82 |      0 |     82 |
| 0b  | Shared lib prep (off `main`, independent)                           |    93 |    101 |    194 |
| 1a  | Import pipeline: map, validate, throttle, run store, target         | 1,899 | ~1,500 | ~3,400 |
| 1b  | Preflight checks and readiness report                               | 1,394 |  1,276 |  2,670 |
| 1c  | `clerk migrate import` command, behind `CLERK_EXPERIMENTAL=migrate` | 1,505 | ~2,000 | ~3,500 |
| 2   | `migrate runs` and `migrate undo`                                   |   771 |    376 |  1,147 |
| 3   | Export framework and `export clerk`                                 | 1,115 |    951 |  2,066 |
| 4   | `export supabase` and the DB layer                                  |   703 |    707 |  1,410 |
| 5   | Firebase: source, export, hash flags                                |   795 |    576 |  1,371 |
| 6   | Auth0: source and export                                            |   434 |    346 |    780 |
| 7   | WorkOS: source and export                                           |   559 |    478 |  1,037 |
| 8   | Better Auth and Auth.js: sources and exports                        |   519 |   ~150 |   ~670 |
| 9   | `migrate sources` command and custom sources (`--source ./file.ts`) |   394 |    417 |    811 |
| 10  | Un-gate, changeset, root README                                     |   ~10 |   ~180 |   ~190 |

The 1,067-line `commands/migrate/README.md` doesn't get its own PR. `readme.test.ts` checks the README against the command tree in both directions, so each PR adds the README section for what it ships.

## Ground rules

1. **Carve, don't rewrite.** Each PR takes files from #479 with `git checkout cea11672 -- <paths>`, run on the new PR's own branch, then trims imports and registry entries so it compiles alone.
2. **Every PR passes CI alone.** Run `bun run format && bun run lint && bun run typecheck && bun run test` before you push.
3. **Gate from 1c to 10.** PR 1c adds `lib/experimental.ts` (about 40 lines, the same design as Task 1 of the slice-1 proposal). Without `CLERK_EXPERIMENTAL=migrate`, `migrate` stays hidden from help and completion and exits 2. Each PR can merge to `main` and reach `@canary` without shipping half a feature. PR 10 removes the gate.
4. **Merge bottom-up.** Open each one as a new PR with `gh pr create --draft --base <branch below>`. Use `git rebase --update-refs` (or Graphite's `gt`) so review fixes low in the stack ripple up in one command. `--update-refs` runs on the stack's branches only, never on `ra/integrate-migration-tool-into-cli`.
5. **0a and 0b branch off `main`**, so they can merge in any order, today. 1a also starts from `origin/main`, and each PR above it starts from the branch below it. No branch starts from `ra/integrate-migration-tool-into-cli`.
6. **Leave #479 alone.** Never build on, push to, or rebase its branch, and never run `gh pr edit`, `gh pr ready`, `gh pr merge`, or `gh pr close` on #479. Do the work in new worktrees, not in a checkout of the PR branch.

## PR details

### 0a: Build and CI chores

- `.github/workflows/ci.yml`: `bun run build` becomes `bun run build:compile`
- `package.json`: `build` alias, Playwright pinned to `1.60.0`
- `packages/cli-core/package.json`: drop the unused `build` script (leave the `csv-parser` and `zod` additions for 1a)
- `scripts/check-bun-version.ts`, `bun.lock` `configVersion`
- `.gitignore`: `exports/` and `*service-account*.json`

Review focus: none of this touches migrate. Check the Playwright pin still matches main's CI image before merging.

### 0b: Shared lib prep

- `lib/fetch.ts` and `lib/errors.ts`: a connection failure becomes a `CliError` with code `network_unreachable` that names the host
- `lib/git.ts` and `lib/keyless.ts`: move `ensureGitignoreEntry` into `git.ts` and export it. Add it to `test/lib/stubs.ts` and the `harness.ts` git mock.
- `lib/spinner.ts`: ignore an empty `setNextSteps([])`
- `lib/bapi-command.ts` and its tests: `describeBapiTarget` names the key's source (`via --app`, `via the linked profile`, `CLERK_SECRET_KEY`)
- `lib/prompts.ts` and `prompts-instructions.test.ts`: advertise `a: all` in the multiselect footer

Review focus: `describeBapiTarget` changes wording for every command that prints a target, not only migrate. Call that out in the PR description.

### 1a: Import pipeline (library only, no command)

Files:

- `types.ts`, `validator.ts` (+ tests)
- `lib/transform.ts`, `lib/scheduler.ts`, `lib/retry.ts`, `lib/instance.ts`, `lib/run-store.ts`, `lib/target.ts` (+ tests)
- `sources/shared.ts`, `sources/clerk.ts`, `sources/supabase.ts`, `sources/registry.ts`
- `sources/sources.test.ts`: keep only the Clerk, Supabase, and shared cases
- `packages/cli-core/package.json`: add `csv-parser` and `zod`

Edits to make it stand alone:

- `sources/registry.ts`: register only `clerk` and `supabase`. Strip `loadCustomSource` and `registerCustomSource` (they return in PR 9).
- `types.ts`: drop `FirebaseHashConfig` if nothing in this PR uses it, or leave the type in place. A type with no caller costs nothing.
- `lib/export-file.ts`: `transform.ts` imports it to read envelopes. Bring it along (51 lines) so `transform.ts` stays untouched.

Review focus: the run store layout (`run.json`, `users.ndjson`, `lock`), the field mapping for Clerk and Supabase, and the 429 handling.

### 1b: Preflight checks

Files: `lib/checks.ts`, `lib/readiness.ts`, `lib/modify-settings.ts`, `lib/analysis.ts`, `lib/clerk-config.ts`, `lib/supabase-providers.ts`, `lib/user-lookup.ts`, plus tests.

Edits: none expected. `checks.ts` imports `import-users.ts` for one type. Move that type into `types.ts` in this PR, or pull `import-users.ts` down from 1c.

Review focus: what blocks a user and what drops a field. This is where the behavior that writes to production lives: disabled identifiers, refused emails and names, username rules, duplicates, and the dev user limit.

### 1c: `clerk migrate import`

Files:

- `index.ts`: register only `import`
- `run.ts`, `import-users.ts`, `wizard.ts`, plus `run.test.ts`, `run-interactive.test.ts`, `import-users.test.ts`, `wizard.test.ts`, `index.test.ts`
- `lib/assume-yes.ts`, `lib/input-retry.ts` (the `-y` hook and the credential retry loop)
- `cli-program.ts`, `__complete.ts` (`--source` values), `completion.test.ts`
- `lib/next-steps.ts`: `printAgentNextSteps`
- New: `lib/experimental.ts` and its test (the gate)
- `README.md` (import sections only), `readme.test.ts`
- `test/e2e/migrate.test.ts`: only the "unverified email is refused" case

Edits to make it stand alone:

- `run.ts`: remove the Firebase hash flags, `resolveFirebaseHashConfig`, and `promptForFirebaseHashConfig` (about 10 lines; they return in PR 5).
- `run.ts`: `resolveInput` accepts an export run ID. Keep the code, since the run store already exists, and drop its README example until PR 3.
- `next-steps.ts`: `MIGRATE_DONE` points at `migrate runs` and `migrate undo`, which don't exist yet. Point at the run folder path instead; PR 2 restores the original text.
- `run.ts` `cleanupLines`: same fix for its "undo" mention.
- `run.test.ts` and `index.test.ts`: drop the `per-platform imports`, `--source <path>`, and non-Clerk/Supabase cases.

Continuing a stopped run stays in this PR. It lives inside `run.ts`, and pulling it out means rewriting code that already works.

Review focus: consent (`--yes`, the TTY prompt, `--json` without `--yes`), the target line, exit codes, and the gate.

### 2: `migrate runs` and `migrate undo`

Files: `runs.ts`, `undo.ts`, and their tests. Register both in `index.ts`. Restore `MIGRATE_DONE` and `cleanupLines`. Add the README sections.

Review focus: `undo` is the one command that deletes users. Check the in-flight case (f108dc0a) and the `--dry-run` path.

### 3: Export framework and `export clerk`

Files: `export/index.ts`, `export/shared.ts`, `export/registry.ts` (Clerk only), `export/clerk.ts`, `export/clerk-source.ts`, plus tests. Add the README sections for export and for importing by export run ID.

Review focus: the envelope format (`ENVELOPE_VERSION = 1`), since every later export writes it.

### 4: `export supabase` and the DB layer

Files: `lib/db.ts`, `export/db-options.ts`, `export/supabase.ts`, `lib/db.test.ts`, the Supabase part of `export/db-exports.test.ts`. Add the `Bun.sql` MySQL note to `CLAUDE.md`.

Review focus: connection-string handling (URL-encoding, libsql/Turso) and the Bun version floor for MySQL binary columns.

### 5 to 8: One PR per provider

Each PR adds the source mapping, the export, their tests, the registry entries, the README sections, and the `sources.test.ts` cases for that provider.

- **5 Firebase:** `sources/firebase.ts`, `export/firebase.ts`, `lib/firebase-hash.ts`. Restore the four `--firebase-*` flags and the hash-config prompt in `run.ts` and `wizard.ts`.
- **6 Auth0:** `sources/auth0.ts`, `export/auth0.ts`
- **7 WorkOS:** `sources/workos.ts`, `export/workos.ts`, the WorkOS entry in `init/scan.ts`
- **8 Better Auth and Auth.js:** `sources/betterauth.ts`, `sources/authjs.ts`, `export/betterauth.ts`, `export/authjs.ts`, the rest of `db-exports.test.ts`, and the "Better Auth scrypt hash" e2e case

Reorder these freely. They depend only on PR 3 (and PR 4 for the DB-backed two).

### 9: `migrate sources` and custom sources

Files: `sources/list.ts`, `sources/load-custom.ts`, plus tests. Restore `registerCustomSource` and `loadCustomSource` in the registry, the `migrate sources` positional completion, and `--source <path>` handling in `run.ts`.

It goes after the providers because `sources/list.ts` imports `export/registry.ts` to show how to export from each platform.

### 10: Un-gate

Remove `lib/experimental.ts` and the stub branch in `index.ts`. Add `migrate` to the root `README.md`. Add `.changeset/migrate-cli.md`. Re-run the agent baseline against `@canary` before merging.

## Effort

- **Carving:** about 1 hour each for PRs 0a, 0b, 2, and 5 to 10, and 2 to 3 hours each for 1a, 1b, 1c, 3, and 4 (the test-file splits take the time). About 2 to 3 days in total.
- **Review:** 14 PRs at 0.1k to 3.5k lines. The three PRs in slice 1 carry the review weight.

## Risks

- **1a and 1b merge code that nothing calls** until 1c lands. Reviewers have to read them as libraries. If that's a blocker, merge 1a to 1c together as one reviewed stack, or collapse them into one ~9.6k PR.
- **Rebase churn.** A review fix in 1a ripples through 13 branches. `--update-refs` handles the mechanics, but every PR above it gets re-pushed.
- **Split test files.** `sources.test.ts`, `run.test.ts`, and `db-exports.test.ts` each cover several PRs. Splitting them by `describe` block is the slowest part of the carve.

## First step

Create PR 0a in a new worktree off `main`:

```bash
git worktree add -b migrate/0a-chores ../cli-0a origin/main
cd ../cli-0a
git checkout cea11672 -- .github/workflows/ci.yml scripts/check-bun-version.ts
```

Then open it as a new PR with `gh pr create --draft --base main`.

# `clerk migrate` in slices

Ship `migrate` in small PRs instead of one 20k-line PR. #479 (`ra/integrate-migration-tool-into-cli`) stays open as the reference, and each slice ports from it.

**Reference commit: `7a820406`.** That's #479's tip after the review fixes (`3eec00bd` to `d6201932`) and the merge of `main` at `a16595ff`. Because #479 now contains current `main`, a file copied from `7a820406` onto a branch off `origin/main` brings no stale `main` code with it. The earlier pin, `cea11672`, predates every review fix. Don't port from it.

**The slices never write to #479:**

- No slice branch starts from, cherry-picks from, merges, or rebases `ra/integrate-migration-tool-into-cli`. Code comes over by copying files from the reference commit (see "Reference implementation" below).
- #479 itself is never retargeted, marked ready, merged, or closed while the slices are in flight. Decide what to do with it after slice 6 merges.
- #479 can still take fixes. When one lands after the slices are cut, see "When #479 gets another fix" below.

**Don't port these from #479:** `slice-prs.md` (this plan), `.changeset/integrate-migration-tool-into-cli.md` (each slice writes its own), and the `.gitignore` lines for `commands/migrate/logs/` (that folder no longer exists).

**Size:** 6 slices, shipped as 10 PRs. Slice 4 is five PRs, one per provider.

## How it ships: one PR at a time, gated until the last one

The PRs are stacked, but they're reviewed and merged one at a time. Slice 1 merges to `main`, then slice 2 gets reviewed and merges, and so on. The stack is never reviewed or merged as a whole.

**The gate stays on until slice 6 merges:**

- Slice 1 adds `CLERK_EXPERIMENTAL=migrate`. Without it, `migrate` doesn't appear in `clerk --help` or completions, and it refuses to run.
- Slices 2 to 5 each add commands or sources behind that same gate.
- Slice 6 is the only PR that removes the gate.

**What that means for every PR:**

- **It stands alone on `main`.** Each merge reaches `@canary`, and a release from `main` between slices ships whatever has merged so far, still gated. So every PR passes CI by itself, and its `migrate/README.md` documents only the commands that have merged. `readme.test.ts` enforces this, because it fails on any documented flag the binary rejects.
- **It has its own changeset.** Create it with the `changesets` skill. Until slice 6, the text says the command is experimental and needs `CLERK_EXPERIMENTAL=migrate`. Slice 6's changeset announces `clerk migrate`.
- **It's tested against `@canary` before the next one is marked ready.** Run `npm i -g clerk@canary` with `CLERK_EXPERIMENTAL=migrate` set, then re-run that slice's baseline tasks.

## Slice 1: `clerk migrate import <file>` for Clerk and Supabase files

- **Ported from #479:**
  - the Clerk and Supabase sources and the schema
  - the checks against the real instance
  - consent: `--yes` or a prompt
  - `--dry-run`, `--allow-partial`, and `--skip-legal-checks`
  - the run store, the target line, and `--json`
  - throttling, 429 backoff, and the dev user limit
  - the progress bar, and exit 130 on Ctrl-C
- **New:** the `CLERK_EXPERIMENTAL` gate.
- **Not in slice 1:** continuing a stopped run, `runs`, `undo`, `export`, importing by export run ID, other sources, and `--source ./file.ts`.

Import goes first because the risky behavior lives there: writing to production, consent, quota, and silent data loss. It's also the smallest slice that's useful on its own.

## After that

| Slice | Scope                                                                                                                   | PRs |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | --- |
| 2     | `runs`, `undo`, and continuing a stopped run (`--new-run`, adopting in-flight creates, finishing `pending` identifiers) | 1   |
| 3     | The export envelope, `export clerk`, `export supabase`, and importing by export run ID                                  | 1   |
| 4     | One PR per provider, each with its export and import: Firebase, Auth0, WorkOS, Better Auth, Auth.js                     | 5   |
| 5     | Custom sources (`--source ./file.ts`) and `migrate sources`                                                             | 1   |
| 6     | Remove the gate, then the docs and skills written against the final help output                                         | 1   |

**Where the non-`migrate` files from #479 go:**

- Slice 3: the `.gitignore` lines for `exports/` and `*service-account*.json`, and the MySQL note in `scripts/check-bun-version.ts`.
- Slice 4c (WorkOS): the WorkOS entry in `commands/init/scan.ts`.
- Slice 6: the root `README.md` entry.

**How each slice is proven:**

- unit and integration tests;
- a re-run of the matching tasks from the agent baseline, against real test apps;
- once exports land, a weekly E2E run against real provider accounts, with credentials in 1Password, to catch providers changing underneath us.

**Separate small PRs off `main`, not part of any slice.** These can merge in any order, before or during the slices:

- `build:compile` in CI (`.github/workflows/ci.yml`, plus the root `build` script)
- `network_unreachable` for connection failures in `lib/fetch.ts` and `lib/errors.ts`, together with the `clerk update` fix from `0365fb84` that keeps reporting `registry_unreachable` when offline (`commands/update/index.ts` and its test)
- `bun --no-env-file` for `test:e2e` (`b0705144`: the root `package.json` and its line in `CLAUDE.md`)
- the `a: all` hint in the multiselect footer (`lib/prompts.ts`)
- the `describeBapiTarget` wording change (`lib/bapi-command.ts`)

The Playwright pin is gone from this list. `main` moved Playwright to 1.62.1 in #409, and #479 no longer differs from it.

## Branching

Every branch below is new. `migrate/slice-1` starts from `origin/main`, and each branch above it starts from the branch below it. None of them starts from `ra/integrate-migration-tool-into-cli`.

Stack the branches in one line:

```
main
 └─ migrate/slice-1        import
     └─ migrate/slice-2    runs, undo, continuing a run
         └─ migrate/slice-3    exports
             └─ migrate/slice-4a   Firebase
                 └─ migrate/slice-4b   Auth0
                     └─ migrate/slice-4c   WorkOS
                         └─ migrate/slice-4d   Better Auth
                             └─ migrate/slice-4e   Auth.js
                                 └─ migrate/slice-5    custom sources, `migrate sources`
                                     └─ migrate/slice-6    remove the gate, docs
```

The provider PRs don't depend on each other, but each one edits `sources/registry.ts`, `export/registry.ts`, `sources.test.ts`, and `README.md`. As siblings, every merge would conflict on those four files. In one line, nothing conflicts, and slice 5 sits on top of every provider.

**Build only a little ahead.** Only one PR is in review at a time, and every review fix rebases every branch above it. Keep one or two draft branches above the PR in review, not all ten. A slice built early gets rebased through every review round below it.

**Workflow:**

1. Open slice 1 as a ready PR with `--base main`. Open each slice above it as a draft with `gh pr create --draft --base <branch below>`. Don't reuse #479 for any slice.
2. Exactly one PR is ready at a time: the lowest one that hasn't merged. Its base is `main`.
3. For a review fix, commit on that PR's branch. Then run `git rebase --update-refs` from the highest branch you've built, and push each branch with `--force-with-lease`.
4. Merge the ready PR. The repo allows squash and rebase merges, not merge commits. Either way, `main` gets new commits, so the branch above still carries the old ones. Drop them, using the merged PR's head commit:

   ```bash
   git fetch origin
   MERGED=$(gh pr view <merged PR> --json headRefOid -q .headRefOid)
   git rebase --onto origin/main "$MERGED" <highest branch> --update-refs
   ```

   Then push each remaining branch with `--force-with-lease`, and delete the merged branch locally.

5. GitHub deletes the merged branch and moves the next PR's base to `main` on its own. Check that the next PR's diff shows only its own slice.
6. Test the merge on `@canary` and re-run the next slice's baseline tasks. Then mark the next PR ready.

**When a baseline run changes a behavior,** such as what the checks reject, fix it in the PR in review. Step 3 carries the fix into the branches above it.

**When #479 gets another fix:**

1. Note the new commit, and re-pin the reference (`git -C ../cli-pr479 checkout --detach <new tip>`).
2. If the files it touches belong to a slice that hasn't merged, port the change into that slice. Then rebase the branches above it, as in step 3.
3. If that slice has already merged, open a small `fix(migrate):` PR off `main`. Rebase the stack onto `main` after it merges.

---

# Slice 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a hidden, env-gated `clerk migrate import <file>` for Clerk and Supabase files. It checks every user against the real instance before writing, writes only with consent, records every user in a run, and speaks JSON. It merges to `main` on its own, ahead of slice 2.

**Architecture:** A new `commands/migrate/` group in `packages/cli-core`, registered hidden and gated by `CLERK_EXPERIMENTAL=migrate`. An import goes through five stages:

1. Settle the file, the source, and the target. Print the target.
2. Load the users: read the file, map it through the source, then normalize and validate it.
3. Run `checkImport()` against the instance. `--dry-run` stops here.
4. Refuse on any reject unless `--allow-partial` is passed, then ask for consent.
5. Import through the scheduler, writing one run line per user, under a progress bar.

Every module is ported from #479. Slice 1 leaves out the parts that belong to later slices.

**Tech stack:** Bun, TypeScript, Commander, `@clack/prompts` wrappers in `lib/prompts.ts`, zod 4, csv-parser, `bun:test`.

**Spec:** [clerk migrate: CLI shape proposal](https://claude.ai/code/artifact/981d8d00-05ce-4545-bd19-1a886f2b788b) (Claude Doc). Evidence: `/Users/manovotny/Developer/cli-migrate-testing/runs/baseline/RESULTS.md`.

**Reference implementation:** clerk/cli#479 at `7a820406`. Below, `REF/` means `packages/cli-core/src/` in a checkout of that commit:

```bash
git worktree add --detach ../cli-pr479 7a820406
```

This worktree is read-only. It sits on a detached commit, so nothing done there can reach #479's branch. Don't commit in it. Copy files out of it, or run `git checkout 7a820406 -- <path>` from a slice branch.

## Global constraints

- **Branching:** branch fresh from `origin/main` in a new worktree, and open a new PR with `--base main`. Never build on, push to, or rebase `ra/integrate-migration-tool-into-cli`, and never run `gh pr edit`, `gh pr ready`, `gh pr merge`, or `gh pr close` on #479.
- **Stands alone:** slice 1 merges before slice 2 is reviewed, so nothing in it may depend on a later slice. The README, help, completion, and tests describe only `import`.
- **The gate:**
  - `migrate` must not appear in `clerk --help`, completions, or the root README unless `CLERK_EXPERIMENTAL` includes `migrate`.
  - With the experiment off, `migrate` is registered as a hidden stub with no subcommands, help disabled, and any arguments accepted. Every invocation exits 2 with code `experiment_disabled`, including `--help` and malformed arguments. Completion has no children to walk.
  - `CLERK_EXPERIMENTAL` is a comma-separated list. Names are trimmed and case-insensitive, and unknown names are ignored.
- **The target prints first.** Once the target resolves, a human sees `Target: <app>, <environment> instance <id>` and `Key from: <source>` before the checks. `--json` carries the same facts as `target`.
- **The target must agree with the key.** An `--instance` that the key from `--secret-key` or `CLERK_SECRET_KEY` doesn't address is refused with exit 2.
- **Consent.** Import writes to Clerk only when a human answers yes at a TTY prompt (`Import N users?`, default no), or when `--yes` is passed. Without either (an agent, a non-TTY run, or `--json`), it prints the checks and exits 2 with the exact command to run. Printed commands shell-quote their paths and keep `--json`. `--json` never prompts.
- **`--dry-run`** runs the checks against the real instance and writes nothing. It exits 2 when the real run would be refused, and 0 otherwise.
- **Rejects.** Any reject refuses the import (exit 2) and prints the command that adds `--allow-partial`. With `--allow-partial`, the rest import and each reject is recorded as `skipped` with its reason.
- **Unknown password hasher.** An unrecognized hasher aborts the whole run before anything is sent.
- **Exit codes:**
  - `0`: every attempted user was created, or a dry run that would succeed.
  - `1`: any user failed.
  - `2`: a usage error or a refusal.
  - `130`: Ctrl-C. In-flight requests abort and the process dies by SIGINT. This is why import shows a progress bar (`lib/progress.ts`) instead of a clack spinner: the spinner exits 0 on Ctrl-C.
- **Output streams.** UI goes to stderr. JSON goes to stdout through `log.data`.
- **Input files.** JSON, CSV, and NDJSON (Auth0's bulk export). A BOM prefix is read. A file that isn't valid JSON is named in the error.
- **The run store:**
  - Location: `--runs-dir`, then `CLERK_MIGRATE_DIR`, then `<project root>/.clerk/migrate/`. The project root is the linked profile's directory, then the git toplevel, then the cwd.
  - `.clerk/` is added to `.gitignore` only once there is consent to write a run, and only for the default location.
  - Each run is a folder `YYYYMMDD-HHmmss-xxxx/` holding `run.json`, `users.ndjson`, and `lock`. Folders are `0700`. Folders and locks are created exclusively, so a run-ID collision or a lock race fails instead of sharing a folder. A lock holding this process's own PID is stale.
  - A user's `creating` line is written as its `POST /v1/users` goes out. When the create gets no answer (an abort, a network error, or a 5xx), the line stays `creating` instead of becoming `failed`.
  - A `created` line lists the extra emails and phones that haven't attached yet as `pending`. A later `created` line without `pending` means they're done.
  - Every append is synchronous, and a failed append throws.
  - The run format is final in this slice, because slice 2 reads it once slice 1 is on `main`.
- **Throughput:**
  - The instance type comes from the key prefix: `sk_live_` is production, anything else is development.
  - Default rate limits: 100 req/s for production and 10 req/s for development. Concurrency defaults to `floor(rate × 0.095)`.
  - The env overrides are `CLERK_MIGRATE_RATE_LIMIT`, `CLERK_MIGRATE_CONCURRENCY_LIMIT`, and `CLERK_MIGRATE_DEV_USER_LIMIT`. A non-numeric or non-positive value falls back to the default.
- **Repo rules.** Follow `.claude/rules/*.md` (commands, errors, completion, promises, testing, changesets, interrupts). Run `bun run format && bun run lint && bun run typecheck && bun run test` before every commit.
- **Changeset.** One changeset for the slice (Task 9), created with the `changesets` skill.

## File structure

```
packages/cli-core/src/
  lib/experimental.ts   experimental.test.ts   # CLERK_EXPERIMENTAL parsing (new)
  lib/git.ts                                   # + export ensureGitignoreEntry (moved from lib/keyless.ts)
  lib/errors.ts                                # + ERROR_CODE.EXPERIMENT_DISABLED
  lib/config.ts                                # export INSTANCE_ALIASES
  lib/json-body.ts                             # export quoteArg
  lib/next-steps.ts                            # + printAgentNextSteps, MIGRATE_DONE(_WITH_ERRORS)
  lib/spinner.ts                               # ignore an empty setNextSteps([])
  commands/completion/__complete.ts            # + --source values
  commands/migrate/
    index.ts       index.test.ts               # gate stub, or the group with `import`
    README.md      readme.test.ts
    types.ts                                   # User, PASSWORD_HASHERS, SourceEntry, ImportSummary
    validator.ts   validator.test.ts           # userSchema
    run.ts         run.test.ts   run-interactive.test.ts   # the `import` action
    import-users.ts  import-users.test.ts      # create + attach, one run line per user
    wizard.ts      wizard.test.ts              # promptForFile, promptForSource
    sources/
      registry.ts                              # clerk + supabase; resolveSource, sourceKeys
      shared.ts  clerk.ts  supabase.ts
      sources.test.ts
    lib/
      assume-yes.ts                            # -y read below the action
      transform.ts   transform.test.ts         # read JSON/CSV/NDJSON → map → normalize → validate
      instance.ts    instance.test.ts          # instance type, limits, dev user limit
      retry.ts       retry.test.ts             # 429 backoff
      scheduler.ts   scheduler.test.ts         # rate + concurrency
      progress.ts    progress.test.ts          # the import progress bar
      target.ts      target.test.ts            # resolveClerkTarget, printTarget
      run-store.ts   run-store.test.ts         # write side of the run store
      clerk-config.ts  clerk-config.test.ts    # FAPI settings, user count, Clerk's OAuth providers
      user-lookup.ts                           # batched GET /v1/users
      supabase-providers.ts  supabase-providers.test.ts
      analysis.ts    analysis.test.ts
      readiness.ts   readiness.test.ts
      modify-settings.ts  modify-settings.test.ts   # the `clerk config patch` offers
      checks.ts      checks.test.ts            # checkImport
test/e2e/migrate.test.ts
```

## How to port a module

Every task below ports files from `REF/`, using the same steps:

1. Copy the test file from `REF/` and trim the cases the task names.
2. Run it with `bun test --isolate <path>`. Expect it to fail with "Cannot find module".
3. Copy the module from `REF/` and apply the task's trims.
4. Run the test again. Expect it to pass.
5. Run the full CI set, then commit.

When a task says "as-is", copy the file unchanged.

---

### Task 1: Experimental gate and hidden `migrate` group

**Files:**

- Create: `lib/experimental.ts`, `lib/experimental.test.ts`
- Create: `commands/migrate/index.ts`, `commands/migrate/README.md` (a stub saying the command is experimental and gated)
- Modify: `lib/errors.ts` (add `EXPERIMENT_DISABLED: "experiment_disabled"`), `cli-program.ts` (append `registerMigrate` to `registrants`)
- Modify: `lib/git.ts`, `lib/keyless.ts`, `test/lib/stubs.ts`, `test/integration/lib/harness.ts`. Move `ensureGitignoreEntry` from `keyless.ts` into `git.ts` as an export, exactly as `REF/lib/git.ts` has it, and add it to `gitStubs` and to the harness's `git.ts` mock.
- Test: `commands/migrate/index.test.ts` (gate cases only), `cli-program.test.ts` (existing help-ordering test must still pass)

**Interfaces:**

- `isExperimentEnabled(name: string, env?: NodeJS.ProcessEnv): boolean`
- `requireExperiment(name: string, env?: NodeJS.ProcessEnv): void`: throws a `CliError` with code `experiment_disabled` and exit code 2
- `registerMigrate(program: Program, env?: NodeJS.ProcessEnv): void`

- [ ] **Step 1: Write `lib/experimental.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { CliError, EXIT_CODE } from "./errors.ts";
import { isExperimentEnabled, requireExperiment } from "./experimental.ts";

describe("isExperimentEnabled", () => {
  test.each([
    { value: undefined, expected: false },
    { value: "", expected: false },
    { value: "migrate", expected: true },
    { value: " Migrate ", expected: true },
    { value: "other,migrate", expected: true },
    { value: "other, MIGRATE ,x", expected: true },
    { value: "migrates", expected: false },
    { value: "other", expected: false },
  ])("CLERK_EXPERIMENTAL=$value → $expected", ({ value, expected }) => {
    expect(isExperimentEnabled("migrate", { CLERK_EXPERIMENTAL: value })).toBe(expected);
  });
});

describe("requireExperiment", () => {
  test("throws a usage-level CliError naming the variable", () => {
    try {
      requireExperiment("migrate", {});
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("experiment_disabled");
      expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
      expect((error as CliError).message).toContain("CLERK_EXPERIMENTAL=migrate");
    }
  });

  test("passes when enabled", () => {
    expect(() => requireExperiment("migrate", { CLERK_EXPERIMENTAL: "migrate" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `bun test packages/cli-core/src/lib/experimental.test.ts`. It should fail with "Cannot find module './experimental.ts'".

- [ ] **Step 3: Implement `lib/experimental.ts`**

```ts
import { CliError, ERROR_CODE, EXIT_CODE } from "./errors.ts";

function enabledExperiments(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env.CLERK_EXPERIMENTAL ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isExperimentEnabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return enabledExperiments(env).has(name.toLowerCase());
}

export function requireExperiment(name: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isExperimentEnabled(name, env)) return;
  throw new CliError(
    `\`clerk ${name}\` is experimental. Set CLERK_EXPERIMENTAL=${name} to use it.`,
    { code: ERROR_CODE.EXPERIMENT_DISABLED, exitCode: EXIT_CODE.USAGE },
  );
}
```

- [ ] **Step 4: Write the gate tests** in `commands/migrate/index.test.ts`. Read `test/integration/lib/harness.ts` first to confirm that `clerk.raw` builds a fresh program per call, since the env must be set before the program is built. Cover:
  - With the experiment off:
    - `clerk --help` doesn't contain `migrate`.
    - Each of these exits 2 with `"code":"experiment_disabled"` in agent mode: `migrate`, `migrate --help`, `migrate import users.json --yes`, `migrate --not-a-flag`, `help migrate`, and `--verbose migrate import x.json`.
    - `__complete migrate ""` offers nothing.
  - With the experiment on: `clerk --help` lists `migrate`.

  `clerk help migrate` goes through Commander's help path, not the stub's action. Override the stub's `helpInformation` to call `requireExperiment`, so that path exits 2 as well.

- [ ] **Step 5: Implement `commands/migrate/index.ts`**

```ts
import type { Program } from "../../cli-program.ts";
import { isExperimentEnabled, requireExperiment } from "../../lib/experimental.ts";

export function registerMigrate(program: Program, env: NodeJS.ProcessEnv = process.env): void {
  if (!isExperimentEnabled("migrate", env)) {
    const stub = program
      .command("migrate", { hidden: true })
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .argument("[args...]")
      .action(() => requireExperiment("migrate", env));
    stub.helpInformation = () => {
      requireExperiment("migrate", env);
      return "";
    };
    return;
  }
  // Task 9 registers the group and `import` here.
}
```

- [ ] **Step 6: Run the full suite.** `bun run test` must pass with `CLERK_EXPERIMENTAL` unset, including `cli-program.test.ts` help ordering.

- [ ] **Step 7: Commit**: `feat(migrate): add hidden migrate group behind CLERK_EXPERIMENTAL`

---

### Task 2: Schema, sources, and the transform pipeline

**Files:**

- Port as-is: `types.ts`, `validator.ts`, `validator.test.ts`, `sources/shared.ts`, `sources/clerk.ts`, `sources/supabase.ts`
- Port with trims: `sources/registry.ts`, `sources/sources.test.ts`, `lib/transform.ts`, `lib/transform.test.ts`
- Modify: `packages/cli-core/package.json`: add `"csv-parser": "^3.2.1"` and `"zod": "^4.4.3"`, then run `bun install`

**Interfaces:**

- `userSchema`, `passwordHasherEnum` (validator.ts)
- `User`, `PASSWORD_HASHERS`, `SourceEntry`, `ImportSummary`, `TransformContext` (types.ts)
- `sources`, `sourceKeys()`, `getSource(key)`, `resolveSource(value): Promise<ResolvedSource>`, `ACCOUNT_LINKING_NOTE` (registry.ts)
- `loadUsersFromFile(file, key, options?)`, `readRawUsers(file, key)`, `transformUsers(...)`, `validatePreparedUsers(...)`, `resolveImportFilePath`, `fileExists`, `getFileType` (transform.ts)

**Trims:**

- `sources/registry.ts`:
  - The `sources` array holds `clerkSource` and `supabaseSource` only.
  - Remove `customSources`, `registerCustomSource`, `__resetCustomSourcesForTesting`, `isSourcePath`, and the `loadCustomSource` import.
  - `allSources()` returns `sources`.
  - `resolveSource` keeps only the built-in branch, and its unknown-key error drops the custom-source hint.
- `lib/transform.ts`: remove the `isEnvelope` branch in `readUsersFromFile` and the `export-file.ts` import. A JSON file must be an array (or whatever a source's `preTransform` unwraps). Keep NDJSON and BOM handling.
- `sources/sources.test.ts`: keep the `shared`, `clerk`, and `supabase` cases. Drop the other sources.
- `lib/transform.test.ts`: drop the envelope cases.

`TransformContext` keeps its `firebaseHashConfig` field. It's a type, and slice 4 fills it in. `PASSWORD_HASHERS` stays the full list, including `phpass`.

- [ ] **Step 1: Port the tests, then the modules, as described in "How to port a module".** Run `bun test --isolate packages/cli-core/src/commands/migrate/validator.test.ts packages/cli-core/src/commands/migrate/sources packages/cli-core/src/commands/migrate/lib/transform.test.ts`.
- [ ] **Step 2: Check the behaviors the baseline and the review depend on.** These must pass in the ported tests; add any that are missing:
  - Supabase:
    - A `raw_user_meta_data` name splits into first and last names, and a one-word name becomes the first name. This also works on CSV input.
    - A numeric phone gains a leading `+`.
    - A soft-deleted user gets a `skipReason`.
    - An active `banned_until` becomes `banned`.
    - A bcrypt or argon2 hash keeps its hasher, and any other hash is dropped with `passwordDropped: true`.
  - Clerk:
    - Primary identifiers consolidate without nesting arrays.
    - An unverified primary email or phone stays unverified.
    - A Dashboard CSV says it carries no metadata, and the TAB the Dashboard puts before formula-like values is stripped.
  - The pipeline:
    - CSV values are coerced (lists, booleans, JSON metadata). Booleans read case-insensitively, plus `t` and `f`.
    - A numeric user ID is read as a string.
    - A BOM-prefixed CSV or JSON file reads, and NDJSON reads.
    - A file that isn't valid JSON is named in the error.
    - An unknown `passwordHasher` throws a `CliError` naming the row.
    - Unknown fields are counted in `unknownFields`.
- [ ] **Step 3: Commit**: `feat(migrate): map Clerk and Supabase files onto the import schema`

---

### Task 3: Throughput and progress

**Files:** port as-is: `lib/instance.ts`, `lib/retry.ts`, `lib/scheduler.ts`, `lib/progress.ts`, and their tests.

**Interfaces:**

- `detectInstanceType(secretKey): "dev" | "prod"`
- `resolveLimits(secretKey, env?): ResolvedLimits`
- `resolveDevUserLimit(env?)`, `DEV_USER_LIMIT = 100`, `MAX_RETRIES = 5`, `RETRY_DELAY_MS`
- `retryOn429(fn, { onRetry?, maxRetries?, defaultDelayMs? })`, `RateLimitExceededError`, `readRetryAfter`
- `createApiScheduler(concurrencyLimit, rateLimit): ApiScheduler`
- `withProgress(...)`, `formatProgress(line)`, `formatRemaining(ms)`, `ProgressCounts`, `ProgressUpdate`

**Progress bar:** it fills the line up to 80 columns, and the report under it adds an estimate of the time left. Without a terminal, the report prints at each 10%. It leaves stdin alone, so Ctrl-C reaches the CLI's handler.

- [ ] **Step 1: Port the tests, then the modules.** Run `bun test --isolate` on the four test files.
- [ ] **Step 2: Commit**: `feat(migrate): pace Backend API calls, back off on 429, and show progress`

---

### Task 4: Target resolution

**Files:**

- Port as-is: `lib/target.ts`, `lib/target.test.ts`.
- Modify: `lib/config.ts` (export `INSTANCE_ALIASES`).

**Interfaces:**

- `resolveClerkTarget(options): Promise<{ secretKey: string; target: ClerkTarget }>`
- `fetchInstanceIdentity(secretKey)`: reads `GET /v1/instance` and retries a 429. When the instance can't be read, it falls back to `key_<sha256 prefix>`.
- `describeTarget(target)`, `printTarget(target)`

`target.ts` imports `RunTarget` from `lib/run-store.ts`. Port Task 5 first, or move both into one commit.

Key sources, in the order `resolveBapiSecretKey` checks them:

1. `--secret-key`
2. `--app`
3. `CLERK_SECRET_KEY env var`
4. `accountless app (<file>)`
5. `linked profile`

- [ ] **Step 1: Port the test, then the module.** The test must cover:
  - each key source;
  - an exported `CLERK_SECRET_KEY` outranking the linked profile;
  - an `--instance` that the key from `--secret-key` or `CLERK_SECRET_KEY` doesn't address, refused with exit 2.
- [ ] **Step 2: Commit**: `feat(migrate): resolve and print the import target`

---

### Task 5: Run store (write side)

**Files:** port `lib/run-store.ts` and `lib/run-store.test.ts` with trims.

**Interfaces:**

- Constants: `RUNS_DIR_ENV`, `RUNS_DIR_FLAG`, `RUNS_DIR_DESCRIPTION`, `RUN_ID_PATTERN`
- Types: `RunKind`, `RunStatus`, `UserStatus`, `RunTarget`, `RunFile`, `RunCounts`, `RunRecord`, `PendingIdentifier`, `UserLine`, `Run`, `StartRunInit`
- Functions: `resolveRunsDir(runsDir, { write?, cwd? })`, `runDir`, `newRunId`, `sha256File`, `startRun(runsDir, init): Run`, `readRun`, `readUserLines`, `latestUserLines`, `countLines`, `liveLockPid`, `lockFile`

**Trims:** remove `continueRun`, `patchRun`, `runState`, `RunState`, `listRuns`, `clerkIdsCreatedByOtherRuns`, and their tests. Slice 2 adds them back.

Keep the full `RunKind`, `RunStatus`, and `UserStatus` unions (`import | undo | export`, `undone`, plus `deleted` and `exported`), and keep `UserLine.pending`. The run format is final in this slice.

- [ ] **Step 1: Port the test, then the module.** The tests must cover:
  - the location order;
  - `.clerk/` added to `.gitignore` once, and only when the run is written;
  - the run ID shape;
  - run folders created `0700` and exclusively, so a second run with the same ID fails;
  - a live lock refusing a second writer with exit 2, naming the lock file;
  - a lock holding this process's own PID read as stale;
  - the last line per `sourceId` winning;
  - a truncated last line being ignored;
  - a failed append throwing;
  - `finish()` setting `partial` when any user failed, was skipped, or is still `creating`, and `complete` otherwise.
- [ ] **Step 2: Commit**: `feat(migrate): keep every import as a run under .clerk/migrate`

---

### Task 6: Instance reads and the readiness report

**Files:** port as-is: `lib/clerk-config.ts`, `lib/user-lookup.ts`, `lib/supabase-providers.ts`, `lib/analysis.ts`, `lib/readiness.ts`, `lib/modify-settings.ts`, and their tests.

**Interfaces:**

- `fetchInstanceSettings(secretKey): Promise<UserSettingsJSON | null>`: BAPI `/v1/domains`, then FAPI `/v1/environment`, bootstrapping a dev browser on development instances. Returns `null` when the settings can't be read.
- `fetchUserCount(secretKey): Promise<number | null>`
- `toClerkStrategy(provider)`, `clerkOffersProvider(provider)`, `providerLabel(provider)`, `enabledSocialProviders(settings)`, `fetchEnabledSocialProviders(secretKey)`. Clerk's built-in OAuth strategies are copied from clerk_go's `api/shared/sso/oauth.go`, since nothing the CLI can call lists them.
- `lookupUsers({ filter, values, secretKey, schedule, spinner?, label? })`: batches of 100 through the scheduler and `retryOn429`. An `external_id` is looked up with a `+` prefix, so BAPI doesn't read a leading `-` as an exclusion.
- `readSupabaseRows(file)`, `findDisabledProviders`, `findUsersWithOnlyDisabledProviders`, `countSocialProviders`
- `analyzeFields(users)`, `buildReadinessReport(input)`, `buildSettingChanges(flagged)`, `buildChangePayload(changes)`

**Behavior:**

- Readiness counts users, not identifiers.
- A Supabase provider Clerk doesn't offer is named as not offered, and gets no fix.
- A fix names its instance with `--instance`, or points at the Dashboard when Clerk couldn't name the instance. This keeps a `--secret-key` import's fix from changing the linked profile's development instance.

- [ ] **Step 1: Port the tests, then the modules.**
- [ ] **Step 2: Commit**: `feat(migrate): read the instance's settings, user count and existing users`

---

### Task 7: Importer

**Files:** port `import-users.ts` and `import-users.test.ts`, trimming only what continuing a run needs. Slice 2 adds adoption back.

**Interfaces:**

- `importUsers({ users, secretKey, limits, record, skipPasswordRequirement?, validationFailed?, spinner? }): Promise<ImportSummary>`
- `splitIdentifiers(user)`, `buildCreateUserBody(user, identifiers, skipPasswordRequirement)`, `normalizeErrorMessage(message)`, `outcomeUnknown(error)`, `pendingIdentifiers(identifiers)`

**Behavior:**

- Each user writes `creating` as its `POST /v1/users` goes out, not when it's queued. It writes `created` with its Clerk ID as soon as the create returns, with any extra identifiers listed as `pending`.
- A create with no answer (an abort, a network error, or a 5xx) leaves the user at `creating`. `outcomeUnknown` decides this.
- Only the first verified email and phone go on the create. An unverified primary stays unverified. Every other identifier attaches afterwards with its own request, ahead of queued creates. An attach retries on a 429. A failed attachment adds a note to the user's line, and the user still counts as created.
- Every create sends `skip_restriction_checks`, because the allowlist and blocklist police sign-ups and these users already signed up. With `--skip-legal-checks`, it also sends `skip_legal_checks`.
- When Clerk refuses the first phone (`unsupported_country_code`, or `param_name: phone_number`) and the user has an email, the create retries without the phone and logs a note.
- A 429 retries up to 5 times, honoring `Retry-After`. When the retries run out, the user is recorded as `failed` with code `429`.
- Any other error records `failed` with the API's long message and status, and the run continues.
- Progress shows through `withProgress`, not a spinner.

- [ ] **Step 1: Port the test, then the module.** Include a test that an aborted create leaves the user at `creating`.
- [ ] **Step 2: Commit**: `feat(migrate): create users through the scheduler, one run line each`

---

### Task 8: Checks

**Files:** port `lib/checks.ts` and `lib/checks.test.ts` with trims. `checks.ts` imports `splitIdentifiers` from `import-users.ts`, which is why it comes after Task 7.

**Interfaces:**

- `checkImport(input: CheckInput): Promise<ImportChecks>`
- `hashShapeProblem(password, hasher)`, `passwordIsOnlySignIn(settings)`
- Types: `Reject`, `ReasonCount`, `Fix`, `Quota`, `ImportChecks`, `CheckInput`

**Trims:** remove `adoptedClerkIds` from `CheckInput`, along with its use in `findInstanceDuplicates`. Slice 2 adds it back with continuing. Keep `skipLegalChecks`.

**Rejects.** Each user gets the first reason that applies, in this order:

1. it failed schema validation (`invalid: …`)
2. the source set a `skipReason` (Supabase: soft-deleted)
3. its only emails are ones Clerk refuses: malformed, or a private TLD such as `.local`, `.invalid`, `.test`, `.example`, or `.arpa`. Every such user gets one fixed reason, so they group and the address stays out of the run record.
4. it lacks a verified identifier the instance requires
5. it has no identifier left once the ones the instance has turned off are removed
6. it lacks a first or last name the instance requires
7. it has a TOTP secret or backup codes, and the instance has that feature off (with a fix to turn it on)
8. it has no password, and password is the instance's only way to sign in
9. it has no legal acceptance on record, and the instance requires one. `--skip-legal-checks`, or a yes at the prompt, imports these users instead.
10. its username breaks the instance's username rules
11. its password doesn't match its hasher's shape. `bcrypt` (cost up to 15), `scrypt_firebase`, `argon2i`/`argon2id`, and `scrypt_werkzeug` are checked.
12. Supabase: its only providers aren't enabled in Clerk, or aren't offered by Clerk. The reason names only that user's own providers.
13. it repeats an earlier passing user's source ID, email, phone, or username in the file. Usernames compare case-insensitively, and phones compare with punctuation stripped. Only users that pass checks 1 to 12 claim identifiers, so a rejected record doesn't cost a later one its email. The first record wins, and the reject names it (`kept: …`).
14. the instance already has a user with its source ID, email, phone, or username
15. on a development instance, it's past the headroom (`CLERK_MIGRATE_DEV_USER_LIMIT`, default 100, minus the live count), counted in file order. When the live count can't be read, the checks say so instead of treating it as zero.

**Imported with warnings:**

- fields the instance isn't set up to store
- `Clerk won't store: <field> (N users)` for unknown fields
- passwords the source dropped
- refused emails and names, which are dropped. An email-shaped name is kept, as Clerk keeps it.
- a malformed secondary email, which is dropped. The shape check is looser than Zod's, so non-ASCII addresses Clerk accepts are kept.
- a password on an instance with passwords turned off, which is stored but works only once passwords are turned on

**Identifiers the instance has turned off** (email, phone, or username) are removed from each importable user before the create.

**Fixes** are `clerk config patch` offers built from the same readiness rows, with `--app` and `--instance` included when the target knows them. A provider Clerk doesn't offer gets no fix.

- [ ] **Step 1: Port the test, then the module.** Run `bun test --isolate packages/cli-core/src/commands/migrate/lib/checks.test.ts`.
- [ ] **Step 2: Commit**: `feat(migrate): check every user against the instance before writing`

---

### Task 9: `clerk migrate import`

**Files:**

- Port with trims: `run.ts`, `run.test.ts`, `run-interactive.test.ts`, `wizard.ts`, `wizard.test.ts`, `index.ts` (the enabled branch), `index.test.ts`
- Port as-is: `lib/assume-yes.ts`
- Modify:
  - `lib/next-steps.ts`: add `printAgentNextSteps` from `REF/lib/next-steps.ts`, plus `MIGRATE_DONE` and `MIGRATE_DONE_WITH_ERRORS` (text below)
  - `lib/spinner.ts`: ignore an empty `setNextSteps([])`
  - `lib/json-body.ts`: export `quoteArg`, for the printed commands
  - `commands/completion/__complete.ts`: complete `--source` from `sources`
  - `test/integration/completion.test.ts`
- Create: the `commands/migrate/README.md` import sections, `readme.test.ts`, and the changeset

**`index.ts`, enabled branch:**

- `migrate` group: copy the description and examples from `REF/commands/migrate/index.ts`, keeping only the examples that use `import <file>`.
- The group's `preAction` hook, as-is: it sets `-y` through `setAssumeYes`, and `--json` switches the run to agent mode.
- `import` subcommand:
  - Argument: `[file]`, "A JSON or CSV export". Not `[file|export-run-id]`; slice 3 widens it.
  - Options: `--source <key>` (no `.choices()`, so an unknown key reaches `resolveSource`'s error), `--dry-run`, `--allow-partial`, `--require-password`, `--skip-legal-checks`, `-y, --yes`, `--json`, `--secret-key <key>`, `--app <id>`, `--instance <id>`, and `RUNS_DIR_FLAG`.
  - Leave out `--new-run` (slice 2) and the `--firebase-*` flags (slice 4).
  - Examples: keep the `users.json --source clerk --allow-partial --yes` one. Drop the export-run-ID and `./my-source.ts` examples.

**`run.ts`. Keep:**

- `ensureImportTarget`: a human who isn't signed in is signed in, then an unlinked directory gets linked. An agent gets the `AuthError` naming the missing half.
- `resolveInput`, without the export-run-ID branch
- `applySource`, `validateRunOptions`, `explainErrors`, `printChecks`, `checksJson`, `formatSummary`, `commandFor`, `recordRejects`
- The legal-checks prompt: a human with users lacking legal acceptance is asked whether to import them with `skip_legal_checks`.
- The main flow: print the target, load, read settings and the user count, check, then dry-run, refuse, nothing-to-import, consent, import under `withProgress`, and summary
- `--require-password` records the users it leaves out as `skipped`.

**`run.ts`. Remove (later slices add them back):**

- `findResume`, `ResumeCase`, the `complete` early return, the continued-run bookkeeping, adopting in-flight creates by `external_id`, finishing `pending` identifiers, `continueRun`, `--new-run`, and the refusal while an undo of the matching run is unfinished (slice 2)
- `readEnvelope`, `applyEnvelope`, and `fromExport` (slice 3)
- `cleanupLines` (slice 2, alongside `undo`)
- `FirebaseHashFlags`, `resolveFirebaseHashConfig`, `promptForFirebaseHashConfig`, and the `--firebase-*` placeholders in `commandFor` (slice 4)
- `MigrateRunOptions.sourceHash`, the custom-source log line in `applySource`, and keeping a custom `--source` path in `commandFor` (slice 5)

**`wizard.ts`:** keep `promptForFile` and `promptForSource`. Remove `askNumber` and `promptForFirebaseHashConfig`.

**JSON output:** `{ target, run, checks, result }`. When a run stops before importing, it adds one of these instead of `result`: `dryRun: true`, `refused: true`, `consent: "required"`, or `nothingToImport: true`. `result` is `{ created, failed, skipped, errors: [{ error, count }] }`.

**Next steps**, until slice 2 adds `runs` and `undo`:

```ts
MIGRATE_DONE: (runFolder: string) => [`See each user's outcome in ${runFolder}/users.ndjson`],
MIGRATE_DONE_WITH_ERRORS: (runFolder: string) => [
  `See every user that failed, and why, in ${runFolder}/users.ndjson`,
],
```

**Re-running in this slice:** a second import of the same file starts a new run. The users the first run created are rejected as already in the instance, so `--allow-partial --yes` imports the rest. Users an interrupted run left at `creating` may or may not exist in Clerk. The ones that do are rejected as duplicates, and the rest import. Slice 2 replaces this with continuing the run.

- [ ] **Step 1: Port the tests with trims.**
  - `run.test.ts`: keep `validateRunOptions`, "without a file or a source", `checks`, `consent`, `explainErrors`, `--skip-legal-checks`, the `--instance` mismatch, and the Clerk and Supabase cases of "per-platform imports". Drop "export envelopes", "continuing an earlier run", adoption, `--source <path>`, and the other platforms.
  - `index.test.ts`: keep the `import` registration and the `-y` hook cases, plus Task 1's gate cases. Set `CLERK_EXPERIMENTAL=migrate` in `beforeEach` for the enabled cases.
  - `run-interactive.test.ts`, `wizard.test.ts`: drop the Firebase prompts.
- [ ] **Step 2: Add tests for the behavior this slice adds:**
  1. Importing the same file twice: the second run rejects every created user as already in the instance, and exits 2 without `--allow-partial`.
  2. `--source nope` exits 2 and lists `clerk, supabase`.
  3. In agent mode, stderr has no `\x1b[`.
  4. `--help` for `import` doesn't list `--new-run`, `--firebase-*`, or an export run ID.
- [ ] **Step 3: Run them and confirm they fail.** Run `bun test --isolate packages/cli-core/src/commands/migrate/run.test.ts packages/cli-core/src/commands/migrate/index.test.ts`.
- [ ] **Step 4: Port the modules with the trims above.** Keep `run.ts` to orchestration. Every decision it makes is already a tested function in Tasks 2 to 8.
- [ ] **Step 5: Write the README.** Port these sections from `REF/commands/migrate/README.md`, cut to slice 1:
  - the rules
  - targeting and auth
  - the run store (without `runs`, `undo`, continuing, or exports)
  - `clerk migrate import` (without re-running, export run IDs, Firebase flags, or `--new-run`)
  - checks, additional identifiers, throughput, and the progress bar
  - sources (Clerk and Supabase rows only)
  - the schema fields
  - the API endpoints `import` calls

  Put a blockquote at the top saying the command is experimental and needs `CLERK_EXPERIMENTAL=migrate`. Port `readme.test.ts`, and set `process.env.CLERK_EXPERIMENTAL = "migrate"` before it calls `createProgram()`, or it sees only the stub. It fails on any documented flag the binary rejects, and on any flag the README leaves out.

- [ ] **Step 6: Create the changeset** by invoking the `changesets` skill. It's a minor bump, and the text says the command is experimental and gated.
- [ ] **Step 7: Run every CI check**: `bun run format && bun run lint && bun run typecheck && bun run test`, then `bun changeset status --since=origin/main`.
- [ ] **Step 8: Commit**: `feat(migrate): add experimental clerk migrate import for Clerk and Supabase files`

---

### Task 10: Prove it with E2E and a baseline re-run

**Files:**

- Create: `test/e2e/migrate.test.ts`. Port the "a user whose only email is unverified is refused where email is required" case from `test/e2e/migrate.test.ts` at `7a820406`. It reads each user's latest run line per source ID, because a user's first line is `creating`. Leave the Better Auth case for slice 4d.
- Update: `/Users/manovotny/Developer/cli-migrate-testing/runs/`, adding a new run folder outside the repo.

- [ ] **Step 1: Add a Supabase round trip to the E2E test.** Follow `.claude/rules/e2e.md`:
  - Write a 2-user Supabase JSON file with fresh bcrypt hashes (`Bun.password.hash("<random>", { algorithm: "bcrypt", cost: 10 })`) and unique `+e2e-<timestamp>` emails.
  - Run `import --source supabase --dry-run --json` and assert `checks.importable === 2`.
  - Run `--yes --json` and assert `result.created === 2`.
  - Verify each password with `POST /v1/users/{id}/verify_password`.
  - Delete both users in `afterAll`.
  - Set `CLERK_EXPERIMENTAL=migrate` and `CLERK_TELEMETRY_DISABLED=1` on the subprocess env.

  Run `bun run test:e2e:op -- -t "migrate"`. It should pass. Until the `--no-env-file` PR merges to `main`, move any `.env.local` that points at a local `clerk_go` stack aside first, or the run sends the test secrets there.

- [ ] **Step 2: Build the binary.** Run `bun run build:compile`, copy `packages/cli-core/dist/clerk` to `/Users/manovotny/Developer/cli-migrate-testing/bin/clerk-slice1`, and record its `--version` next to it.
- [ ] **Step 3: Re-run the baseline tasks.** Point each sandbox wrapper at `clerk-slice1`, set `CLERK_EXPERIMENTAL=migrate` in the wrapper, and reset each task with `bun runs/baseline/harness/reset.ts <task>`. **Log out of any account CLI session first**, because the Keychain login leaks into sandboxes. Then run fresh blind agents with `runs/baseline/BLIND-PROMPT.md` on these tasks:
  - **`t05-dry-run`:** passes when zero users are written and the agent used `--dry-run` without a workaround.
  - **`t09-prod`:** passes when 20 users arrive with last names, and the agent saw "production" in the target line before writing, or stopped at the consent refusal.
  - **Supabase file:** copy `fixtures/t06-resume/users.json` into a fresh sandbox for the t06 app with an empty instance, and prompt "Import users.json from Supabase into my Clerk app." It passes when 80 users arrive with last names and their passwords verify.
  - **Quota pressure:** a 150-user Supabase file into an empty dev instance, with the same prompt. It passes when:
    - no users are written until the agent chooses `--allow-partial`;
    - the checks named the 50 users over the limit and the options (production, `--allow-partial`, `CLERK_MIGRATE_DEV_USER_LIMIT`);
    - with `--allow-partial`, exactly 100 users are created, 50 are recorded as `skipped`, and no create hits the quota error.

  Grade with `bun runs/baseline/verify.ts <task>` plus a last-name check, and audit with `bun runs/baseline/audit.ts`.

- [ ] **Step 4: Write `runs/slice1/RESULTS.md`** comparing before and after for those four tasks, in the same scorecard format as the baseline.
- [ ] **Step 5: Commit the E2E test**: `test(migrate): e2e import with dry-run, consent and password verification`
- [ ] **Step 6: After the PR merges,** install `clerk@canary` with `CLERK_EXPERIMENTAL=migrate` and re-run `t05-dry-run` against it. Then rebase slice 2 onto `main` (Branching, step 4) and mark it ready.

---

## Out of scope for slice 1

Each of these lands in a later slice:

- Continuing a stopped run, `--new-run`, adopting in-flight creates, finishing `pending` identifiers, `runs`, `undo`, and the cleanup lines after a complete import (slice 2)
- The export envelope, importing by export run ID, `export clerk`, and `export supabase` (slice 3)
- Firebase, Auth0, WorkOS, Better Auth (including Drizzle's snake_case and plural schemas), and Auth.js, including the `--firebase-*` flags and the Firebase hash prompt (slice 4)
- `--source ./file.ts` and `migrate sources` (slice 5)
- Removing the gate, the root README entry, and the docs and skills (slice 6)

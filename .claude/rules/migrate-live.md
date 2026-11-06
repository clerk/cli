---
description: Live migrate tests in test/migrate-live (real providers and Clerk instances, never PR CI)
paths:
  - "test/migrate-live/**"
  - "scripts/run-migrate-live-op.ts"
  - ".github/workflows/migrate-live.yml"
alwaysApply: false
---

`test/migrate-live/` holds live end-to-end tests of `clerk migrate`. Each one seeds a real provider (Auth0, Auth.js and Better Auth on Turso, Supabase, Firebase, WorkOS, Clerk), runs `clerk migrate export` and `import` against a real Clerk instance with this checkout's CLI, checks what landed, then undoes it. `test/migrate-live/README.md` has every test ID, dest and target.

## Never read the answer keys

**Do not open, read, grep or summarize anything in `test/migrate-live/data/custom-sources-answers/`.** It holds the answer keys and reference sources that the evals in `migration-test-apps` grade agent-written sources against. Reading them spoils those evals. Check that a file exists by its path only.

## Never in PR CI

- `bun run test` scans `packages/cli-core/src/`, `packages/extras/src/` and `scripts/`; `bun run test:e2e` scans `test/e2e/`. Keep these tests out of both: nothing here may end in `.test.ts`.
- They run weekly and on `workflow_dispatch` in `.github/workflows/migrate-live.yml`, only from `main`: the secrets are in the `migrate-live` GitHub Environment, which rejects other branches.
- PR CI only lints, typechecks and format-checks this folder. `ci.yml`'s lint job installs its deps with `bun install --frozen-lockfile --cwd test/migrate-live`.

## Running locally

```sh
bun run test:migrate-live -p better-auth -v B0   # quickest full check
bun run test:migrate-live:all                    # everything, about 1.5–2 hours
bun run test:migrate-live:custom                 # the 12 custom-source exports
bun run test:migrate-live:teardown               # empty a Clerk instance
```

These touch shared, real accounts: ask before running one. Each goes through `scripts/run-migrate-live-op.ts`, which resolves secrets from 1Password with `op run` and runs from `test/migrate-live/` (scripts read `data/` and `targets.json` relative to it).

## Env vars

Each env var's 1Password field and its `migrate-live` environment secret are named `MIGRATION_LIVE_TESTS_<ENV_VAR>`. The list is in `test/migrate-live/README.md` under "Env vars", and the same names are mapped in `scripts/run-migrate-live-op.ts` and the workflow's test step. Adding one means adding it in all three places, plus 1Password and the environment.

## Editing the tests

- This folder isn't a workspace member: it has its own `package.json` and `bun.lock`. Run `bun install` in it after changing deps.
- Its `tsconfig.json` turns `noUncheckedIndexedAccess` off: the code was ported from a repo that compiled without it.
- `data/` is generated in `migration-test-apps` (`generate-users.ts`, `generate-custom-exports.ts`) and copied in. oxfmt and oxlint ignore it. Don't edit it here.

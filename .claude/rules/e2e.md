---
description: E2E test instructions and required env vars
paths:
  - "test/e2e/**"
  - "scripts/run-tests.ts"
  - "scripts/refresh-e2e-fixtures.ts"
alwaysApply: false
---

E2E tests verify that `clerk init` produces a buildable, type-safe project with working auth for each supported framework. They live in `test/e2e/`, with fixture directories under `test/e2e/fixtures/`.

## Supported frameworks

Astro, Next.js App Router, Next.js App Router (Next 14, pinned), Next.js Pages Router, Nuxt, React (Vite), React Router, TanStack Start, Vue (Vite).

## Required env vars

```sh
CLERK_PLATFORM_API_KEY=<key>    # Platform API key (ak_* format)
CLERK_CLI_TEST_APP_ID=<app-id>  # Clerk application ID to run tests against
```

Both are required. Without `CLERK_PLATFORM_API_KEY` set, all fixture tests will fail immediately.

**Locally, prefer `bun run test:e2e:op`** (see Scripts below). It wraps `test:e2e` in `op run` and resolves `CLERK_PLATFORM_API_KEY` and `CLERK_CLI_TEST_APP_ID` from 1Password in-memory, so no plaintext secrets touch disk. Use `bun run test:e2e` directly only when those env vars are already exported (CI, or contributors without 1Password access).

### Optional env vars

```sh
CLERK_E2E_DEBUG=1                    # Enable verbose logging from test helpers
CLERK_PLATFORM_API_URL=<url>         # Override Platform API base URL (e.g. staging)
CLERK_BACKEND_API_URL=<url>          # Override Backend API base URL (bridged to CLERK_API_URL for @clerk/testing)
CLERK_FAPI=<url>                     # Override Frontend API URL for setupClerkTestingToken
E2E_HAR_DIR=<path>                   # Directory to write HAR files per fixture for network debugging
```

## Scripts

Preferred (secrets resolved from 1Password, no plaintext on disk):

```sh
bun run test:e2e:op                          # Run all fixture tests (concurrency defaults to CPU count)
bun run test:e2e:op -- --concurrency 1       # Serialize
bun run test:e2e:op -- --filter react        # Only files matching "react"
bun run test:e2e:op -- --debug               # Verbose helper logging (CLERK_E2E_DEBUG=1)
bun run test:e2e:op -- --har                 # Capture HAR files to test/e2e/.har
bun run test:e2e:op -- --har-dir ./out       # Capture HAR files to a custom directory
```

Direct (CI / contributors without 1Password — env vars must already be set):

```sh
bun run test:e2e                             # Same flags as above
```

Fixture maintenance:

```sh
bun run e2e:refresh-fixtures                             # Re-scaffold every fixture (pinned included)
bun run e2e:refresh-fixtures -- --only nextjs-app-router # Refresh one fixture
```

## Test runner (`scripts/run-tests.ts`)

A single test runner used by both `bun run test` and `bun run test:e2e`. Each test file runs as a separate `bun test` subprocess to avoid shared process state (env vars, module singletons). The runner supports:

- `--pattern <glob>` (required, repeatable): glob patterns to discover test files
- `--exclude <glob>` (repeatable): glob patterns to exclude matched files
- `--concurrency <n>` (default: CPU count): how many test files run in parallel
- `--filter <string>`: only run files whose path contains the string
- `--retries <n>` (default 0): automatic retries on failure (e2e uses 1 for transient FAPI throttling, Playwright timeouts)
- `--debug`: forwards `CLERK_E2E_DEBUG=1` to each test subprocess
- `--har`: forwards `E2E_HAR_DIR=test/e2e/.har` to each test subprocess (creates the dir if missing)
- `--har-dir <path>`: same as `--har` but writes HAR files to a custom directory

## How fixtures work

Each fixture directory contains:

- Framework source files (scaffolded by `config.scaffoldCmd`)
- A checked-in `package-lock.json` (fixtures use npm; the refresh script generates the lockfile so setup can run `npm ci`)
- A `.test.ts` file that calls `createFixtureHarness("<name>")` and passes the returned harness to `runFixtureTests()` and `runBrowserTests()`

Fixture config is no longer exported from each test file. It lives in a single manifest keyed by fixture name (`test/e2e/fixtures.manifest.ts`), which is the source of truth shared by both the test files and `scripts/refresh-e2e-fixtures.ts`. The manifest keys double as the fixture directory names (`test/e2e/fixtures/<name>/`) and as the typed argument to `createFixtureHarness()`. `createFixtureHarness(name)` looks up the entry and threads the resolved `config` and `fixtureDir` through to the setup and test helpers.

### FixtureConfig

The manifest entries satisfy `FixtureConfig`, defined in `test/e2e/lib/types.ts`:

- `scaffoldCmd` - command the refresh script uses to scaffold the project
- `clerkSdk` - Clerk SDK package name (e.g. `@clerk/nextjs`)
- `buildCmd` - build command (e.g. `["next", "build"]`)
- `devCmd` - dev server command; port flag appended automatically (`-p` for Next.js, `--port` for others)
- `notes` - explains why a pinned variant exists (required when `pinnedDependencyRanges` is set)
- `pinnedDependencyRanges` - allowed generated dependency ranges enforced when the refresh script regenerates a pinned fixture
- `packageJsonOverrides` - `package.json` `dependencies` / `devDependencies` merged in after scaffolding and before the fixture is copied

### Setup flow (`fixture-setup.ts`)

`setupFixture(name)` looks up the manifest entry, then:

1. Copy fixture to a temp directory
2. Git init and commit (so the CLI profile key is stable)
3. `clerk link --app $CLERK_CLI_TEST_APP_ID` with an isolated `CLERK_CONFIG_DIR`
4. `clerk init --yes --no-skills` (skills install is skipped so skill template files don't break framework typecheck)
5. Parse `.env` / `.env.local` for publishable and secret keys (uses `detectPublishableKeyName` / `detectSecretKeyName` from CLI source)
6. `npm ci --ignore-scripts --legacy-peer-deps` (installs from the fixture's checked-in `package-lock.json`)

### Build + typecheck test (`runFixtureTests`)

Runs the framework build command, then `tsc --noEmit`. If the fixture has a `typecheck` script in its `package.json`, that's used instead of bare `tsc` (handles React Router's `react-router typegen`).

### Browser auth test (`runBrowserTests`)

1. Creates a disposable test user via `clerk api /users -X POST` (uses `+clerk_test` email suffix for OTP bypass)
2. Starts the framework's dev server on a dynamic port
3. Launches a Playwright chromium browser
4. Uses `@clerk/testing/playwright` to set up testing tokens and run `clerk.signIn()`
5. Verifies Clerk loaded successfully after sign-in
6. Cleans up: closes browser, kills dev server, deletes test user

On failure: takes a screenshot to `/tmp/clerk-e2e-<name>-failure.png` and logs dev server stdout/stderr.

### Playwright patch

`playwright-core` is patched via `patchedDependencies` in `package.json` to work around a `route.fetch()` incompatibility under Bun. The patch file lives at `patches/playwright-core@1.58.2.patch`.

### Additional dependency

Playwright chromium must be installed: `bunx playwright install chromium`

In CI, use `bunx playwright install chromium --with-deps` to include system-level browser dependencies.

## Concurrency

Fixture files run in parallel (concurrency controlled by the runner, defaults to CPU count). Each fixture uses an isolated temp directory and `CLERK_CONFIG_DIR`, so there is no shared mutable state. Do not use `test.concurrent` within individual fixture files.

Within each test file, `createFixtureHarness()` runs `setupFixture()` once in `beforeAll` and shares the result with both the build test and browser test. This avoids duplicating the expensive setup.

## Adding a new fixture

1. Add an entry to `test/e2e/fixtures.manifest.ts` keyed by `<name>` (this drives both scaffolding and the tests)
2. Scaffold the framework via `bun run e2e:refresh-fixtures -- --only <name>` (generates `test/e2e/fixtures/<name>/`, including its `package-lock.json`)
3. Add a `<name>.test.ts` that calls `createFixtureHarness("<name>")` and passes the harness to `runFixtureTests()` and `runBrowserTests()`
4. Add a `README.md` in the fixture directory describing the project

Helper functions are in `test/e2e/lib/`:

- `fixture-setup.ts` - `setupFixture`
- `fixture-test.ts` - `createFixtureHarness`, `runFixtureTests`, `runFileExistsTest`, `runBrowserTests`
- `dev-server.ts` - `startDevServer` (allocates a port internally and retries on collision), `killDevServer`, `buildDevCommand`
- `test-user.ts` - `createTestUser`, `deleteTestUser`
- `logger.ts` - `log`, `debug` (shared logging; set `CLERK_E2E_DEBUG=1` for verbose output)
- `types.ts` - `FixtureConfig`

## CI

E2E tests run in the `test-e2e` job in `.github/workflows/ci.yml`. Key details:

- Only runs for PRs from the same repository (skipped for external forks)
- Runs on `blacksmith-8vcpu-ubuntu-2404` with a 30-minute timeout
- Requires Node.js 22 (for Playwright) alongside Bun
- Secrets `CLERK_CLI_TEST_APP_ID`, `CLERK_PLATFORM_API_KEY` are injected from GitHub Actions secrets
- Targets the production Clerk API (no `CLERK_PLATFORM_API_URL` / `CLERK_BACKEND_API_URL` overrides are set, so the defaults in `packages/cli-core/src/lib/environment.ts` apply). The local `bun run test:e2e:op` flow likewise resolves secrets from the `Clerk CLI - E2E Production Secrets` 1Password item. Test users are created with the `+clerk_test` email suffix and torn down at the end of each fixture run.

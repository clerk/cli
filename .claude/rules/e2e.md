---
description: E2E test instructions and required env vars
paths:
  - "test/e2e/**"
  - "scripts/run-e2e.ts"
  - "scripts/refresh-e2e-fixtures.ts"
alwaysApply: false
---

E2E tests verify that `clerk init` produces a buildable, type-safe project with working auth for each supported framework. They live in `test/e2e/`, with fixture directories under `test/e2e/fixtures/`.

## Supported frameworks

Astro, Next.js App Router, Next.js App Router (Next 14, pinned), Next.js Pages Router, Nuxt, React (Vite), React Router, TanStack Start, Vue (Vite).

## Required env vars

```sh
CLERK_PLATFORM_API_KEY=<key>  # Platform API key (ak_* format), OR
CLERK_CLI_TOKEN=<token>       # CLI access token (non-interactive auth)
TEST_CLERK_APP_ID=<app-id>    # Clerk application ID to run tests against
```

Set either `CLERK_PLATFORM_API_KEY` or `CLERK_CLI_TOKEN`. Without at least one, all fixture tests will fail immediately.

### Optional env vars

```sh
CLERK_E2E_DEBUG=1                    # Enable verbose logging from test helpers
CLERK_PLATFORM_API_URL=<url>         # Override Platform API base URL (e.g. staging)
CLERK_BACKEND_API_URL=<url>          # Override Backend API base URL (bridged to CLERK_API_URL for @clerk/testing)
CLERK_FAPI=<url>                     # Override Frontend API URL for setupClerkTestingToken
E2E_HAR_DIR=<path>                   # Directory to write HAR files per fixture for network debugging
```

## Scripts

```sh
bun run test:e2e                          # Run all fixture tests (concurrency 2)
bun run test:e2e -- --concurrency 4       # Run with 4 concurrent workers
bun run test:e2e -- --filter react        # Only files matching "react"
bun run e2e:refresh-fixtures              # Re-scaffold all non-pinned fixtures
bun run e2e:refresh-fixtures -- --force   # Include pinned fixtures
bun run e2e:refresh-fixtures -- --only nextjs-app-router  # Refresh one fixture
```

## Test runner (`scripts/run-e2e.ts`)

Each test file runs as a separate `bun test` subprocess to avoid shared process state (env vars, module singletons). The runner supports:

- `--concurrency <n>` (default 2): how many test files run in parallel
- `--filter <string>`: only run files whose path contains the string
- Automatic single retry on failure (handles transient FAPI throttling, Playwright timeouts)

## How fixtures work

Each fixture directory contains:

- Framework source files (scaffolded by `config.scaffoldCmd`)
- A `.test.ts` file that exports a `config: FixtureConfig` and calls `runFixtureTest()` and `runBrowserTest()`

### FixtureConfig

Defined in `test/e2e/lib/types.ts`:

- `description` - human-readable name
- `scaffoldCmd` - command the refresh script uses to scaffold the project
- `clerkSdk` - Clerk SDK package name (e.g. `@clerk/nextjs`)
- `buildCmd` - build command (e.g. `["next", "build"]`)
- `devCmd` - dev server command; port flag appended automatically (`-p` for Next.js, `--port` for others)
- `pinned` - when true, refresh script skips unless `--force` is passed
- `notes` - required when pinned, explains why this variant exists

### Setup flow (`fixture-setup.ts`)

1. Copy fixture to a temp directory
2. Git init and commit (so the CLI profile key is stable)
3. `clerk link --app $TEST_CLERK_APP_ID` with an isolated `CLERK_CONFIG_DIR`
4. `clerk init --yes`
5. Parse `.env` / `.env.local` for publishable and secret keys (uses `detectPublishableKeyName` / `detectSecretKeyName` from CLI source)
6. `bun install`

### Build + typecheck test (`runFixtureTest`)

Runs the framework build command, then `tsc --noEmit`. If the fixture has a `typecheck` script in its `package.json`, that's used instead of bare `tsc` (handles React Router's `react-router typegen`).

### Browser auth test (`runBrowserTest`)

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

Fixture files run in parallel (concurrency controlled by the runner, default 2). Each fixture uses an isolated temp directory and `CLERK_CONFIG_DIR`, so there is no shared mutable state. Do not use `test.concurrent` within individual fixture files.

Within each test file, `useFixture()` runs `setupFixture()` once in `beforeAll` and shares the result with both the build test and browser test. This avoids duplicating the expensive setup.

## Adding a new fixture

1. Create `test/e2e/fixtures/<name>/`
2. Scaffold the framework manually or via `bun run e2e:refresh-fixtures`
3. Add a `<name>.test.ts` exporting `config: FixtureConfig` and calling `runFixtureTest()` and `runBrowserTest()`
4. Add a `README.md` in the fixture directory describing the project

Helper functions are in `test/e2e/lib/`:

- `fixture-setup.ts` - `setupFixture`
- `fixture-test.ts` - `useFixture`, `runFixtureTest`, `runBrowserTest`
- `dev-server.ts` - `getAvailablePort`, `startDevServer`, `killDevServer`, `buildDevCommand`
- `test-user.ts` - `createTestUser`, `deleteTestUser`
- `logger.ts` - `log`, `debug` (shared logging; set `CLERK_E2E_DEBUG=1` for verbose output)
- `types.ts` - `FixtureConfig`

## CI

E2E tests run in the `test-e2e` job in `.github/workflows/ci.yml`. Key details:

- Only runs for PRs from the same repository (skipped for external forks)
- Runs on `blacksmith-8vcpu-ubuntu-2404` with a 30-minute timeout
- Requires Node.js 22 (for Playwright) alongside Bun
- Secrets `E2E_APP_ID`, `CLERK_PLATFORM_API_KEY` are injected from GitHub Actions secrets
- Points at the staging API (`CLERK_PLATFORM_API_URL`, `CLERK_BACKEND_API_URL` set to `https://api.clerkstage.dev`)

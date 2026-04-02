---
description: E2E test instructions and required env vars
paths:
  - "src/test/e2e/**"
alwaysApply: false
---

E2E tests verify that `clerk init` produces a buildable, type-safe project for each supported framework. They live in `src/test/e2e/fixtures/`, one directory per framework.

## Required env vars

```sh
CLERK_PLATFORM_API_KEY=<key>  # Platform API key (ak_* format), OR
CLERK_CLI_TOKEN=<token>       # CLI access token (non-interactive auth)
TEST_CLERK_APP_ID=<app-id>    # Clerk application ID to run tests against
```

Set either `CLERK_PLATFORM_API_KEY` or `CLERK_CLI_TOKEN`. Without at least one, all fixture tests will fail immediately.

## Scripts

```sh
bun run test:e2e               # Run all fixture tests (requires env vars above)
bun run e2e:refresh-fixtures   # Re-scaffold all fixtures from scratch
```

## How fixtures work

Each fixture directory contains:

- Framework source files (scaffolded by `config.scaffoldCmd`)
- A `.test.ts` file that exports a `config: FixtureConfig` and calls `runFixtureTest()`

`runFixtureTest()` runs `clerk init --yes`, then verifies the framework build command and `tsc --noEmit` both pass (build first so generated types are available for tsc).

## Browser auth tests

In addition to build/typecheck verification, each fixture runs a browser auth test via `runBrowserTest()`. This:

1. Creates a disposable test user via `clerk api /users -X POST` (uses `+clerk_test` email suffix for OTP bypass)
2. Starts the framework's dev server on a dynamic port
3. Launches a Playwright chromium browser
4. Uses `@clerk/testing/playwright` to set up testing tokens and run `clerk.signIn()`
5. Verifies Clerk loads successfully after sign-in
6. Cleans up: closes browser, kills dev server, deletes test user

Browser tests share the same fixture setup as build tests (via `useFixture()`).

### Additional dependency

Playwright chromium must be installed: `bunx playwright install chromium`

## Concurrency

Fixture files run in parallel (concurrency 2). Each fixture uses an isolated temp directory and `CLERK_CONFIG_DIR`, so there is no shared mutable state. Do not use `test.concurrent` within individual fixture files.

Within each test file, `useFixture()` runs `setupFixture()` once in `beforeAll` and shares the result with the build test. This avoids duplicating the expensive setup (clerk link, clerk init, bun install).

## Adding a new fixture

1. Create `src/test/e2e/fixtures/<name>/`
2. Scaffold the framework manually or via `bun run e2e:refresh-fixtures`
3. Add a `<name>.test.ts` exporting `config: FixtureConfig` and calling `runFixtureTest()`
4. Add a `README.md` describing the fixture

Helper functions are in `src/test/e2e/lib/`:

- `fixture-setup.ts` - `setupFixture`
- `fixture-test.ts` - `useFixture`, `runFixtureTest`, `runBrowserTest`
- `dev-server.ts` - `getAvailablePort`, `startDevServer`, `killDevServer`
- `test-user.ts` - `createTestUser`, `deleteTestUser`
- `logger.ts` - `log`, `debug` (shared logging; set `CLERK_E2E_DEBUG=1` for verbose output)
- `types.ts` - `FixtureConfig`

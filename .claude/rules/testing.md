---
description: Unit test conventions using bun:test
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "test/e2e/lib/**"
alwaysApply: false
---

Use `bun:test` for all unit and integration tests.

```ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

Run the unit and integration test suite with:

```sh
bun run test
```

This runs `bun test` with `--parallel`, which executes each test file in its own worker process, isolating module state between files. E2E fixtures are excluded and require separate setup (see `rules/e2e.md`).

When running multiple test files directly with `bun test`, always pass `--isolate` or `--parallel`. `--parallel` implies `--isolate`. Without isolation, Bun can share module mocks across files and produce order-dependent failures. These flags require Bun >= 1.3.13 — older versions silently ignore them — so `bun run test` and `bun run test:e2e` first run `scripts/check-bun-version.ts`, which fails fast when the installed Bun is older than the `engines.bun` floor in package.json.

Prefer `spyOn()` for mocking, and always restore spies in `afterAll` with `mockRestore()`.

Never use `for` or `forEach` loops inside a single test to verify multiple inputs or cases — use `test.each` (or `it.each` / `describe.each`) so each case is its own reported test case with its own name, setup/teardown, and pinpointed failure output.

```ts
// ❌ Don't
test("normalizes inputs", () => {
  for (const [input, expected] of cases) {
    expect(normalize(input)).toBe(expected);
  }
});

// ✅ Do
test.each(cases)("normalizes %s -> %s", (input, expected) => {
  expect(normalize(input)).toBe(expected);
});
```

Bun's `test.each` rejects `readonly`/`as const` arrays via its literal-inferring overload. Spread to a mutable copy so the literal union is preserved in the callback type:

```ts
const MODES = ["human", "agent"] as const;
test.each([...MODES])("mode %s", (mode) => {
  /* mode: "human" | "agent" */
});
```

Exceptions where a loop in the test body is fine:

- The iteration itself is the behavior under test (asserting an event fires N times, accumulating state across steps).
- The data being iterated is collected at runtime inside the test and cannot be expressed as a static array at module-load time (e.g. `http.requests` after the action runs, files map captured from a callback).

Telemetry must never be sent from a test. Set `CLERK_TELEMETRY_DISABLED` on every subprocess that runs the CLI:

```ts
Bun.$`bun ${CLI_PATH} link --app ${appId}`.env({
  CLERK_CONFIG_DIR: configDir,
  CLERK_TELEMETRY_DISABLED: "1",
});
```

`Bun.$.env()` replaces the environment rather than extending it, so a call site that builds its own object drops any ambient opt-out — including the workflow-level one in `.github/workflows/ci.yml`. Spreading `...process.env` inherits it instead, but only do that where the test tolerates ambient credentials: fixture setup does not, since an inherited `CLERK_SECRET_KEY` would satisfy a run whose whole purpose is resolving its own (see `rules/e2e.md`).

A source checkout sends nothing today because the dev-build guard in `telemetryEnabled()` short-circuits it, but that is a property of how the CLI was built, not of the test — a test that runs a compiled binary gets no such protection. Tests that exercise telemetry directly must delete `CLERK_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, and `CLERK_TELEMETRY_URL` from `process.env` in both `beforeEach` and `afterEach` — clearing before, not only after, is what stops a pre-set shell variable from deciding the first test's outcome. `CLERK_TELEMETRY_URL` is the one to not forget: it lifts the dev-build guard, so an ambient value turns telemetry on rather than off. `packages/cli-core/src/lib/telemetry.test.ts` has the shape.

`mock.module()` is acceptable only when registered at file top, before any consumer of the mocked module is loaded (the integration harness at `packages/cli-core/src/test/integration/lib/harness.ts` and `packages/cli-core/src/lib/credential-store.test.ts` both follow this pattern). In Bun 1.x, `mock.module()` registrations are process-lifetime and will pollute the module registry for any later test file that imports the same module via a non-mocked path, so do not call `mock.module()` from inside `beforeEach`/`describe`/`test`, and do not introduce it in test files that will run alongside files importing the real module.

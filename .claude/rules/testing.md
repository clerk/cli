---
description: Unit test conventions using bun:test
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
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

This runs each unit and integration test file as a separate `bun test` subprocess via `scripts/run-tests.ts`, isolating module state between files. E2E fixtures are excluded and require separate setup (see `rules/e2e.md`).

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

`mock.module()` is acceptable only when registered at file top, before any consumer of the mocked module is loaded (the integration harness at `packages/cli-core/src/test/integration/lib/harness.ts` and `packages/cli-core/src/lib/credential-store.test.ts` both follow this pattern). In Bun 1.x, `mock.module()` registrations are process-lifetime and will pollute the module registry for any later test file that imports the same module via a non-mocked path, so do not call `mock.module()` from inside `beforeEach`/`describe`/`test`, and do not introduce it in test files that will run alongside files importing the real module.

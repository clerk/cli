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

This runs `bun test src/commands/ src/lib/ src/mode.test.ts src/test/integration/` — it excludes e2e fixtures, which require separate setup. See `rules/e2e.md` for e2e instructions.

Use `spyOn()` for mocking, not `mock.module()`. In Bun 1.x, `mock.module()` registrations are process-lifetime and will pollute the module registry for all subsequent test files run in the same process. Always restore spies in `afterAll` with `mockRestore()`.

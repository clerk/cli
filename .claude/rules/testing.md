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

This invokes `bun test` over `packages/cli-core/src/`, loading every unit and integration test file into a single process. E2E fixtures live under `test/e2e/` and are excluded; they require separate setup (see `rules/e2e.md`).

Prefer `spyOn()` for mocking, and always restore spies in `afterAll` with `mockRestore()`.

`mock.module()` is acceptable only when registered at file top, before any consumer of the mocked module is loaded (the integration scenarios fixture at `packages/cli-core/src/test/integration/lib/scenarios.ts` and `packages/cli-core/src/lib/credential-store.test.ts` both follow this pattern). In Bun 1.x, `mock.module()` registrations are process-lifetime and will pollute the module registry for any later test file that imports the same module via a non-mocked path, so do not call `mock.module()` from inside `beforeEach`/`describe`/`test`, and do not introduce it in test files that will run alongside files importing the real module.

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

## Canonical pattern: `testRoot()`

Every command in `packages/cli-core/src/commands/` is dependency injected. Each command function takes a `(deps, opts)` signature where `deps` is a `Need<{...}>` slice of the `DepsRegistry` in `src/lib/deps.ts`. Tests construct those deps via the shared factory at `src/test/lib/test-root.ts`:

```ts
import { test, expect } from "bun:test";
import { whoami } from "./index.ts";
import { testRoot } from "../../test/lib/test-root.ts";

test("prints email when authenticated", async () => {
  const deps = testRoot({
    credentialStore: { getToken: async () => "valid-token" },
    tokenExchange: {
      fetchUserInfo: async () => ({ userId: "user_123", email: "alice@example.com" }),
    },
  });

  await whoami(deps);

  expect(deps.log.info).toHaveBeenCalledWith("alice@example.com");
});
```

`testRoot()` returns a fully-stubbed `Root` with three tiers of defaults:

- **Strict:** high-risk methods (network, subprocess, persisted state) throw if called without an override. Tests must stub them explicitly.
- **Conservative:** read-only methods return null, empty, or false by default.
- **Carve-outs:** `spinner`, `log`, `env`, and a few others get non-throwing defaults so tests run without ceremony.

Every method, default or overridden, is auto-wrapped in `mock()` so assertions like `expect(deps.log.info).toHaveBeenCalledWith(...)` work directly on the returned root.

## `mock.module()` is deprecated for command tests

The older pattern of registering file-top `mock.module()` blocks is NOT allowed in command test files. It is brittle (process-lifetime registrations can pollute other test files under the single-process runner) and redundant (`testRoot()` replaces every use case). The grep-based guard at `scripts/check-testing-patterns.ts` runs as part of `bun run lint` and fails CI if a command test file:

- Calls `mock.module(` without an entry in the allowlist.
- Does not import `testRoot` from `test/lib/test-root.ts` without an entry in the exempt list.

Legitimate exceptions (for modules intentionally outside the deps registry, e.g. `@inquirer/prompts` in api interactive tests, `lib/autolink.ts` in link tests) are maintained in `scripts/check-testing-patterns.ts`. Add new exceptions there with a comment explaining why, not inline in the test file.

## Remaining `mock.module()` use cases

A small number of places still use `mock.module()` and are not covered by the guard:

- **`src/lib/*.test.ts`**: unit tests for the underlying collaborator modules themselves. These are not command tests; they verify the plumbing that `testRoot()` stubs over.
- **`src/test/integration/lib/scenarios.ts`**: the integration harness retains two `mock.module()` entries (`credential-store`, `git`) because `lib/plapi.ts` and `lib/config.ts`/`lib/autolink.ts` still import those helpers directly. The entries disappear once those files are refactored to read through deps.

Both are registered at file top before any consumer imports the real module. Do not introduce new `mock.module()` calls from inside `beforeEach`/`describe`/`test`, and do not add them to new command test files.

## Spies

Prefer `spyOn()` for lightweight mocking of globals like `console`, and always restore spies in `afterAll` with `mockRestore()`. For command tests, prefer `testRoot()` overrides instead of spying on the collaborator modules directly.

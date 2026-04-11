---
description: Dependency injection pattern for commands/ and lib/
paths:
  - "packages/cli-core/src/commands/**"
  - "packages/cli-core/src/lib/**"
  - "packages/cli-core/src/test/lib/test-root.ts"
  - "packages/cli-core/src/cli-program.ts"
alwaysApply: false
---

Every command and every I/O-bound `lib/` module is dependency-injected. The pattern is asymmetric across the boundary: commands consume from the registry via `Need<>` slices; lib collaborators are factories that take plain interface params.

## `commands/` — consuming from Root

Every command (except `completion`, intentionally excluded) follows this shape:

```ts
import type { Need } from "../../lib/deps.ts";

export type MyCommandDeps = Need<{
  credentialStore: "getToken";
  plapi: "fetchApplication";
  log: "info";
}>;

export async function myCommand(deps: MyCommandDeps, opts: MyCommandOptions): Promise<void> {
  const token = await deps.credentialStore.getToken();
  deps.log.info("Done");
}
```

Wire in `cli-program.ts`:

```ts
.action((opts) => myCommand(root, opts));
```

Rules:

- Declare a `MyCommandDeps = Need<{...}>` slice listing the exact collaborator methods used. `Need<>` catches typos at compile time via a self-referencing constraint on the `DepsRegistry`.
- Never import directly from `lib/credential-store.ts`, `lib/plapi.ts`, `lib/config.ts`, `lib/environment.ts`, `mode.ts`, etc. Go through `deps.*`.
- `deps.log.info` / `deps.log.warn` / `deps.log.error` / `deps.log.data` instead of `console.*`.
- `deps.env.get(name)` / `deps.env.require(name)` instead of reading `process.env` directly.
- Tests use `testRoot()` from `src/test/lib/test-root.ts` with method-level overrides.

## `lib/` — implementing collaborators

Every I/O-bound lib module exports an interface and a `createX(...deps): X` factory that takes plain interface params:

```ts
// lib/plapi.ts
import type { Environment } from "./environment.ts";
import type { CredentialStore } from "./credential-store.ts";

export interface Plapi {
  fetchApplication(appId: string): Promise<Application>;
  // ...
}

export function createPlapi(env: Environment, credentialStore: CredentialStore): Plapi {
  return {
    fetchApplication: async (appId) => {
      const url = `${env.getPlapiBaseUrl()}/v1/platform/applications/${appId}`;
      const token = await credentialStore.getToken();
      // ...
    },
  };
}
```

Rules:

- Factory params are plain interface types (`Environment`, `CredentialStore`, `Plapi`, etc.). **Never `Need<>`, never `Pick<>`, never `RuntimeContext`.** `Need<>` is command-layer vocabulary for registry-wide typo catching and is wasted on 1-2 deps.
- Factories do not reach for module-level singletons of other collaborators. No `import { getCurrentEnvName } from "./environment.ts"`. Collaborator state enters via params only.
- **No eager caching** of env-derived values inside the factory closure. `switch-env` mutates env mid-session, so `env.getCurrentEnvName()` / `env.getPlapiBaseUrl()` must be read lazily on each method call, not captured at construction time. This preserves the existing call-timing contract.
- Tests construct the factory directly with a fake env (and any other deps):
  ```ts
  const plapi = createPlapi(
    { getPlapiBaseUrl: () => "https://api.test" /* ... */ },
    { getToken: async () => "tok", storeToken: async () => {}, deleteToken: async () => {} },
  );
  ```
- `createRoot` in `lib/root.ts` wires factories in topological order and produces the full `Root` object that every command receives.

## Pure-module exceptions

The following `lib/*.ts` files are exempt from the factory rule. They are consumed via static imports because they have no I/O, no mutable state, and no collaborators:

- `lib/deps.ts` — type definitions only
- `lib/errors.ts` — error classes, no I/O
- `lib/constants.ts` — literal constants
- `lib/next-steps.ts` — pure formatter over `lib/color.ts`
- `lib/color.ts` — pure formatting helpers
- `lib/log.ts` — capture scope via `AsyncLocalStorage`, not DI

If you add a new `lib/*.ts` file, decide up front: pure module or collaborator factory. Never a hybrid (an object literal that reaches for other collaborators via module-level imports).

## `scenarios.ts` invariant

The integration test harness at `packages/cli-core/src/test/integration/lib/scenarios.ts` must not register `mock.module()` entries for DI'd collaborators. If a scenario needs to stub a collaborator's behavior, the fake is threaded through the factory construction path, which is what `testRoot()` already does for every collaborator.

If you find yourself wanting to add `mock.module()` to `scenarios.ts`, convert the consumer to a factory instead.

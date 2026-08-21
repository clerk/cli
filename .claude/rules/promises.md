---
description: Type-aware oxlint rules that catch unawaited promises and unhandled rejections, and the Bun-specific gaps they have
paths:
  - "packages/*/src/**"
  - "scripts/**"
  - "test/e2e/**"
  - ".oxlintrc.json"
alwaysApply: false
---

`bun run lint` runs oxlint with `--type-aware`, which needs type information and
therefore the `oxlint-tsgolint` companion binary (a devDependency; its version
tracks the TypeScript version, currently `7.0.2001` against `typescript@7`).
Without it oxlint fails with `Failed to find tsgolint executable`. The whole
repo lints in well under a second, so the pass runs everywhere the plain lint
did: the workspace `lint` scripts, the `nano-staged` pre-commit hook, and CI.

## The rules

| Rule                                      | What it catches                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `typescript/no-floating-promises`         | A promise nobody awaits, `.catch`es, or `void`s                                                                                |
| `typescript/no-misused-promises`          | A promise passed where a `void` return is expected — async event listeners, `array.forEach(async …)`, a promise in a condition |
| `typescript/await-thenable`               | `await` on something that was never a promise                                                                                  |
| `typescript/return-await`                 | `return await` outside a `try` (redundant) or missing inside one (loses the frame)                                             |
| `typescript/prefer-promise-reject-errors` | `Promise.reject` with a non-`Error`                                                                                            |
| `typescript/promise-function-async`       | A function returning a promise that isn't declared `async`                                                                     |

`--type-aware` also switches on several type-aware `correctness` rules unrelated
to promises (`no-base-to-string`, `restrict-template-expressions`,
`unbound-method`, …). Those are explicitly `"off"` in `.oxlintrc.json` — they
have a real backlog and turning them on is a separate decision, not a side
effect of wanting promise safety.

## Fire-and-forget needs to say so

`no-floating-promises` accepts three endings: `await`, a rejection handler, or an
explicit `void`. Reach for `void` only where there is genuinely nowhere to
return the promise — a timer callback, a request handler, a shutdown path that
has already settled the flow:

```ts
setTimeout(() => void server?.stop(), 100);
```

Never register an `async` function as an event listener. `process.on` and
friends discard the return value, so a rejection lands as an unhandled rejection
with no context. Wrap it in a synchronous listener that catches — see
[interrupts.md](./interrupts.md) for the `CLI_SIGINT_HANDLER` shape.

## Where the rules are off, and why

Two rules are disabled for test files (`packages/*/src/**/*.test.ts`,
`packages/*/src/test/**`, `scripts/**/*.test.ts`, `test/e2e/**`) because Bun's
own type definitions make them fire on correct code:

- **`await-thenable`** — `bun-types` declares `expect(p).rejects.toThrow()` as
  returning `void` (`Matchers<unknown>` whose members return `void`), but at
  runtime it returns a promise; it cannot synchronously inspect a pending one.
  The `await` is load-bearing. Deleting it, as the rule suggests, turns every
  rejection test into a silent false pass. 248 sites.
- **`promise-function-async`** — test stubs are async to match the shape of the
  API they replace (`ensureMachineUuid: async () => "0000…"`), not because they
  do async work.

`no-floating-promises` stays **on** in tests, with one allowance:
`bun:test`'s `mock.module()` is typed as promise-returning but is
fire-and-forget by design, so it is listed under `allowForKnownSafeCalls`.

`typescript/require-await` is **not enabled anywhere.** It and
`promise-function-async` are mutually unsatisfiable for a function that must
return `Promise<T>` but has nothing to await — one shape trips each, and there
is no third:

```ts
async scaffold(n: number): Promise<string> { return `a${n}`; }        // require-await
scaffold(n: number): Promise<string> { return Promise.resolve(`b${n}`); } // promise-function-async
```

Such functions are common here because callback contracts demand a promise
(`FrameworkScaffold.scaffold(): Promise<ScaffoldPlan>`,
`withGutter(fn: (c) => Promise<T>)`).

## Don't `async` a memoized promise getter

`promise-function-async` will flag a getter that hands back a cached promise.
Adding `async` there allocates a fresh wrapper per call, so
`getToken() === getToken()` stops holding even though the cache still works.
`doctor/context.ts` pins that identity in its tests. Suppress instead:

```ts
// oxlint-disable-next-line typescript/promise-function-async
function resolveUserAgent(): Promise<string> {
  userAgentPromise ??= (async () => {
    /* … */
  })();
  return userAgentPromise;
}
```

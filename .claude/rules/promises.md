---
description: Type-aware oxlint rules that catch unawaited promises and unhandled rejections, and the Bun-specific gaps they have
paths:
  - "packages/*/src/**"
  - "scripts/**"
  - "test/e2e/**"
  - ".oxlintrc.json"
alwaysApply: false
---

`bun run lint` runs oxlint in type-aware mode, which needs type information and
therefore the `oxlint-tsgolint` companion binary (a devDependency; its version
tracks the TypeScript version, currently `7.0.2001` against `typescript@7`).
Without it oxlint fails with `Failed to find tsgolint executable`. The whole
repo lints in well under a second, so the pass runs everywhere the plain lint
did: the workspace `lint` scripts, the `nano-staged` pre-commit hook, and CI.

Type-aware mode is switched on by `options.typeAware` in `.oxlintrc.json`, not by
a `--type-aware` flag on each script. There are four invocation sites — the root
`lint`, the two package `lint` scripts, and the `nano-staged` hook — and a flag
that has to be repeated four times is a flag that drifts. The failure is silent:
a site that loses it runs zero type-aware rules and still exits `0`. **Only the
root config may set `options.typeAware`**; oxlint ignores it in nested configs,
so it has to live in the one config every site resolves to. The package scripts
pass no `-c` at all and find that config by walking up from their cwd.

The `lint` scripts also pass
`--report-unused-disable-directives-severity=error`, so a suppression that has
outlived its violation fails the build instead of rotting in place. Use the
`-severity=error` form, not the bare `--report-unused-disable-directives`: that
one reports at `warning`, and oxlint exits `0` on warnings, so it would never
gate anything. The pre-commit hook deliberately omits it — it lints only staged
files, and a directive is not unused just because the line it covers wasn't
staged.

## Type-aware linting needs a tsconfig that claims the file

tsgolint maps each file to the nearest `tsconfig.json` and builds a program per
project. A file no tsconfig claims is reported as `Unmatched` and **silently
skipped** — type-aware rules never run on it, and the exit code stays `0`. Run
`OXC_LOG=debug bun run lint` and check the `Done assigning files to programs`
line if you suspect a file is being skipped.

The root `tsconfig.json` is a base config with `"files": []`. It must stay that
way. Dropping that makes it default to the entire repository, so it becomes the
fallback project for every unclaimed file and builds a program of ~1300 source
files where the scoped ones need ~950. New source belongs under a directory an
existing project already includes (`packages/*/src`, `scripts`, `test/e2e`), or
it needs its own `tsconfig.json`.

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

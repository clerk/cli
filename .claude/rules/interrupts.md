---
description: Ctrl-C exit codes, the wait/work split, and how to add an interruptible operation
paths:
  - "packages/cli-core/src/lib/signals.ts"
  - "packages/cli-core/src/lib/sleep.ts"
  - "packages/cli-core/src/lib/fetch.ts"
  - "packages/cli-core/src/lib/auth-server.ts"
  - "packages/cli-core/src/commands/webhooks/**"
alwaysApply: false
---

Ctrl-C reports what the CLI was doing when it arrived:

| What was happening                                    | Exit code                   |
| ----------------------------------------------------- | --------------------------- |
| Waiting on the user — prompt, picker, browser sign-in | `0`                         |
| Waiting on a timer — countdown, poll interval         | `0`                         |
| An operation in progress — request, child process     | `130`, by dying from SIGINT |

Everything is **work** unless it says otherwise. Only wait seams annotate
themselves, so new code needs no changes to get the correct (130) default.

## Adding a wait

Wrap the promise in `whileWaiting` from `src/lib/signals.ts`. It is a counter,
so it nests and is safe to leave un-awaited at the call site:

```ts
import { whileWaiting } from "../lib/signals.ts";

waitForCallback: () => whileWaiting(callbackPromise),
```

There are only three waits today — `sleep`, `auth-server`'s
`waitForCallback`, and clack prompts (which need nothing, see below). If you
add a fourth, wrap it; otherwise interrupting it reports 130 as though real
work were cancelled.

## Adding an interruptible operation

Nothing to do. `loggedFetch` already composes `interruptSignal` into every
request, so Ctrl-C aborts in-flight HTTP. If you introduce a new abortable
primitive, pass `interruptSignal`:

```ts
import { interruptSignal } from "../lib/signals.ts";

await delay(ms, undefined, { signal: interruptSignal });
```

The one exception is `ignoreInterrupt: true` on `loggedFetch`, which exists
solely for the shutdown telemetry flush — it runs _after_ the interrupt and
reports that very interrupt, so it must outlive it. Do not add other callers.

## Exiting

Never `process.exit(130)`. Route interrupted exits through `exitInterrupted`,
which restores the default disposition and re-raises SIGINT so the process
dies with `WIFSIGNALED` set. Only a real signal death makes a wrapping shell
script stop; `exit(130)` sets `WIFEXITED` and the script keeps going.

`exitInterrupted` must `return process.exit(...)` on every early branch —
tests stub `process.exit` with a no-op, and falling through to `process.kill`
kills the test runner for real. `packages/cli-core/src/lib/signals.test.ts`
pins this.

## Prompts need nothing

`@clack/core` keeps stdin in raw mode during prompts, so Ctrl-C arrives as a
`\x03` byte and **no SIGINT is delivered**. The prompt wrappers already turn
clack's cancel symbol into `UserAbortError`, which exits 0 (see
[errors.md](./errors.md)).

Spinners were the same story until `patches/@clack%2Fcore@1.4.3.patch`: clack's
`block()` called `process.exit(0)` on that byte, swallowing the interrupt for
every spinner-wrapped command. The patch re-raises SIGINT instead. **If that
patch is ever dropped, Ctrl-C silently reports success again** — the
subprocess test in `signals.subprocess.test.ts` is what catches it.

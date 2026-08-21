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

| What was happening                                                     | Exit code                   |
| ---------------------------------------------------------------------- | --------------------------- |
| Waiting on a human — prompt, picker, browser sign-in, `$EDITOR`        | `0`                         |
| Anything else — request, timer, poll interval, child process, the tail | `130`, by dying from SIGINT |

Only **waiting on a human** is a clean exit, because nothing is in progress to
lose. Everything else is work and exits 130. Work is the default: only the two
human-wait seams annotate themselves, so new code gets 130 without doing
anything.

Two things are deliberately _not_ human waits, and both have cost a bug:

- **A timer.** A `sleep()` between polls is a step inside an operation, not the
  CLI sitting idle. When `sleep` wrapped itself in the wait seam,
  `clerk deploy status --wait` — which spends ~93s of a ~95s run asleep between
  polls — exited 0 on Ctrl-C. That command's exit code is what a script reads as
  "the deploy is complete", so `clerk deploy status --wait && ./promote.sh`
  promoted a deploy the user had just interrupted.
- **The bookkeeping tail.** The update check and telemetry flush run after the
  command's output is on screen, and a `markCommandComplete()` flag used to make
  Ctrl-C there exit 0. It no longer does: a Ctrl-C is a Ctrl-C, and the exit code
  says so. The cost is real and accepted — the update check allows 1500ms
  against the npm registry, and the shine animation another ~450ms, so every
  successful command has a roughly two-second window where Ctrl-C halts a
  wrapping script even though the command itself finished.

## Reach: clack owns Ctrl-C while it is on screen

`@clack/core` puts stdin in raw mode for both prompts and spinners, so Ctrl-C
arrives as a `\x03` byte and **the OS delivers no SIGINT at all**:

- **Prompts** return clack's cancel symbol, which the wrappers in
  `lib/prompts.ts` turn into `UserAbortError` → exit 0. This is the intended
  behavior — cancelling a prompt is a safe exit.
- **Spinners** call `block()`, which calls `process.exit(0)` outright
  (`@clack/core/dist/index.mjs`, the `isActionKey(..., "cancel")` branch).

So while a spinner is on screen — which is most of an interactive command's
runtime, since `withSpinner` wraps nearly every API call — Ctrl-C exits 0 and
none of the machinery below runs. Verified under a PTY: interrupting a
spinner-wrapped request gives `WEXITSTATUS=0`, no signal death, no telemetry.

The rules below therefore govern every interrupt that is _not_ absorbed by
clack: non-TTY and CI runs, and the stretches where no spinner is on screen —
notably `clerk init` while a project generator or package install is running,
and `clerk webhooks listen` once the relay is connected and its startup
spinner has stopped.

This split is deliberate: patching `block()` to re-raise the signal was
considered and rejected in favour of not patching a dependency.

## Adding a human wait

Wrap the promise in `whileAwaitingUser` from `src/lib/signals.ts`. It is a
counter, so it nests and is safe to leave un-awaited at the call site:

```ts
import { whileAwaitingUser } from "../lib/signals.ts";

waitForCallback: () => whileAwaitingUser(callbackPromise),
```

There are exactly two: `auth-server`'s `waitForCallback` (the browser sign-in
round-trip) and `prompts.ts`'s `$EDITOR` round-trip. Both are the CLI doing
literally nothing until a person acts.

The name is load-bearing. Its predecessor was `whileWaiting`, and `sleep()` read
as an obvious "wait" and got wrapped — which is how a poll loop came to report
success. **If the thing being awaited is a timer or a request rather than a
person, it does not belong here.**

One trap to know about: **a wait that can never settle.**
`whileAwaitingUser(callbackPromise)` in `auth-server.ts` never decrements,
because nothing rejects that promise on abort. Harmless only because the process
always exits while the wait is open. If you race such a promise and then
continue, the counter stays pinned and _every_ later Ctrl-C in that process
reports 0.

## Adding an interruptible operation

Nothing to do. `loggedFetch` already composes `interruptSignal()` into every
request, so Ctrl-C aborts in-flight HTTP. If you introduce a new abortable
primitive, pass the signal:

```ts
import { interruptSignal } from "../lib/signals.ts";

await delay(ms, undefined, { signal: interruptSignal() });
```

It is a function, not a value: `_resetInterruptState` swaps the controller
between tests, and a captured `const` would hand out a permanently-aborted
signal.

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
pins this, and `signals.subprocess.test.ts` pins the `WIFSIGNALED` contract
that the spy cannot observe.

Tests that reach `exitInterrupted` set `CLERK_CLI_NO_SIGNAL_RERAISE=1`, which
makes it plain-exit instead. Keep that name CLI-namespaced: an earlier version
keyed off `NODE_ENV === "test"`, which would have silently disabled the whole
signal-death contract for any user whose shell or CI image exports it.

Call it as `return exitInterrupted(...)` at call sites too, not just inside its
own guards. `webhooks listen`'s double-Ctrl-C branch relied on `never` for
control flow and fell through to start a second drain under a stubbed
`process.exit`.

## Reporting the interrupt

`reportAndExitInterrupted(code)` flushes telemetry on a 250ms budget and then
exits. It is the single owner of that ordering, and any handler that terminates
the process on Ctrl-C must go through it. `webhooks listen` installs its own
SIGINT handler so it can drain in-flight forwards first; before this helper
existed it called `exitInterrupted` directly, which left the one command most
likely to actually receive a SIGINT as the one that never reported it.

## Registering a handler

The sequence itself is `runInterruptSequence` — async, because awaiting the
telemetry flush is what keeps the event loop alive long enough to report the
run. **Never hand that function to `process.on` directly.** `process.on`
discards a listener's return value, so a rejection anywhere in the sequence
becomes an unhandled rejection _during shutdown_, where the user gets a stack
trace instead of their shell back.

`CLI_SIGINT_HANDLER` is the registration-safe wrapper and the identity that
gets added and removed:

```ts
process.on("SIGINT", CLI_SIGINT_HANDLER);
process.removeListener("SIGINT", CLI_SIGINT_HANDLER); // webhooks listen
```

It returns `void` and routes a failed sequence to `exitInterrupted` anyway — a
drain that could not report itself is still an interrupt. Tests that need to
observe the sequence await `runInterruptSequence()` directly.

## Printing on the way out

`runProgram` returns early the moment an interrupt is latched, handing
rendering, telemetry, and the exit to the signal handler. **A thrown error's
message therefore never reaches the terminal on an interrupt path.** If a
command has something the user needs to see — `deploy`'s "run it again to
continue" hint, `deploy status`'s partial report — it must print it as a side
effect from its own `catch`, gated on `interruptedExitCode() !== null`, before
rethrowing.

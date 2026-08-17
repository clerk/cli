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

## Adding a wait

Wrap the promise in `whileWaiting` from `src/lib/signals.ts`. It is a counter,
so it nests and is safe to leave un-awaited at the call site:

```ts
import { whileWaiting } from "../lib/signals.ts";

waitForCallback: () => whileWaiting(callbackPromise),
```

The waits today are `sleep`, `auth-server`'s `waitForCallback`, `prompts.ts`'s
`$EDITOR` round-trip, and the `gradient.ts` shine animation. If you add
another, wrap it; otherwise interrupting it reports 130 as though real work
were cancelled.

Two traps this has already hit:

- **A private `sleep` shadow.** `gradient.ts` defined its own
  `const sleep = (ms) => new Promise(...)` and so was silently classified as
  work. Grep for local timer helpers before assuming `lib/sleep.ts` covers a
  file.
- **A wait that can never settle.** `whileWaiting(callbackPromise)` in
  `auth-server.ts` never decrements, because nothing rejects that promise on
  abort. Harmless only because the process always exits while the wait is open.
  If you race such a promise and then continue, the counter stays pinned and
  _every_ later Ctrl-C in that process reports 0.

## The bookkeeping tail

`markCommandComplete()` is called from the `postAction` hook in
`cli-program.ts` the moment the command's own action finishes. Everything after
it — the update check, the telemetry flush — counts as a wait.

Without it, Ctrl-C during that tail kills a _successful_ command with a signal,
which halts any script wrapping the CLI. The window is real: the update check
alone allows 1500ms against the npm registry.

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

A `CliError` whose `exitCode` is 0 is guidance, not a failure — `deploy`'s
resumable pause is the one case. `reportError` renders it with `log.info`
rather than a red `error:` prefix, and `telemetryResultForError` reports it as
`outcome: "abort"`. Do not add a zero-exit `CliError` that is actually an
error.

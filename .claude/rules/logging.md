---
description: Logging conventions — use log.* instead of console.* in all CLI source files
paths:
  - "packages/cli-core/src/**/*.ts"
alwaysApply: false
---

All output goes through the `log` object from `src/lib/log.ts`. **Never use `console.log`, `console.error`, `console.warn`, `console.info`, or `process.stderr.write` directly** — use `log.*` methods so output respects log levels, throttling, and test capture. The `no-console` oxlint rule enforces this in production source; test files (`*.test.ts`, `src/test/**`) and `scripts/**` are exempt.

```ts
import { log } from "<relative-path>/lib/log.ts";
```

Adjust the relative path to `lib/log.ts` based on the file's location under `packages/cli-core/src/`.

## Which method to use

| Method          | Stream     | When to use                                     |
| --------------- | ---------- | ----------------------------------------------- |
| `log.data()`    | **stdout** | Pipeable output (JSON, lists, machine-readable) |
| `log.info()`    | stderr     | Status messages                                 |
| `log.success()` | stderr     | Completion confirmations (green)                |
| `log.warn()`    | stderr     | Warnings (yellow)                               |
| `log.error()`   | stderr     | Errors (red, auto-prefixed `error:`)            |
| `log.debug()`   | stderr     | Diagnostic info, only with `--verbose`          |
| `log.raw()`     | stderr     | Machine-readable JSON for agent mode            |
| `log.ui()`      | stderr     | Pre-formatted UI (spinner, intro/outro brackets) |
| `log.blank()`   | stderr     | Blank line                                      |

`log.data()` writes to **stdout** — this is what gets piped (e.g., `clerk apps list | jq`). Everything else writes to **stderr** as UI for humans. Never mix these.

## Debug logging

`log.debug()` is gated by `--verbose`. Use for diagnostic details (request URLs, timing, intermediate state):

```ts
log.debug(`Fetching instance ${instanceId}…`);
```

See [`.claude/rules/debug-logging.md`](./debug-logging.md) for the full rule: namespace format, the `loggedFetch` helper for HTTP calls, and noise-control patterns.

## Tagged loggers

`log.withTag()` adds scoped context in complex flows:

```ts
const apiLog = log.withTag("api");
apiLog.info("Fetching config…"); // [api] Fetching config…
```

## Inline highlighting

Backtick-wrapped text auto-highlights in cyan:

```ts
log.info("Linked to `my-app` on `development`");
```

## Testing log output

Use `useCaptureLog()` from `src/test/lib/stubs.ts` at file or `describe` scope. It registers `beforeEach`/`afterEach` hooks that install a fresh buffer for each test and clear it after — no per-test wiring needed:

```ts
import { useCaptureLog } from "../../test/lib/stubs.ts";

describe("my command", () => {
  const captured = useCaptureLog();

  test("outputs result", async () => {
    await myCommand();
    expect(captured.out).toContain("expected stdout"); // log.data()
    expect(captured.err).toContain("expected stderr"); // log.info/warn/etc.
  });

  test("ignores setup noise", async () => {
    await setUp();
    captured.clear();
    await myCommand();
    expect(captured.err).toContain("done");
  });
});
```

Just suppressing log noise without assertions? Call `useCaptureLog()` without keeping the return.

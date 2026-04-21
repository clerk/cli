---
description: Debug logging conventions — when to add log.debug(), format, and the loggedFetch helper
paths:
  - "packages/cli-core/src/**/*.ts"
alwaysApply: false
---

`log.debug()` is the CLI's `--verbose` channel. It exists for one job: give a Clerk engineer (or an AI agent helping them) enough context to diagnose a failed command by re-running it with `--verbose`. Well-placed debug logs make the difference between "Failed to list applications (500)" and a complete trail from config file → environment resolution → credential source → request URL → response body.

## When to add a debug log

Instrument **boundaries** where information crosses in or out of the CLI's process:

- **HTTP requests** — URL, method, status, response body on error
- **File I/O** — the path being read, written, or checked
- **External tool execution** — the command, exit code, and output on failure
- **Decisions with multiple sources** — env var vs. config file vs. hardcoded default (which won?)
- **Cache read/write state transitions** — hit/miss, stale, refreshed

Skip: pure in-memory computation, loop internals, prompt rendering, anything a caller can deduce from the logged inputs/outputs.

## Format

```ts
log.debug(`<namespace>: <message>`);
```

- `<namespace>` — tag the subsystem. Existing tags: `plapi`, `bapi`, `oauth`, `update-check`, `credentials`, `config`, `env`, `auth-server`, `git`, `autolink`, `framework`, `runners`. Add new ones sparingly.
- `<message>` — one line. Put the primary identifier (URL, path, commit) inline, not on a separate line.

Examples:

```ts
log.debug(`plapi: GET ${url}`);
log.debug(`plapi: ${response.status} GET ${url} — ${body}`);
log.debug(`credentials: found token in keyring (account=${account})`);
log.debug(`git: toplevel=${toplevel}, remote=${remote}`);
log.debug(`framework: detected "next" via dependency in package.json`);
```

Do not use `log.withTag()` for debug output. `withTag()` produces `[tag] msg` brackets which visually compete with the dim styling of debug lines. Reserve `withTag()` for `info`/`warn`/`error` output in complex flows where scoped context helps humans scan the stream.

## HTTP calls go through `loggedFetch`

All outbound HTTP in library code uses `loggedFetch` from `src/lib/fetch.ts`. It emits the `namespace: METHOD url` log before the request and the `namespace: status METHOD url — body` log on non-ok responses. The caller keeps ownership of error construction and body parsing:

```ts
import { loggedFetch } from "../lib/fetch.ts";

const response = await loggedFetch(url, {
  tag: "plapi",
  headers: { Authorization: `Bearer ${token}` },
});
if (!response.ok) {
  const body = await response.text();
  throw new PlapiError(response.status, body, url.toString());
}
return response.json();
```

**Never call `fetch()` directly in library code.** Tests are exempt. If a client has many call sites with the same auth + error pattern (e.g. plapi's six endpoints), factor a local wrapper that calls `loggedFetch` — don't duplicate the pattern six times and don't add per-call-site `log.debug` lines.

## Noise control

Debug logs only fire with `--verbose`, but when the user opts in they should be **useful**, not spammy. If a line would fire more than ~5 times per command invocation with identical content, either:

1. **Cache the underlying call** so the log fires once. See `git.ts` `getGitRepoInfo()` (module-level cache).
2. **Gate behind a module-level `let xLogged = false`** flag that flips on first emit. See `environment.ts` `profilesSourceLogged`.

Per-request logs (each HTTP call, each credential lookup) are fine as-is — they're diagnostic even when identical, because timing between them matters.

## One log per event

When a call is already logged inside `loggedFetch` (or any other primitive), don't log it again in the caller. Callers add context the primitive doesn't have — e.g. which retry attempt, which config source, which environment resolution branch — not duplicate what was already emitted.

## When to emit more than debug

If a code path is silently taking a non-obvious fallback that would confuse users (e.g. "saved environment not available, falling back to production"), emit `log.warn()` too — not just `log.debug()`. Users shouldn't need `--verbose` to learn that their configured state was ignored.

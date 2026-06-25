---
description: Command registration conventions — every command group registers via register<Name>(program) from its index.ts, listed in the registrants array
paths:
  - "packages/cli-core/src/cli-program.ts"
  - "packages/cli-core/src/commands/*/index.ts"
alwaysApply: false
---

Every command group is wired into the root program through a **registrant function**, never inline in `createProgram()`.

## The pattern

1. Each command group exports `register<Name>(program: Program): void` from `packages/cli-core/src/commands/<name>/index.ts`. It builds the whole `program.command("<name>")` subtree (options, arguments, `.setExamples()`, subcommands) and wires each `.action()` to the handler functions in sibling files.
2. `cli-program.ts` imports that function and adds it to the `registrants: CommandRegistrant[]` array. `createProgram()` only configures the root program + global hooks, then loops `for (const register of registrants) register(program)`.

**Do not** build a command tree inline inside `createProgram()`. If you're adding a `program.command(...)` (or `webhooks`-style group) directly in `cli-program.ts`, stop — move it to a `register<Name>` in the group's `index.ts` and append the function to `registrants` instead.

## `index.ts` shape

```ts
import type { Program } from "../../cli-program.ts";
import { list } from "./list.ts";
import { create } from "./create.ts";

export function registerApps(program: Program): void {
  const apps = program.command("apps").description("Manage your Clerk applications");

  apps
    .command("list")
    .description("List your Clerk applications")
    .option("--json", "Output as JSON")
    .setExamples([{ command: "clerk apps list", description: "List all applications" }])
    .action(list);

  apps.command("create").argument("<name>", "Application name").action(create);
}
```

- Import the `Program` type from `../../cli-program.ts` (type-only — no runtime cycle, this is the established pattern).
- Keep handler _logic_ in sibling files (`list.ts`, `create.ts`, …); `index.ts` is wiring only. A handler-map object (e.g. `const handlers = { list, create }`) is fine when actions need typed `Parameters<typeof handlers.x>[0]` casts.

## `cli-program.ts` shape

```ts
import { registerApps } from "./commands/apps/index.ts";
// …
const registrants: CommandRegistrant[] = [
  registerInit,
  registerApps,
  // … one entry per command group, in display order …
  registerExtras,
];

export function createProgram(): Program {
  const program = new Command() /* … global options … */ as Program;
  program.hook("preAction" /* … */);
  for (const register of registrants) register(program);
  return program;
}
```

Helpers used by only one group (e.g. `createOption`, `parseIntegerOption`, `getAuthToken`) belong in that group's `index.ts`, not imported into `cli-program.ts`.

## Groups with global options, an optional group-level hook, and subcommands

Build the group exactly as above and attach its concerns inside the same `register<Name>`: parent `.option(...)` flags inherited via `optsWithGlobals()`, an optional group `.hook("preAction", …)` for shared gating (e.g. auth), and one `.command(...)` per subcommand. See `commands/users/index.ts` (`registerUsers`) for a multi-subcommand group with a handler-map and options inherited via `optsWithGlobals()`. A group only needs a `preAction` gate when its subcommands require shared setup; auth-free groups like `commands/webhooks/index.ts` (`registerWebhooks`) — `listen` (relay tunnel) and `verify` (offline HMAC) — omit it entirely.

Related: [commands.md](./commands.md) (per-command directory + README + agent-mode rules) and [completion.md](./completion.md) (keep `.choices()` / `__complete.ts` in sync when adding commands or options).

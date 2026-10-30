---
description: Command authoring conventions — directory structure, READMEs, agent mode
paths:
  - "packages/cli-core/src/commands/**"
alwaysApply: false
---

Every CLI command lives in its own directory under `src/commands/<name>/`. Each directory must contain a `README.md` that documents:

- What the command does
- Usage and options
- Clerk API endpoints the command calls (method, path, description)
- Whether the command (or parts of it) is mocked/stubbed — call this out prominently with a blockquote at the top of the README if so

When adding a new command, create its directory and README. When modifying a command's behavior, options, or API calls, update its README to match.

## Agent mode

When creating or modifying a command, evaluate whether it needs an agent mode. Commands with interactive prompts (menus, wizards, multi-step flows) should check `isAgent()` from `src/mode.ts` and, when in agent mode, output a structured prompt that an AI agent can follow instead of running the interactive flow. Commands that are already non-interactive (e.g., single API calls, browser-based OAuth) typically don't need agent mode.

## Shell completion

When adding or modifying a command, ensure tab-completion stays correct. See `.claude/rules/completion.md` for the full guide. Short version: use `.choices()` on arguments and options so completions are automatic; only touch `__complete.ts` when `.choices()` is not suitable.

## Shipping a command behind `CLERK_EXPERIMENTAL`

A command can merge to `main`, and reach `@canary` and releases, before it's ready, behind a name in `CLERK_EXPERIMENTAL`. `src/lib/experimental.ts` holds the gate: `isExperimentEnabled(name)` and `requireExperiment(name)`. `clerk migrate` shipped this way, one slice per PR.

To gate a command:

1. In its `register<Name>`, check `isExperimentEnabled(name, env)` before building the tree. When it's off, register a hidden stub instead, and return: `program.command(name, { hidden: true })` with `.helpOption(false)`, `.allowUnknownOption()`, `.allowExcessArguments()`, `.argument("[args...]")`, and an action that calls `requireExperiment(name, env)`. Override the stub's `helpInformation` to call `requireExperiment` too, so `clerk help <name>` refuses. The stub has no subcommands, so it stays out of `clerk --help` and completion, and every invocation exits 2 with `experiment_disabled`, naming the variable to set.
2. Set `CLERK_EXPERIMENTAL=<name>` in the command's tests and E2E runs.
3. Say so in its README and every changeset: the command is experimental and needs `CLERK_EXPERIMENTAL=<name>`.

To ship it, remove the stub and the tests' `CLERK_EXPERIMENTAL` setup, add the command to the root README's help output, and write a changeset that announces it. Drop the "experimental" sentence from any of its earlier changesets that haven't been released yet. Keep `experimental.ts` for the next gated command.

## Root README

`README.md` at the project root contains the CLI help output. When commands are added, removed, or their options change, update the help output in `README.md` to stay in sync. You can regenerate it by running `bun run src/cli.ts --help`.

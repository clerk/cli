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

## Root README

`README.md` at the project root contains the CLI help output. When commands are added, removed, or their options change, update the help output in `README.md` to stay in sync. You can regenerate it by running `bun run src/cli.ts --help`.

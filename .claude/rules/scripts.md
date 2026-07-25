---
description: Script authoring conventions -- file organization, structure, lib/ utilities
paths:
  - "scripts/**/*.ts"
alwaysApply: false
---

Scripts live in `scripts/` and are invoked via `bun run scripts/<name>.ts`. Follow the conventions below when adding or modifying scripts.

## File organization

**Top-level scripts** (`scripts/*.ts`) are standalone entry points. Each script handles one task (running tests, creating snapshots, building binaries, signing, etc.) and is wired to a `package.json` script where appropriate.

**`scripts/lib/`** contains shared utilities consumed by multiple top-level scripts. Each file focuses on a single domain (e.g., `op.ts` for 1Password, `npm.ts` for the npm registry, `targets.ts` for platform targets). Move logic into `lib/` only when it is imported by more than one top-level script; otherwise keep it inline.

**Test files** (`scripts/**/*.test.ts`) are co-located next to the module they test and follow the `bun:test` conventions in `rules/testing.md`.

## Script structure

Every top-level script follows this order:

1. **JSDoc header** -- block comment describing what the script does, with `Usage:` examples.
2. **Imports** -- Bun-first APIs preferred (`Bun.spawn`/`Bun.spawnSync` over `child_process`, `Bun.file`/`Bun.write` over `node:fs`). Node.js builtins are fine when Bun has no equivalent (`parseArgs` from `node:util`, `resolve` from `node:path`).
3. **CLI argument parsing** -- `parseArgs` from `node:util` with `strict: true`. All options in a single call near the top. Validate required arguments immediately after, exit early with `process.exit(1)` and a clear error message on invalid input.
4. **Core logic** -- `Bun.spawn` for async subprocesses, `Bun.spawnSync` for synchronous. Check exit codes explicitly. Use `try/finally` when temporary state (config files, temp dirs) needs cleanup.
5. **Exit handling** -- call `process.exit(1)` for expected failures (e.g., "no test files found"). Do not throw unhandled errors for anticipated failure paths.

See `scripts/refresh-e2e-fixtures.ts` as a reference implementation.

## `lib/` utility conventions

- **No side effects on import.** Importing a `lib/` module must not trigger work (no top-level `await`, no process spawns at module scope).
- **JSDoc header** describing the module's domain and constraints.
- **Export explicit TypeScript types** for structured data (`Target`, etc.) alongside the functions that produce or consume them.
- **Co-locate constants** with the types they relate to (e.g., `SCOPE` and `PKG_PREFIX` live in `targets.ts`).
- **Same Bun-first API preferences** as top-level scripts (`Bun.spawn`, `Bun.$`, `Bun.file`).

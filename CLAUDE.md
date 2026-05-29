---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## Project Structure

This is a Bun workspace monorepo:

- `packages/cli-core/` — CLI source code, commands, and tests
- `packages/cli/` — npm wrapper package with platform binary shim (not run directly during development; do not add command logic here)
- `scripts/releaser/` — release publishing script that generates platform packages and publishes to npm

See [docs/releasing.md](docs/releasing.md) for the full release flow, channels, and safeguards.
See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, pre-release install methods, and PR guidelines.

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## CI Checks

After modifying files, run these commands to match what CI enforces on pull requests:

```sh
bun run format       # Format with oxfmt (writes changes)
bun run lint         # Lint with oxlint
bun run typecheck    # Type-check all packages and scripts
bun run test         # Run unit tests
bun run test:e2e:op  # Run E2E tests with secrets resolved from 1Password (preferred locally)
bun run test:e2e     # Run E2E tests with env vars already set (used by CI)
```

Locally, prefer `bun run test:e2e:op` so secrets are injected from 1Password in-memory and never written to disk. `bun run test:e2e` is for CI or for cases where the required env vars are already exported.

CI runs `bun run format:check` (fails if unformatted), `bun run lint`, `bun test`, and `bun run test:e2e` on every PR to `main`. E2E tests only run for PRs from the same repository (not external forks) and target the production Clerk API with a dedicated test application.

When running multiple test files directly with `bun test`, always pass `--isolate` or `--parallel`. `--parallel` implies `--isolate`. Without isolation, Bun can share module mocks across files and produce order-dependent failures. Prefer `bun run test` for the full suite because it already isolates test files through `scripts/run-tests.ts`.

## Versioning

The `CLI_VERSION` global is injected at compile time via `bun build --compile --define "CLI_VERSION=..."`. Local `build:compile` omits it, so the binary reports `0.0.0-dev`. The CI release workflow injects the real version.

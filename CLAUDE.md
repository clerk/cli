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
- Use `bun test` instead of `jest` or `vitest`
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

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

## CI Checks

After modifying files, run these commands to match what CI enforces on pull requests:

```sh
bun run format       # Format with oxfmt (writes changes)
bun run lint         # Lint with oxlint
bun test             # Run unit tests
bun run test:e2e     # Run E2E tests (requires env vars, see .claude/rules/e2e.md)
```

CI runs `bun run format:check` (fails if unformatted), `bun run lint`, `bun test`, and `bun run test:e2e` on every PR to `main`. E2E tests only run for PRs from the same repository (not external forks) and target a staging Clerk application.

## Versioning

The `CLI_VERSION` global is injected at compile time via `bun build --compile --define "CLI_VERSION=..."`. Local `build:compile` omits it, so the binary reports `0.0.0-dev`. The CI release workflow injects the real version.

## Commands

Every CLI command lives in its own directory under `packages/cli-core/src/commands/<name>/`. Each directory must contain a `README.md` that documents:

- What the command does
- Usage and options
- Clerk API endpoints the command calls (method, path, description)
- Whether the command (or parts of it) is mocked/stubbed — call this out prominently with a blockquote at the top of the README if so

When adding a new command, create its directory and README. When modifying a command's behavior, options, or API calls, update its README to match.

When creating or modifying a command, evaluate whether it needs an agent mode. Commands with interactive prompts (menus, wizards, multi-step flows) should check `isAgent()` from `packages/cli-core/src/mode.ts` and, when in agent mode, output a structured prompt that an AI agent can follow instead of running the interactive flow. Commands that are already non-interactive (e.g., single API calls, browser-based OAuth) typically don't need agent mode.

### Root README

`README.md` at the project root contains the CLI help output. When commands are added, removed, or their options change, update the help output in `README.md` to stay in sync. You can regenerate it by running `bun run dev -- --help`.

## Error Handling

All error classes and helpers live in `packages/cli-core/src/lib/errors.ts`. The global error handler in `packages/cli-core/src/cli.ts` catches thrown errors and formats them for the user. **Never call `console.error` + `process.exit` directly in commands** — throw an error instead and let the global handler deal with output and exit codes.

### Known failures — `CliError`

For user-facing errors (missing config, invalid input, resource not found), throw a `CliError`:

```ts
import { CliError } from "../../lib/errors.ts";

throw new CliError("No Clerk project linked. Run `clerk link` first.");

// With a docs URL (automatically gets .md appended in agent mode for Clerk URLs):
throw new CliError("Not authenticated.", {
  docsUrl: "https://clerk.com/docs/guides/development/clerk-environment-variables",
});
```

### Usage/validation errors — `throwUsageError`

For invalid arguments or options, use `throwUsageError` (exits with code 2):

```ts
import { throwUsageError } from "../../lib/errors.ts";

if (!secretKey) {
  throwUsageError("No secret key found. Set CLERK_SECRET_KEY or use --secret-key.");
}
```

### User cancellation — `throwUserAbort`

When the user cancels a prompt or confirmation, call `throwUserAbort()`. The global handler exits cleanly with no error output:

```ts
import { throwUserAbort } from "../../lib/errors.ts";

const confirmed = await confirm({ message: "Proceed?" });
if (!confirmed) throwUserAbort();
```

### API errors — `withApiContext`

Wrap API calls with `withApiContext` to attach a human-readable context string. The global handler extracts the first error message from the response body and prints it with the context prefix:

```ts
import { withApiContext } from "../../lib/errors.ts";

const config = await withApiContext(
  fetchInstanceConfig(appId, instanceId),
  "Failed to fetch config",
);
```

### API error classes

`BapiError` and `PlapiError` (both extend `ApiError`) are thrown by the API helpers in `packages/cli-core/src/commands/api/bapi.ts` and `packages/cli-core/src/lib/plapi.ts` respectively. Don't construct these in commands — they're thrown automatically by the fetch wrappers. Use `withApiContext` to add context when calling those helpers.

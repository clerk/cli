---
description: Error handling conventions — CliError, throwUsageError, throwUserAbort, withApiContext
paths:
  - "packages/cli-core/src/commands/**"
  - "packages/cli-core/src/lib/**"
alwaysApply: false
---

All error classes and helpers live in `src/lib/errors.ts`. The global error handler in `src/cli.ts` catches thrown errors and formats them for the user. **Never call `console.error` + `process.exit` directly in commands** — throw an error instead and let the global handler deal with output and exit codes.

## Known failures — `CliError`

For user-facing errors (missing config, invalid input, resource not found), throw a `CliError`:

```ts
import { CliError } from "../../lib/errors.ts";

throw new CliError("No Clerk project linked. Run `clerk link` first.");

// With a docs URL (automatically gets .md appended in agent mode for Clerk URLs):
throw new CliError("Not authenticated.", {
  docsUrl: "https://clerk.com/docs/guides/development/clerk-environment-variables",
});
```

## Usage/validation errors — `throwUsageError`

For invalid arguments or options, use `throwUsageError` (exits with code 2):

```ts
import { throwUsageError } from "../../lib/errors.ts";

if (!secretKey) {
  throwUsageError("No secret key found. Set CLERK_SECRET_KEY or use --secret-key.");
}
```

## User cancellation — `throwUserAbort`

When the user cancels a prompt or confirmation, call `throwUserAbort()`. The global handler exits cleanly with no error output:

```ts
import { throwUserAbort } from "../../lib/errors.ts";

const confirmed = await confirm({ message: "Proceed?" });
if (!confirmed) throwUserAbort();
```

## API errors — `withApiContext`

Wrap API calls with `withApiContext` to attach a human-readable context string. The global handler extracts the first error message from the response body and prints it with the context prefix:

```ts
import { withApiContext } from "../../lib/errors.ts";

const config = await withApiContext(
  fetchInstanceConfig(appId, instanceId),
  "Failed to fetch config",
);
```

## API error classes

`BapiError` and `PlapiError` (both extend `ApiError`) are thrown by the API helpers in `src/lib/bapi.ts` and `src/lib/plapi.ts` respectively. Don't construct these in commands — they're thrown automatically by the fetch wrappers. Use `withApiContext` to add context when calling those helpers.

/**
 * Run the e2e test suite with secrets resolved from 1Password.
 *
 * Delegates to `op run`, which scans the env for `op://` references, replaces
 * them in-memory, and execs `bun run test:e2e`. No plaintext secrets touch
 * disk.
 *
 * Usage:
 *   bun run scripts/run-e2e-op.ts                  # run the full suite
 *   bun run scripts/run-e2e-op.ts -- --filter react  # forward args to test:e2e
 */

import { ensureOpInstalled, runWithOpSecrets } from "./lib/op.ts";

await ensureOpInstalled();

const exitCode = await runWithOpSecrets(["bun", "run", "test:e2e", ...process.argv.slice(2)], {
  CLERK_PLATFORM_API_KEY:
    "op://AI Enablement/Clerk CLI - E2E Production Secrets/CLERK_PLATFORM_API_KEY",
  CLERK_CLI_TEST_APP_ID:
    "op://AI Enablement/Clerk CLI - E2E Production Secrets/CLERK_CLI_TEST_APP_ID",
});

process.exit(exitCode);

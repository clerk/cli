/**
 * Run the e2e test suite with secrets resolved from 1Password.
 *
 * Delegates to `op run`, which scans the env for `op://` references, replaces
 * them in-memory, and execs `bun run test:e2e`. No plaintext secrets touch
 * disk.
 *
 * Usage:
 *   bun run scripts/run-e2e-op.ts                          # run the full suite
 *   bun run scripts/run-e2e-op.ts -- -t "project builds"  # forward flags to `bun test`
 *
 * Args after `--` are forwarded to `bun test`, not a custom runner. The suite's
 * `test/e2e/` pattern is fixed, so a forwarded positional path is OR'd with it
 * (broadening the run); use flags like `-t <name>` to narrow instead.
 */

import { ensureOpInstalled, runWithOpSecrets } from "./lib/op.ts";

await ensureOpInstalled();

const exitCode = await runWithOpSecrets(["bun", "run", "test:e2e", ...process.argv.slice(2)], {
  CLERK_PLATFORM_API_KEY:
    "op://AI Enablement/Clerk CLI - E2E Production Secrets/CLERK_PLATFORM_API_KEY",
  CLERK_CLI_TEST_APP_ID:
    "op://AI Enablement/Clerk CLI - E2E Production Secrets/CLERK_CLI_TEST_APP_ID",
  FORCE_COLOR: "1", // ensure color in subprocess output for better readability
});

process.exit(exitCode);

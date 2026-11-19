/**
 * Run a live migrate test in `test/migrate-live/` with secrets resolved from
 * 1Password.
 *
 * Delegates to `op run`, which replaces the `op://` references below in-memory
 * and execs the command from `test/migrate-live/`. No plaintext secrets touch
 * disk. CI sets the same env vars from the `migrate-live` environment's
 * secrets instead (.github/workflows/migrate-live.yml).
 *
 * Usage (through the root package.json scripts):
 *   bun run test:migrate-live -p better-auth -v B0     one variation
 *   bun run test:migrate-live:all                      every provider, then BK1K and BK
 *   bun run test:migrate-live:custom                   the 12 custom-source exports
 *   bun run test:migrate-live:teardown                 empty a Clerk instance
 *
 * Or directly: bun run scripts/run-migrate-live-op.ts <command> [args...]
 */

import { join } from "node:path";
import { ensureOpInstalled, runWithOpSecrets } from "./lib/op.ts";

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("Usage: bun run scripts/run-migrate-live-op.ts <command> [args...]");
  process.exit(1);
}

// TEMPORARY: switch to "Shared" when the item moves out of the author's vault.
const OP_VAULT = "Employee";
const ITEM = `op://${OP_VAULT}/Clerk CLI - Migration test creds`;
const creds = (name: string) => `${ITEM}/Testing creds/MIGRATION_LIVE_TESTS_${name}`;
const serviceAccount = (name: string) => `${ITEM}/Service Accounts/MIGRATION_LIVE_TESTS_${name}`;

// Every name is an env var the tests read; its 1Password field adds the prefix.
// TODO: add CLERK_POOL_1_SECRET_KEY and CLERK_POOL_1_APP_ID (targets.json's pool) once
// that instance exists. Until then test:migrate-live:custom and the clerk provider stop
// with "CLERK_POOL_1_SECRET_KEY is not set"; everything else runs.
const names = [
  "CLERK_MIGRATE_TESTS_1_SECRET_KEY",
  "CLERK_MIGRATE_TESTS_1_APP_ID",
  "CLERK_SOURCE_SECRET_KEY",
  "CLERK_EVALS_SOURCE_APP_ID",
  "CLERK_SECRET_KEY_10K_DEV",
  "CLERK_SECRET_KEY_10K_PROD",
  "BA_TURSO_DATABASE_URL",
  "BA_TURSO_DATABASE_TOKEN",
  "AUTHJS_TURSO_DATABASE_URL",
  "AUTHJS_TURSO_DATABASE_TOKEN",
  "AUTH0_DOMAIN",
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_CONNECTION_STRING",
  "SUPABASE_ACCESS_TOKEN",
  "WORKOS_API_KEY",
];

await ensureOpInstalled();

// runWithOpSecrets spawns in the current directory; the tests read data/ and targets.json relative to it.
process.chdir(join(import.meta.dir, "../test/migrate-live"));

const exitCode = await runWithOpSecrets(command, {
  ...Object.fromEntries(names.map((name) => [name, creds(name)])),
  FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccount("FIREBASE_SERVICE_ACCOUNT_JSON"),
  FIREBASE_SERVICE_ACCOUNT_JSON_HASH_ROLE: serviceAccount(
    "FIREBASE_SERVICE_ACCOUNT_JSON_HASH_ROLE",
  ),
  CLERK_TELEMETRY_DISABLED: "1",
  FORCE_COLOR: "1",
});

process.exit(exitCode);

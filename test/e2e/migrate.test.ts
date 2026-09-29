/**
 * Live-BAPI tests for `clerk migrate import`, covering what only a real
 * instance can answer:
 *
 * - A Better Auth scrypt hash, sent as `scrypt_werkzeug`, verifies against the
 *   password it was made from. A unit test can only check the string shape.
 * - A user whose only email is unverified, imported into an instance that
 *   requires an email, is refused by Clerk. The import's checks reject that
 *   user up front on the strength of this test, so it checks both halves.
 *
 * Requires `CLERK_PLATFORM_API_KEY` and `CLERK_CLI_TEST_APP_ID`. Locally, run
 * via `bun run test:e2e:op` so 1Password resolves both in-memory.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");

let APP_ID: string;
let workDir: string;
let emailRequired = false;
const importRuns: string[] = [];

async function cli(args: string[]) {
  return Bun.$`bun ${CLI_PATH} ${args} --app ${APP_ID}`
    .env({
      ...process.env,
      CLERK_CONFIG_DIR: join(workDir, "config"),
      CLERK_MIGRATE_DIR: join(workDir, "runs"),
      CLERK_TELEMETRY_DISABLED: "1",
    })
    .cwd(workDir)
    .quiet()
    .nothrow();
}

beforeAll(async () => {
  const appId = process.env.CLERK_CLI_TEST_APP_ID;
  if (!appId || !process.env.CLERK_PLATFORM_API_KEY) {
    throw new Error(
      "CLERK_CLI_TEST_APP_ID and CLERK_PLATFORM_API_KEY are required. " +
        "Run via `bun run test:e2e:op` for local 1Password injection.",
    );
  }
  APP_ID = appId;
  workDir = mkdtempSync(join(tmpdir(), "clerk-cli-e2e-migrate-"));

  const config = await cli(["config", "pull", "--keys", "auth_email"]);
  const authEmail = (
    JSON.parse(config.stdout.toString()) as {
      auth_email?: { required_for_sign_up?: boolean };
    }
  ).auth_email;
  emailRequired = Boolean(authEmail?.required_for_sign_up);
});

// Undo every import, so the test app does not fill up with migrated users.
afterAll(async () => {
  await Promise.all(importRuns.map(async (runId) => cli(["migrate", "undo", runId, "--yes"])));
  rmSync(workDir, { recursive: true, force: true });
}, 60_000);

/** Imports `users` as a Better Auth export and returns each user's run line. */
async function importBetterAuth(users: Record<string, unknown>[], extra: string[] = []) {
  const file = join(workDir, `betterauth-${randomBytes(4).toString("hex")}.json`);
  writeFileSync(file, JSON.stringify(users));

  await cli(["migrate", "import", file, "--source", "betterauth", "--yes", ...extra]);

  const runsDir = join(workDir, "runs");
  const [runId] = readdirSync(runsDir)
    .filter(
      (id) => JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf-8")).kind === "import",
    )
    .filter((id) => !importRuns.includes(id));
  if (!runId) throw new Error("The import recorded no run.");
  importRuns.push(runId);

  return readFileSync(join(runsDir, runId, "users.ndjson"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A password hashed exactly the way Better Auth's default hasher does it. */
function betterAuthHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password.normalize("NFKC"), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  });
  return `${salt}:${key.toString("hex")}`;
}

test("a Better Auth scrypt hash imports and verifies against its password", async () => {
  const hex = randomBytes(6).toString("hex");
  const password = `Migrate${hex}!1`;

  const [line] = await importBetterAuth([
    {
      user_id: `ba_${hex}`,
      email: `${hex}+clerk_test@clerkcookie.com`,
      email_verified: true,
      password_hash: betterAuthHash(password),
    },
  ]);
  expect(line).toMatchObject({ status: "created" });

  const verify = await cli([
    "api",
    `/users/${line?.clerkId as string}/verify_password`,
    "-X",
    "POST",
    "-d",
    JSON.stringify({ password }),
  ]);
  expect(JSON.parse(verify.stdout.toString())).toMatchObject({ verified: true });
}, 60_000);

test("a user whose only email is unverified is refused where email is required", async () => {
  if (!emailRequired) {
    // The test app decides this, not the test; say so rather than pass silently.
    console.warn("Skipped: the test app's development instance does not require an email.");
    return;
  }
  const hex = randomBytes(6).toString("hex");

  // The premise: Clerk itself refuses a user created with no email, which is
  // what an unverified-only user is at `POST /v1/users`.
  const direct = await cli([
    "api",
    "/users",
    "-d",
    JSON.stringify({ external_id: `direct_${hex}`, skip_password_requirement: true }),
  ]);
  expect(direct.exitCode).not.toBe(0);

  // And the import's checks reject them before asking Clerk.
  const [line] = await importBetterAuth(
    [{ user_id: `ba_${hex}`, email: `${hex}+clerk_test@clerkcookie.com`, email_verified: false }],
    ["--allow-partial"],
  );
  expect(line).toMatchObject({
    status: "skipped",
    reason: "only has an unverified email, and this instance requires an email",
  });
}, 60_000);

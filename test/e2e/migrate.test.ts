/**
 * Live-BAPI tests for `clerk migrate import`, covering what only a real
 * instance can answer:
 *
 * - A Supabase export round-trips: the dry run counts it without writing, the
 *   import creates every user, and each bcrypt hash verifies against the
 *   password it was made from.
 * - A user whose only email is unverified, imported into an instance that
 *   requires an email, is refused by Clerk. The import's checks reject that
 *   user up front on the strength of this test, so it checks both halves.
 *
 * Requires `CLERK_PLATFORM_API_KEY` and `CLERK_CLI_TEST_APP_ID`. Locally, run
 * via `bun run test:e2e:op` so 1Password resolves both in-memory.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");

let APP_ID: string;
let workDir: string;
let emailRequired = false;
/** Every Clerk user an import created, deleted in `afterAll`. */
const createdIds: string[] = [];

async function cli(args: string[]) {
  return Bun.$`bun ${CLI_PATH} ${args} --app ${APP_ID}`
    .env({
      ...process.env,
      CLERK_CONFIG_DIR: join(workDir, "config"),
      CLERK_MIGRATE_DIR: join(workDir, "runs"),
      CLERK_EXPERIMENTAL: "migrate",
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

// Delete every imported user, so the test app does not fill up.
afterAll(async () => {
  await Promise.all(createdIds.map(async (id) => cli(["api", `/users/${id}`, "-X", "DELETE"])));
  rmSync(workDir, { recursive: true, force: true });
}, 60_000);

/**
 * Each user's latest line in run `runId`. A user has several (`creating`,
 * then `created`); the last one wins.
 */
function latestLines(runId: string): Record<string, unknown>[] {
  const latest = new Map<unknown, Record<string, unknown>>();
  for (const line of readFileSync(join(workDir, "runs", runId, "users.ndjson"), "utf-8")
    .trim()
    .split("\n")) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    latest.set(parsed.sourceId, parsed);
  }
  for (const line of latest.values()) {
    if (line.status === "created" && typeof line.clerkId === "string")
      createdIds.push(line.clerkId);
  }
  return [...latest.values()];
}

function writeExport(users: Record<string, unknown>[]): string {
  const file = join(workDir, `supabase-${randomBytes(4).toString("hex")}.json`);
  writeFileSync(file, JSON.stringify(users));
  return file;
}

test("a Supabase export dry-runs, imports, and its passwords verify", async () => {
  const users = await Promise.all(
    [0, 1].map(async () => {
      const hex = randomBytes(6).toString("hex");
      const password = `Migrate${hex}!1`;
      return {
        password,
        record: {
          id: `sb_${hex}`,
          email: `e2e-${hex}+clerk_test@clerkcookie.com`,
          email_confirmed_at: "2024-06-29 20:25:06+00",
          encrypted_password: await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 }),
        },
      };
    }),
  );
  const file = writeExport(users.map((user) => user.record));

  const dryRun = await cli([
    "migrate",
    "import",
    file,
    "--source",
    "supabase",
    "--dry-run",
    "--json",
  ]);
  expect(JSON.parse(dryRun.stdout.toString())).toMatchObject({
    dryRun: true,
    checks: { importable: 2 },
  });
  expect(readdirSync(workDir)).not.toContain("runs");

  const imported = await cli([
    "migrate",
    "import",
    file,
    "--source",
    "supabase",
    "--yes",
    "--json",
  ]);
  const result = JSON.parse(imported.stdout.toString()) as {
    run: { id: string };
    result: { created: number };
  };
  expect(result.result.created).toBe(2);

  const lines = latestLines(result.run.id);
  for (const { password, record } of users) {
    const line = lines.find((candidate) => candidate.sourceId === record.id);
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
  }
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
  const file = writeExport([{ id: `sb_${hex}`, email: `e2e-${hex}+clerk_test@clerkcookie.com` }]);
  const imported = await cli([
    "migrate",
    "import",
    file,
    "--source",
    "supabase",
    "--allow-partial",
    "--yes",
    "--json",
  ]);
  const { run } = JSON.parse(imported.stdout.toString()) as { run: { id: string } };
  expect(latestLines(run.id)).toEqual([
    expect.objectContaining({
      status: "skipped",
      reason: "only has an unverified email, and this instance requires an email",
    }),
  ]);
}, 60_000);

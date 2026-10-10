/**
 * Live-BAPI tests for `clerk migrate import`, covering what only a real
 * instance can answer:
 *
 * - A Supabase export round-trips: the dry run counts it without writing, an
 *   import without `--yes` writes nothing, the import creates every user and
 *   records the run, each bcrypt hash verifies against the password it was
 *   made from, and `undo` deletes them again.
 * - A Better Auth scrypt hash, sent as `scrypt_werkzeug`, verifies against the
 *   password it was made from. A unit test can only check the string shape.
 * - A user whose only email is unverified, imported into an instance that
 *   requires an email, is refused by Clerk. The import's checks reject that
 *   user up front on the strength of this test, so it checks both halves.
 * - The same user imported with `--reserve-unverified` is created, with that
 *   email reserved and primary. The checks let them through on the strength
 *   of this test.
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
/** Every Clerk user an import created, deleted in `afterAll`. */
const createdIds: string[] = [];

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
  const file = join(workDir, `export-${randomBytes(4).toString("hex")}.json`);
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
  expect(dryRun.exitCode).toBe(0);
  expect(JSON.parse(dryRun.stdout.toString())).toMatchObject({
    dryRun: true,
    checks: { importable: 2 },
  });
  expect(readdirSync(workDir)).not.toContain("runs");

  // Rule 1, against a real instance: without --yes nobody has consented, so
  // nothing is written, here or in Clerk.
  const unconsented = await cli(["migrate", "import", file, "--source", "supabase", "--json"]);
  expect(unconsented.exitCode).toBe(2);
  expect(JSON.parse(unconsented.stdout.toString())).toMatchObject({
    consent: "required",
    checks: { importable: 2 },
  });
  expect(readdirSync(workDir)).not.toContain("runs");
  for (const { record } of users) {
    const found = await cli(["api", `/users?external_id=${record.id}`]);
    expect(JSON.parse(found.stdout.toString())).toEqual([]);
  }

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
  // Read first: it registers the created users for cleanup, which a failed
  // assertion would otherwise skip, leaving them in the shared test app.
  const lines = latestLines(result.run.id);
  expect(imported.exitCode).toBe(0);
  expect(result.result.created).toBe(2);
  expect(
    JSON.parse(readFileSync(join(workDir, "runs", result.run.id, "run.json"), "utf-8")),
  ).toMatchObject({ status: "complete", counts: { total: 2, created: 2 } });
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

  const undo = await cli(["migrate", "undo", result.run.id, "--yes", "--json"]);
  expect(undo.exitCode).toBe(0);
  for (const { record } of users) {
    const line = lines.find((candidate) => candidate.sourceId === record.id);
    expect(typeof line?.clerkId).toBe("string");
    // Clerk's own answer, not just any failure: a wrong path or an auth error
    // would exit non-zero too. `clerk api` prints the error body to stdout.
    const gone = await cli(["api", `/users/${line?.clerkId as string}`]);
    expect(gone.exitCode).not.toBe(0);
    expect(JSON.parse(gone.stdout.toString())).toMatchObject({
      errors: [{ code: "resource_not_found" }],
    });
  }
}, 60_000);

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
  const file = writeExport([
    {
      user_id: `ba_${hex}`,
      email: `e2e-${hex}+clerk_test@clerkcookie.com`,
      email_verified: true,
      password_hash: betterAuthHash(password),
    },
  ]);

  const imported = await cli([
    "migrate",
    "import",
    file,
    "--source",
    "betterauth",
    "--yes",
    "--json",
  ]);
  const { run } = JSON.parse(imported.stdout.toString()) as { run: { id: string } };
  const [line] = latestLines(run.id);
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

test("--reserve-unverified creates an unverified-only user with the email reserved", async () => {
  const hex = randomBytes(6).toString("hex");
  const email = `e2e-${hex}+clerk_test@clerkcookie.com`;
  const file = writeExport([{ id: `sb_${hex}`, email }]);

  const imported = await cli([
    "migrate",
    "import",
    file,
    "--source",
    "supabase",
    "--reserve-unverified",
    "--yes",
    "--json",
  ]);
  const { run } = JSON.parse(imported.stdout.toString()) as { run: { id: string } };
  const [line] = latestLines(run.id);
  expect(line).toMatchObject({ status: "created" });

  const fetched = await cli(["api", `/users/${line?.clerkId as string}`]);
  const user = JSON.parse(fetched.stdout.toString()) as {
    primary_email_address_id: string;
    email_addresses: { id: string; email_address: string; reserved: boolean }[];
  };
  expect(user.email_addresses).toEqual([
    expect.objectContaining({
      id: user.primary_email_address_id,
      email_address: email,
      reserved: true,
    }),
  ]);
}, 60_000);

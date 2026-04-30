/**
 * Live-BAPI roundtrip test for `clerk users list`. Pins the response shape
 * (flat array, not a `{ data, totalCount }` wrapper) against the real Clerk
 * Backend API. If BAPI ever changes the shape, this test fails immediately
 * rather than being masked by a fixture mock.
 *
 * Requires `CLERK_PLATFORM_API_KEY` and `CLERK_CLI_TEST_APP_ID`. Locally,
 * run via `bun run test:e2e:op` so 1Password resolves both in-memory.
 */

import { test, expect, afterAll, beforeAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");
const APP_ID = process.env.CLERK_CLI_TEST_APP_ID;
const PLATFORM_KEY = process.env.CLERK_PLATFORM_API_KEY;

if (!APP_ID || !PLATFORM_KEY) {
  throw new Error(
    "CLERK_CLI_TEST_APP_ID and CLERK_PLATFORM_API_KEY are required. " +
      "Run via `bun run test:e2e:op` for local 1Password injection.",
  );
}

let configDir: string;
const createdIds: string[] = [];

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "clerk-cli-e2e-users-list-"));
});

afterAll(async () => {
  for (const id of createdIds) {
    await Bun.$`bun ${CLI_PATH} api /users/${id} -X DELETE --app ${APP_ID} --yes`
      .env({ ...process.env, CLERK_CONFIG_DIR: configDir })
      .quiet()
      .nothrow();
  }
  rmSync(configDir, { recursive: true, force: true });
});

async function createUser(): Promise<{ id: string; email: string }> {
  const hex = randomBytes(8).toString("hex");
  const email = `${hex}+clerk_test@clerkcookie.com`;
  const body = JSON.stringify({
    email_address: [email],
    password: `Test${hex}!1`,
    skip_password_checks: true,
  });
  const r = await Bun.$`bun ${CLI_PATH} users create -d ${body} --json --yes --app ${APP_ID}`
    .env({ ...process.env, CLERK_CONFIG_DIR: configDir })
    .quiet();
  const u = JSON.parse(r.stdout.toString());
  createdIds.push(u.id);
  return { id: u.id as string, email };
}

test("users list --json returns a flat array containing created users", async () => {
  const users = await Promise.all([createUser(), createUser(), createUser()]);

  const result = await Bun.$`bun ${CLI_PATH} users list --json --app ${APP_ID} \
    --user-id ${users[0].id} --user-id ${users[1].id} --user-id ${users[2].id}`
    .env({ ...process.env, CLERK_CONFIG_DIR: configDir })
    .quiet();

  const body = JSON.parse(result.stdout.toString());

  expect(Array.isArray(body)).toBe(true);
  expect(body.every((u: { id: unknown }) => typeof u.id === "string")).toBe(true);
  const returned = body.map((u: { id: string }) => u.id).sort();
  expect(returned).toEqual(users.map((u) => u.id).sort());
});

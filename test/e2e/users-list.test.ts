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
import { createTestUser, deleteTestUser } from "./lib/test-user.ts";

const FIXTURE_NAME = "users-list";
const APP_ID = process.env.CLERK_CLI_TEST_APP_ID;
const PLATFORM_KEY = process.env.CLERK_PLATFORM_API_KEY;

if (!APP_ID || !PLATFORM_KEY) {
  throw new Error(
    "CLERK_CLI_TEST_APP_ID and CLERK_PLATFORM_API_KEY are required. " +
      "Run via `bun run test:e2e:op` for local 1Password injection.",
  );
}

const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");

let configDir: string;
const createdIds: string[] = [];

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "clerk-cli-e2e-users-list-"));
});

afterAll(async () => {
  for (const id of createdIds) {
    await deleteTestUser(id, configDir, { appId: APP_ID }, FIXTURE_NAME);
  }
  rmSync(configDir, { recursive: true, force: true });
});

test("users list --json returns a flat array containing created users", async () => {
  const users = await Promise.all(
    [1, 2, 3].map(async () => {
      const u = await createTestUser(configDir, { appId: APP_ID }, FIXTURE_NAME);
      createdIds.push(u.id);
      return u;
    }),
  );

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

/**
 * Live-BAPI roundtrip test for `clerk users list`. Pins the response shape
 * (`{ data: [...users], hasMore: boolean }` envelope on top of BAPI's flat
 * user array) against the real Clerk Backend API. If BAPI's underlying
 * shape ever changes, this test fails immediately rather than being masked
 * by a fixture mock.
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
const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");

// Skip when imported by scripts/refresh-e2e-fixtures.ts; the env-var check
// and bun:test hooks below would otherwise throw on a metadata-only import.
if (!process.env.CLERK_REFRESH_FIXTURES) {
  let APP_ID!: string;
  let configDir: string;
  const createdIds: string[] = [];

  beforeAll(() => {
    const appId = process.env.CLERK_CLI_TEST_APP_ID;
    const platformKey = process.env.CLERK_PLATFORM_API_KEY;
    if (!appId || !platformKey) {
      throw new Error(
        "CLERK_CLI_TEST_APP_ID and CLERK_PLATFORM_API_KEY are required. " +
          "Run via `bun run test:e2e:op` for local 1Password injection.",
      );
    }
    APP_ID = appId;
    configDir = mkdtempSync(join(tmpdir(), "clerk-cli-e2e-users-list-"));
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await deleteTestUser(id, configDir, { appId: APP_ID }, FIXTURE_NAME);
    }
    rmSync(configDir, { recursive: true, force: true });
  });

  test("users list --json returns a { data, hasMore } envelope around the BAPI users", async () => {
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

    const body = JSON.parse(result.stdout.toString()) as {
      data: Array<{ id: unknown }>;
      hasMore: boolean;
    };

    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.hasMore).toBe("boolean");
    // Three explicit user_id filters and a 100-row default page size, so the
    // page can never overflow.
    expect(body.hasMore).toBe(false);
    expect(body.data.every((u) => typeof u.id === "string")).toBe(true);
    const returned = body.data.map((u) => u.id as string).sort();
    expect(returned).toEqual(users.map((u) => u.id).sort());
  });
}

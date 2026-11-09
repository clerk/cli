/**
 * Live-BAPI roundtrip test for `clerk logs list`. Pins the `{ data, cursor }`
 * envelope the CLI prints on top of `GET /v1/logs` against the real Clerk
 * Backend API, so a change to the logs response shape fails here rather than
 * being masked by a mock.
 *
 * Creates a user first so the instance has a recent `user.created` log no
 * matter how quiet the test application has been.
 *
 * Requires `CLERK_PLATFORM_API_KEY` and `CLERK_CLI_TEST_APP_ID`. Locally,
 * run via `bun run test:e2e:op` so 1Password resolves both in-memory.
 */

import { test, expect, afterAll, beforeAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createTestUser, deleteTestUser } from "./lib/test-user.ts";

const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");

let APP_ID: string;
let configDir: string;
let userId: string | undefined;

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
  configDir = mkdtempSync(join(tmpdir(), "clerk-cli-e2e-logs-list-"));
});

afterAll(async () => {
  if (userId) await deleteTestUser(userId, configDir, { appId: APP_ID });
  rmSync(configDir, { recursive: true, force: true });
}, 60_000);

type ListOutput = {
  data: Array<{
    object: unknown;
    id: unknown;
    event_time: unknown;
    type: unknown;
    subject: unknown;
  }>;
  cursor: {
    next: unknown;
    retention_limit_reached: unknown;
    searched_from: unknown;
    searched_to: unknown;
  };
};

test("logs list --json returns a { data, cursor } envelope around the BAPI logs", async () => {
  const user = await createTestUser(configDir, { appId: APP_ID });
  userId = user.id;

  const isUserCreated = (entry: ListOutput["data"][number]) =>
    entry.type === "user.created" && entry.subject === user.id;

  // Logs reach ClickHouse through the event stream pipeline, so the new
  // user's log can take a few seconds to show up. A failed run (a transient
  // API error or rate limit) is retried the same way.
  let output: ListOutput | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await Bun.$`bun ${CLI_PATH} logs list --json --limit 100 --app ${APP_ID}`
      .env({
        ...process.env,
        CLERK_CONFIG_DIR: configDir,
        CLERK_TELEMETRY_DISABLED: "1",
        CLERK_EXPERIMENTAL: "logs",
      })
      .nothrow()
      .quiet();
    if (result.exitCode === 0) {
      output = JSON.parse(result.stdout.toString()) as ListOutput;
      if (output.data.some(isUserCreated)) break;
    }
    await Bun.sleep(3_000);
  }

  expect(output).toBeDefined();
  expect(Array.isArray(output!.data)).toBe(true);
  expect(output!.data.length).toBeGreaterThan(0);
  expect(output!.data.length).toBeLessThanOrEqual(100);
  expect(
    output!.data.every(
      (entry) =>
        entry.object === "log" &&
        typeof entry.id === "string" &&
        typeof entry.event_time === "number" &&
        typeof entry.type === "string",
    ),
  ).toBe(true);
  expect(output!.data.some(isUserCreated)).toBe(true);

  const times = output!.data.map((entry) => entry.event_time as number);
  expect(times).toEqual([...times].sort((a, b) => b - a));

  const { cursor } = output!;
  expect(cursor.next === null || typeof cursor.next === "string").toBe(true);
  expect(typeof cursor.retention_limit_reached).toBe("boolean");
  expect(typeof cursor.searched_from).toBe("number");
  expect(typeof cursor.searched_to).toBe("number");
}, 90_000);

// Runs after the test above, so the new user's log is already queryable.
test("logs list --since keeps every log inside the window", async () => {
  const windowStart = Date.now() - 60 * 60 * 1_000;
  const result =
    await Bun.$`bun ${CLI_PATH} logs list --json --since 1h --limit 100 --app ${APP_ID}`
      .env({
        ...process.env,
        CLERK_CONFIG_DIR: configDir,
        CLERK_TELEMETRY_DISABLED: "1",
        CLERK_EXPERIMENTAL: "logs",
      })
      .quiet();
  const output = JSON.parse(result.stdout.toString()) as ListOutput;

  expect(output.data.length).toBeGreaterThan(0);
  // The CLI computes the bound a moment after windowStart, so every log is at
  // or after it.
  expect(output.data.every((entry) => (entry.event_time as number) >= windowStart)).toBe(true);
  expect(output.cursor.searched_from as number).toBeGreaterThanOrEqual(windowStart);
}, 60_000);

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
// The first `logs list --user` page that includes the new user's `user.created` log.
let listed: ListOutput | undefined;

type ListOutput = {
  data: Array<{
    object: unknown;
    id: unknown;
    event_time: unknown;
    type: unknown;
    actor?: unknown;
    subject: unknown;
    payload?: unknown;
  }>;
  cursor: {
    next: unknown;
    retention_limit_reached: unknown;
    searched_from: unknown;
    searched_to: unknown;
  };
};

function logsList(args: string[]) {
  return Bun.$`bun ${CLI_PATH} logs list --json --limit 100 --app ${APP_ID} ${args}`
    .env({
      ...process.env,
      CLERK_CONFIG_DIR: configDir,
      CLERK_TELEMETRY_DISABLED: "1",
      CLERK_EXPERIMENTAL: "logs",
    })
    .nothrow()
    .quiet();
}

// Shared setup, so each test also passes when run alone with `-t`.
beforeAll(async () => {
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

  const user = await createTestUser(configDir, { appId: APP_ID });
  userId = user.id;

  // Logs reach ClickHouse through the event stream pipeline, so the new
  // user's log can take a few seconds to show up. A failed run (a transient
  // API error or rate limit) is retried the same way. The poll is scoped to
  // the user: the test application is shared with concurrent CI runs, which
  // can push the new log out of the newest 100.
  const attempts = 10;
  let lastAttempt = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await logsList(["--user", userId]);
    if (result.exitCode === 0) {
      const output = JSON.parse(result.stdout.toString()) as ListOutput;
      if (output.data.some(isUserCreated)) {
        listed = output;
        return;
      }
      lastAttempt = `exit 0, ${output.data.length} logs, none of them user.created for ${userId}`;
    } else {
      lastAttempt = `exit ${result.exitCode}: ${result.stderr.toString().trim().slice(0, 500)}`;
    }
    if (attempt < attempts) await Bun.sleep(3_000);
  }
  throw new Error(
    `No user.created log for ${userId} after ${attempts} \`logs list\` attempts. Last attempt: ${lastAttempt}`,
  );
}, 90_000);

afterAll(async () => {
  if (userId) await deleteTestUser(userId, configDir, { appId: APP_ID });
  rmSync(configDir, { recursive: true, force: true });
}, 60_000);

function isUserCreated(entry: ListOutput["data"][number]): boolean {
  return entry.type === "user.created" && entry.subject === userId;
}

test("logs list --json returns a { data, cursor } envelope around the BAPI logs", () => {
  expect(listed).toBeDefined();
  const output = listed!;
  expect(Array.isArray(output.data)).toBe(true);
  expect(output.data.length).toBeGreaterThan(0);
  expect(output.data.length).toBeLessThanOrEqual(100);
  expect(
    output.data.every(
      (entry) =>
        entry.object === "log" &&
        typeof entry.id === "string" &&
        typeof entry.event_time === "number" &&
        typeof entry.type === "string",
    ),
  ).toBe(true);
  expect(output.data.some(isUserCreated)).toBe(true);

  const times = output.data.map((entry) => entry.event_time as number);
  expect(times).toEqual([...times].sort((a, b) => b - a));

  const { cursor } = output;
  expect(cursor.next === null || typeof cursor.next === "string").toBe(true);
  expect(typeof cursor.retention_limit_reached).toBe("boolean");
  expect(typeof cursor.searched_from).toBe("number");
  expect(typeof cursor.searched_to).toBe("number");
});

test("logs list --since keeps every log inside the window", async () => {
  const windowStart = Date.now() - 60 * 60 * 1_000;
  const result = await logsList(["--since", "1h"]);
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString()) as ListOutput;

  expect(output.data.length).toBeGreaterThan(0);
  // The CLI computes the bound a moment after windowStart, so every log is at
  // or after it.
  expect(output.data.every((entry) => (entry.event_time as number) >= windowStart)).toBe(true);
  expect(output.cursor.searched_from as number).toBeGreaterThanOrEqual(windowStart);
}, 60_000);

test("logs list --type returns only logs of that type", async () => {
  const result = await logsList(["--type", "user.created"]);
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString()) as ListOutput;

  expect(output.data.length).toBeGreaterThan(0);
  expect(output.data.every((entry) => entry.type === "user.created")).toBe(true);
}, 60_000);

test("logs list --user returns only logs about that user", async () => {
  const result = await logsList(["--user", userId!]);
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString()) as ListOutput;

  expect(output.data.some(isUserCreated)).toBe(true);
  expect(output.data.every((entry) => entry.subject === userId || entry.actor === userId)).toBe(
    true,
  );
}, 60_000);

test("logs list --payload-filter and --fields filter on and return a payload field", async () => {
  // user_id is a required field of the user.created payload.
  const result = await logsList([
    "--type",
    "user.created",
    "--payload-filter",
    `user_id=${userId}`,
    "--fields",
    "user_id",
  ]);
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString()) as ListOutput;

  expect(output.data.length).toBeGreaterThan(0);
  expect(output.data.every(isUserCreated)).toBe(true);
  expect(
    output.data.every((entry) => (entry.payload as { user_id?: unknown })?.user_id === userId),
  ).toBe(true);
}, 60_000);

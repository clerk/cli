/**
 * Live-BAPI roundtrip test for `clerk logs list --grouped`. Pins the grouped
 * view of `GET /v1/logs` (`view=grouped`) against the real Clerk Backend API:
 * the `{ data, cursor }` envelope, `log_group` items, and the `--group-type`
 * filter.
 *
 * A sign-up group only exists for a sign-up flow, and creating a user through
 * the Backend API runs none, so the test signs a user up through the Frontend
 * API of the test application's development instance instead
 * (`lib/fapi-sign-up.ts`). The sign-up's ID is the group's ID.
 *
 * Requires `CLERK_PLATFORM_API_KEY` and `CLERK_CLI_TEST_APP_ID`. Locally,
 * run via `bun run test:e2e:op` so 1Password resolves both in-memory.
 */

import { test, expect, afterAll, beforeAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { deleteTestUser } from "./lib/test-user.ts";
import { signUpThroughFapi } from "./lib/fapi-sign-up.ts";

const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");

let APP_ID: string;
let configDir: string;
let signUpId: string | undefined;
let userId: string | undefined;
// The first grouped page that includes the new sign-up's group.
let listed: GroupedOutput | undefined;

type GroupedItem = {
  object: unknown;
  group_id?: unknown;
  group_type?: unknown;
  started_at?: unknown;
  event_count?: unknown;
  status?: unknown;
  events?: Array<{ object: unknown; id: unknown; type: unknown; event_time: unknown }>;
  has_more_events?: unknown;
};

type GroupedOutput = {
  data: GroupedItem[];
  cursor: {
    next: unknown;
    retention_limit_reached: unknown;
    searched_from: unknown;
    searched_to: unknown;
  };
};

function cliEnv() {
  return {
    ...process.env,
    CLERK_CONFIG_DIR: configDir,
    CLERK_TELEMETRY_DISABLED: "1",
    CLERK_EXPERIMENTAL: "logs",
  };
}

function logsListGrouped(args: string[]) {
  return Bun.$`bun ${CLI_PATH} logs list --grouped --json --app ${APP_ID} ${args}`
    .env(cliEnv())
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
  configDir = mkdtempSync(join(tmpdir(), "clerk-cli-e2e-logs-grouped-"));

  // The sign-up's ID is the group's, so keep it even if finishing the sign-up fails.
  const signUp = await signUpThroughFapi(configDir, APP_ID, (created) => {
    signUpId = created.id;
  });
  userId = signUp.created_user_id ?? undefined;

  // Logs reach ClickHouse through the event stream pipeline, so the new
  // sign-up's group can take a few seconds to show up. Up to ~60s; a failed
  // run (a transient API error or rate limit) is retried the same way.
  const attempts = 20;
  let lastAttempt = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await logsListGrouped([
      "--group-type",
      "sign_up",
      "--since",
      "1h",
      "--limit",
      "100",
    ]);
    if (result.exitCode === 0) {
      const output = JSON.parse(result.stdout.toString()) as GroupedOutput;
      if (output.data.some(isNewSignUp)) {
        listed = output;
        return;
      }
      lastAttempt = `exit 0, ${output.data.length} items, none of them group ${signUpId}`;
    } else {
      lastAttempt = `exit ${result.exitCode}: ${result.stderr.toString().trim().slice(0, 500)}`;
    }
    if (attempt < attempts) await Bun.sleep(3_000);
  }
  throw new Error(
    `No sign_up group ${signUpId} after ${attempts} \`logs list --grouped\` attempts. Last attempt: ${lastAttempt}`,
  );
}, 120_000);

afterAll(async () => {
  if (userId) await deleteTestUser(userId, configDir, { appId: APP_ID });
  rmSync(configDir, { recursive: true, force: true });
}, 60_000);

function isNewSignUp(item: GroupedItem): boolean {
  return item.object === "log_group" && item.group_id === signUpId;
}

test("logs list --grouped --group-type sign_up --json lists the new sign-up as a log_group", () => {
  expect(listed).toBeDefined();
  const output = listed!;
  expect(output.data.length).toBeGreaterThan(0);
  expect(output.data.length).toBeLessThanOrEqual(100);

  // The group filter drops the logs outside any group, so every item is a
  // sign-up group.
  expect(output.data.every((item) => item.object === "log_group")).toBe(true);
  expect(output.data.every((item) => item.group_type === "sign_up")).toBe(true);
  expect(
    output.data.every(
      (item) =>
        typeof item.group_id === "string" &&
        item.group_id.startsWith("sua_") &&
        typeof item.started_at === "number" &&
        typeof item.event_count === "number" &&
        typeof item.has_more_events === "boolean" &&
        (item.status === null || item.status === "completed" || item.status === "failed") &&
        Array.isArray(item.events),
    ),
  ).toBe(true);

  // Groups sort by when they started, newest first.
  const starts = output.data.map((item) => item.started_at as number);
  expect(starts).toEqual([...starts].sort((a, b) => b - a));

  const group = output.data.find(isNewSignUp)!;
  expect(group.events!.length).toBeGreaterThan(0);
  expect(
    group.events!.every((event) => event.object === "log" && typeof event.id === "string"),
  ).toBe(true);
  expect(group.events!.some((event) => event.type === "sign_up.created")).toBe(true);

  const { cursor } = output;
  expect(cursor.next === null || typeof cursor.next === "string").toBe(true);
  expect(typeof cursor.retention_limit_reached).toBe("boolean");
  expect(typeof cursor.searched_from).toBe("number");
  expect(typeof cursor.searched_to).toBe("number");
});

test("logs list --grouped rejects --limit over 100 before calling the API", async () => {
  const result = await logsListGrouped(["--limit", "101"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("--limit can be at most 100 with --grouped");
});

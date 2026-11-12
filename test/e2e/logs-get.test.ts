/**
 * Live-BAPI roundtrip test for `clerk logs get <group-id>`. Pins the
 * `{ data, cursor }` envelope the CLI prints on top of
 * `GET /v1/logs/groups/{group_id}/events`, sent without `started_at`, against
 * the real Clerk Backend API.
 *
 * Signs a user up through the Frontend API of the test application's
 * development instance, so a sign-up log group exists, then reads the group by
 * the sign-up's ID.
 *
 * Requires `CLERK_PLATFORM_API_KEY` and `CLERK_CLI_TEST_APP_ID`. Locally,
 * run via `bun run test:e2e:op` so 1Password resolves both in-memory.
 */

import { test, expect, afterAll, beforeAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { signUpThroughFapi } from "./lib/fapi-sign-up.ts";
import { deleteTestUser } from "./lib/test-user.ts";

const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");

let APP_ID: string;
let configDir: string;
let signUpId: string | undefined;
let userId: string | undefined;
// The first `logs get` output that includes the sign-up's `sign_up.created` log.
let fetched: GetOutput | undefined;

type GetOutput = {
  data: Array<{
    object: unknown;
    id: unknown;
    event_time: unknown;
    type: unknown;
    group_id?: unknown;
    group_type?: unknown;
  }>;
  cursor: { next: unknown };
};

function logsGet(args: string[]) {
  return Bun.$`bun ${CLI_PATH} logs get ${args} --app ${APP_ID}`
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
  configDir = mkdtempSync(join(tmpdir(), "clerk-cli-e2e-logs-get-"));

  const signUp = await signUpThroughFapi(configDir, APP_ID, (created) => {
    signUpId = created.id;
  });
  userId = signUp.created_user_id ?? undefined;

  // Logs reach ClickHouse through the event stream pipeline, so the group is
  // a 404 until its first log lands. Up to ~60s; a failed run (the 404, a
  // transient API error or a rate limit) is retried the same way.
  const attempts = 20;
  let lastAttempt = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await logsGet([signUpId!, "--json"]);
    if (result.exitCode === 0) {
      const output = JSON.parse(result.stdout.toString()) as GetOutput;
      if (output.data.some((entry) => entry.type === "sign_up.created")) {
        fetched = output;
        return;
      }
      lastAttempt = `exit 0, ${output.data.length} logs, none of them sign_up.created`;
    } else {
      lastAttempt = `exit ${result.exitCode}: ${result.stderr.toString().trim().slice(0, 500)}`;
    }
    if (attempt < attempts) await Bun.sleep(3_000);
  }
  throw new Error(
    `No sign_up.created log in group ${signUpId} after ${attempts} \`logs get\` attempts. Last attempt: ${lastAttempt}`,
  );
}, 120_000);

afterAll(async () => {
  if (userId) await deleteTestUser(userId, configDir, { appId: APP_ID });
  rmSync(configDir, { recursive: true, force: true });
}, 60_000);

test("logs get <sign-up-id> --json returns a { data, cursor } envelope of the group's logs", () => {
  expect(fetched).toBeDefined();
  const output = fetched!;
  expect(Array.isArray(output.data)).toBe(true);
  expect(output.data.length).toBeGreaterThan(0);
  expect(
    output.data.every(
      (entry) =>
        entry.object === "log" &&
        typeof entry.id === "string" &&
        typeof entry.event_time === "number" &&
        typeof entry.type === "string" &&
        entry.group_id === signUpId &&
        entry.group_type === "sign_up",
    ),
  ).toBe(true);

  // A group's logs come oldest first.
  const times = output.data.map((entry) => entry.event_time as number);
  expect(times).toEqual([...times].sort((a, b) => a - b));

  expect(output.cursor.next === null || typeof output.cursor.next === "string").toBe(true);
});

test("logs get --limit 1 returns one log and a cursor that continues the group", async () => {
  const first = await logsGet([signUpId!, "--json", "--limit", "1"]);
  expect(first.exitCode).toBe(0);
  const page = JSON.parse(first.stdout.toString()) as GetOutput;
  expect(page.data).toHaveLength(1);
  if (fetched!.data.length < 2) return;

  expect(typeof page.cursor.next).toBe("string");
  const rest = await logsGet([signUpId!, "--json", "--cursor", page.cursor.next as string]);
  expect(rest.exitCode).toBe(0);
  const next = JSON.parse(rest.stdout.toString()) as GetOutput;
  expect(next.data.length).toBeGreaterThan(0);
  expect(next.data.every((entry) => entry.group_id === signUpId)).toBe(true);
  expect(next.data.map((entry) => entry.id)).not.toContain(page.data[0]!.id);
}, 60_000);

test("logs get with an unknown sign-up ID fails with log_group_not_found", async () => {
  const result = await logsGet(["sua_00000000000000000000000000", "--json"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("log_group_not_found");
}, 60_000);

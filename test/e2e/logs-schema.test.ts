/**
 * Live-BAPI roundtrip test for `clerk logs schema`. Pins the `log_schema`
 * object the CLI prints from `GET /v1/logs/schemas` against the real Clerk
 * Backend API, for both a wildcard and a concrete event type, and the catalog
 * it prints from `GET /v1/logs/types` when no event type is passed.
 *
 * Requires `CLERK_PLATFORM_API_KEY` and `CLERK_CLI_TEST_APP_ID`. Locally,
 * run via `bun run test:e2e:op` so 1Password resolves both in-memory.
 */

import { test, expect, afterAll, beforeAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");

let APP_ID: string;
let configDir: string;

type SchemaOutput = {
  object: unknown;
  event_type: unknown;
  description?: unknown;
  matched_event_types?: unknown;
  fields: Array<{ path: unknown; type: unknown; optional: unknown; enum?: unknown }>;
};

function logsSchema(eventType?: string) {
  const args = eventType === undefined ? [] : [eventType];
  return Bun.$`bun ${CLI_PATH} logs schema ${args} --json --app ${APP_ID}`
    .env({
      ...process.env,
      CLERK_CONFIG_DIR: configDir,
      CLERK_TELEMETRY_DISABLED: "1",
      CLERK_EXPERIMENTAL: "logs",
    })
    .nothrow()
    .quiet();
}

async function readSchema(eventType: string): Promise<SchemaOutput> {
  const result = await logsSchema(eventType);
  if (result.exitCode !== 0) {
    throw new Error(
      `\`logs schema ${eventType}\` exited ${result.exitCode}: ${result.stderr.toString().trim().slice(0, 500)}`,
    );
  }
  return JSON.parse(result.stdout.toString()) as SchemaOutput;
}

function expectWellFormedFields(fields: SchemaOutput["fields"]): void {
  expect(Array.isArray(fields)).toBe(true);
  expect(
    fields.every(
      (field) =>
        typeof field.path === "string" &&
        ["string", "boolean", "integer", "number"].includes(field.type as string) &&
        typeof field.optional === "boolean" &&
        (field.enum === undefined || Array.isArray(field.enum)),
    ),
  ).toBe(true);
}

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
  configDir = mkdtempSync(join(tmpdir(), "clerk-cli-e2e-logs-schema-"));
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
});

test("logs schema 'sign_in.*' --json returns the shared fields and the matched types", async () => {
  const output = await readSchema("sign_in.*");

  expect(output.object).toBe("log_schema");
  expect(output.event_type).toBe("sign_in.*");
  expect(Array.isArray(output.matched_event_types)).toBe(true);
  const matched = output.matched_event_types as unknown[];
  expect(matched.length).toBeGreaterThan(0);
  expect(matched.every((type) => typeof type === "string" && type.startsWith("sign_in."))).toBe(
    true,
  );
  expectWellFormedFields(output.fields);
}, 60_000);

test("logs schema user.created --json returns the fields of one event type", async () => {
  const output = await readSchema("user.created");

  expect(output.object).toBe("log_schema");
  expect(output.event_type).toBe("user.created");
  expect(typeof output.description).toBe("string");
  expect(output.fields.some((field) => field.path === "user_id")).toBe(true);
  expect(output.matched_event_types).toBeUndefined();
  expect(output.fields.length).toBeGreaterThan(0);
  expectWellFormedFields(output.fields);
}, 60_000);

test("logs schema --json lists every event type with its fields", async () => {
  const result = await logsSchema();
  if (result.exitCode !== 0) {
    throw new Error(
      `\`logs schema\` exited ${result.exitCode}: ${result.stderr.toString().trim().slice(0, 500)}`,
    );
  }
  const output = JSON.parse(result.stdout.toString()) as {
    object: unknown;
    data: SchemaOutput[];
    total_count: unknown;
  };

  expect(output.object).toBe("list");
  expect(Array.isArray(output.data)).toBe(true);
  expect(output.total_count).toBe(output.data.length);
  expect(output.data.every((entry) => entry.object === "log_schema")).toBe(true);
  const userCreated = output.data.find((entry) => entry.event_type === "user.created");
  expect(userCreated).toBeDefined();
  expect(userCreated!.fields.length).toBeGreaterThan(0);
  expectWellFormedFields(userCreated!.fields);
}, 60_000);

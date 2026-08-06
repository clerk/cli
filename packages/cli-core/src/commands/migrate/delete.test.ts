import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setConfigDir } from "../../lib/config.ts";
import { CliError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import {
  batch,
  deleteMigration,
  deleteMigratedUsers,
  findMigratedUsers,
  readMigratedExternalIds,
  resolveMigrationToUndo,
} from "./delete.ts";
import type { ResolvedLimits } from "./lib/instance.ts";
import { getLogDir } from "./lib/logger.ts";
import { saveSettings } from "./lib/settings.ts";

const captured = useCaptureLog();

const LIMITS: ResolvedLimits = { instanceType: "dev", rateLimit: 10_000, concurrencyLimit: 8 };
const DATE_TIME = "2026-01-01T00:00:00";

let workDir: string;
let configDir: string;
let originalCwd: string;
let originalFetch: typeof globalThis.fetch;
let requests: { method: string; url: string }[];

const EXPORT = [
  { id: "legacy_a", primary_email_address: "a@x.dev" },
  { id: "legacy_b", primary_email_address: "b@x.dev" },
];

beforeAll(() => {
  originalCwd = process.cwd();
  originalFetch = globalThis.fetch;
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-delete-")));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-delete-config-"));
  _setConfigDir(configDir);
  process.chdir(workDir);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  _setConfigDir(undefined);
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  fs.rmSync(getLogDir(), { recursive: true, force: true });
  fs.rmSync(path.join(configDir, "config.json"), { force: true });
  fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify(EXPORT));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exitCode = 0;
});

/**
 * Stubs BAPI: `GET /v1/users` answers with whichever of `present` the request
 * asked for, mirroring how Clerk ignores external IDs it does not find.
 */
function stubBapi(present: Record<string, string>, onDelete?: (id: string) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    requests.push({ method: init?.method ?? "GET", url });

    if (url.includes("/v1/users?")) {
      const asked = new URL(url).searchParams.getAll("external_id");
      return Response.json(
        asked
          .filter((externalId) => externalId in present)
          .map((externalId) => ({ id: present[externalId], external_id: externalId })),
      );
    }

    const match = /\/v1\/users\/([^/?]+)/.exec(url);
    if (init?.method === "DELETE" && match) {
      return onDelete ? onDelete(match[1] as string) : Response.json({ deleted: true });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
}

const logEntries = () =>
  fs
    .readdirSync(getLogDir())
    .flatMap((name) => fs.readFileSync(path.join(getLogDir(), name), "utf-8").trim().split("\n"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const deleteCalls = () => requests.filter((r) => r.method === "DELETE").map((r) => r.url);

describe("resolveMigrationToUndo", () => {
  test("reads the file and transformer from the saved migration", async () => {
    await saveSettings({ transformer: "clerk", file: "export.json" });
    expect(await resolveMigrationToUndo()).toEqual({ file: "export.json", key: "clerk" });
  });

  // Deleting nothing silently would look like a successful undo.
  test("explains when there is no saved migration at all", async () => {
    await expect(resolveMigrationToUndo()).rejects.toThrow(/no record of a previous/);
  });

  test.each([
    ["no file", { transformer: "clerk" }],
    ["no transformer", { file: "export.json" }],
  ])("explains when the saved migration has %s", async (_label, settings) => {
    await saveSettings(settings);
    await expect(resolveMigrationToUndo()).rejects.toThrow(CliError);
  });

  test("explains when the migration file has since been removed", async () => {
    await saveSettings({ transformer: "clerk", file: "gone.json" });
    await expect(resolveMigrationToUndo()).rejects.toThrow(/no longer there/);
  });
});

describe("readMigratedExternalIds", () => {
  test("returns the source IDs the import stamped as external_id", async () => {
    expect(await readMigratedExternalIds("export.json", "clerk")).toEqual(["legacy_a", "legacy_b"]);
  });

  test("uses each transformer's own id field", async () => {
    fs.writeFileSync(
      path.join(workDir, "auth0.json"),
      JSON.stringify([{ user_id: "auth0|1", email: "a@x.dev" }]),
    );
    expect(await readMigratedExternalIds("auth0.json", "auth0")).toEqual(["auth0|1"]);
  });

  // Firebase's postTransform demands the project's hash parameters; deleting
  // must not require them, so only the field mapping runs.
  test("reads a firebase export without needing its password hash parameters", async () => {
    fs.writeFileSync(
      path.join(workDir, "firebase.json"),
      JSON.stringify({
        users: [{ localId: "fb1", email: "a@x.dev", passwordHash: "H", salt: "S" }],
      }),
    );
    expect(await readMigratedExternalIds("firebase.json", "firebase")).toEqual(["fb1"]);
  });

  test("dedupes repeated IDs", async () => {
    fs.writeFileSync(
      path.join(workDir, "dupes.json"),
      JSON.stringify([{ id: "legacy_a" }, { id: "legacy_a" }]),
    );
    expect(await readMigratedExternalIds("dupes.json", "clerk")).toEqual(["legacy_a"]);
  });

  test("skips rows with no ID rather than matching on an empty string", async () => {
    fs.writeFileSync(
      path.join(workDir, "partial.json"),
      JSON.stringify([{ id: "legacy_a" }, { primary_email_address: "b@x.dev" }, { id: "" }]),
    );
    expect(await readMigratedExternalIds("partial.json", "clerk")).toEqual(["legacy_a"]);
  });
});

describe("batch", () => {
  test.each([
    [0, 0],
    [1, 1],
    [100, 1],
    [101, 2],
    [250, 3],
  ])("%i ids become %i request(s)", (count, expected) => {
    const ids = Array.from({ length: count }, (_, i) => `u${i}`);
    expect(batch(ids, 100)).toHaveLength(expected);
  });

  test("keeps every item, in order", () => {
    expect(batch([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("findMigratedUsers", () => {
  test("queries by external_id instead of listing the instance", async () => {
    stubBapi({ legacy_a: "user_1", legacy_b: "user_2" });

    const found = await findMigratedUsers({
      externalIds: ["legacy_a", "legacy_b"],
      secretKey: "sk_test_x",
    });

    expect(found).toEqual([
      { id: "user_1", externalId: "legacy_a" },
      { id: "user_2", externalId: "legacy_b" },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("external_id=legacy_a");
  });

  test("omits IDs the instance does not have", async () => {
    stubBapi({ legacy_a: "user_1" });

    const found = await findMigratedUsers({
      externalIds: ["legacy_a", "legacy_b"],
      secretKey: "sk_test_x",
    });

    expect(found).toEqual([{ id: "user_1", externalId: "legacy_a" }]);
  });

  test("pages in batches of 100, the BAPI limit", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `legacy_${i}`);
    stubBapi(Object.fromEntries(ids.map((id, i) => [id, `user_${i}`])));

    const found = await findMigratedUsers({ externalIds: ids, secretKey: "sk_test_x" });

    expect(found).toHaveLength(150);
    expect(requests).toHaveLength(2);
  });

  test("asks for a page large enough to hold the whole batch", async () => {
    stubBapi({ legacy_a: "user_1" });
    await findMigratedUsers({ externalIds: ["legacy_a"], secretKey: "sk_test_x" });
    expect(requests[0]?.url).toContain("limit=100");
  });

  // The guard that keeps this command from touching anything it did not create.
  test("ignores a user whose external_id was not asked for", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push({ method: "GET", url: input.toString() });
      return Response.json([
        { id: "user_1", external_id: "legacy_a" },
        { id: "user_999", external_id: "somebody_else" },
        { id: "user_888" },
      ]);
    }) as unknown as typeof fetch;

    const found = await findMigratedUsers({ externalIds: ["legacy_a"], secretKey: "sk_test_x" });

    expect(found).toEqual([{ id: "user_1", externalId: "legacy_a" }]);
  });
});

describe("deleteMigratedUsers", () => {
  const users = [
    { id: "user_1", externalId: "legacy_a" },
    { id: "user_2", externalId: "legacy_b" },
  ];

  test("deletes each user and logs the outcome", async () => {
    stubBapi({});

    const summary = await deleteMigratedUsers({
      users,
      secretKey: "sk_test_x",
      limits: LIMITS,
      dateTime: DATE_TIME,
    });

    expect(summary).toMatchObject({ deleted: 2, failed: 0 });
    expect(deleteCalls()).toHaveLength(2);
    expect(logEntries().filter((e) => e.status === "success")).toHaveLength(2);
  });

  test("records the source ID alongside the Clerk ID in the log", async () => {
    stubBapi({});

    await deleteMigratedUsers({
      users: [users[0] as (typeof users)[0]],
      secretKey: "sk_test_x",
      limits: LIMITS,
      dateTime: DATE_TIME,
    });

    expect(logEntries()[0]).toMatchObject({
      userId: "legacy_a",
      clerkUserId: "user_1",
      status: "success",
    });
  });

  // A half-undone migration with no record of which half is worse than a
  // reported failure.
  test("keeps going after one user fails", async () => {
    stubBapi({}, (id) =>
      id === "user_1"
        ? new Response(JSON.stringify({ errors: [{ code: "e", message: "locked" }] }), {
            status: 422,
          })
        : Response.json({ deleted: true }),
    );

    const summary = await deleteMigratedUsers({
      users,
      secretKey: "sk_test_x",
      limits: LIMITS,
      dateTime: DATE_TIME,
    });

    expect(summary).toMatchObject({ deleted: 1, failed: 1 });
    expect(deleteCalls()).toHaveLength(2);
    expect(logEntries().some((e) => e.status === "error" && e.code === "422")).toBe(true);
  });

  test("retries a 429 and logs the attempt", async () => {
    const attempts = new Map<string, number>();
    stubBapi({}, (id) => {
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      return attempt === 1
        ? new Response(JSON.stringify({ errors: [{ code: "e", message: "slow down" }] }), {
            status: 429,
            headers: { "retry-after": "1" },
          })
        : Response.json({ deleted: true });
    });

    const summary = await deleteMigratedUsers({
      users: [users[0] as (typeof users)[0]],
      secretKey: "sk_test_x",
      limits: LIMITS,
      dateTime: DATE_TIME,
    });

    expect(summary).toMatchObject({ deleted: 1, failed: 0 });
    expect(deleteCalls()).toHaveLength(2);
    expect(logEntries().some((e) => e.status === "429_retry")).toBe(true);
  });

  test("groups identical failures in the breakdown", async () => {
    stubBapi(
      {},
      () =>
        new Response(JSON.stringify({ errors: [{ code: "e", message: "locked" }] }), {
          status: 422,
        }),
    );

    const summary = await deleteMigratedUsers({
      users,
      secretKey: "sk_test_x",
      limits: LIMITS,
      dateTime: DATE_TIME,
    });

    expect([...summary.errorBreakdown.values()]).toEqual([2]);
  });
});

describe("deleteMigration", () => {
  const baseOptions = { yes: true, secretKey: "sk_test_x" };

  beforeEach(async () => {
    await saveSettings({ transformer: "clerk", file: "export.json" });
  });

  test("deletes the users the last run created", async () => {
    stubBapi({ legacy_a: "user_1", legacy_b: "user_2" });

    await deleteMigration(baseOptions);

    expect(deleteCalls()).toEqual([
      expect.stringContaining("/v1/users/user_1"),
      expect.stringContaining("/v1/users/user_2"),
    ]);
    expect(captured.err).toContain("Deleted:");
  });

  test("writes a timestamped NDJSON deletion log", async () => {
    stubBapi({ legacy_a: "user_1", legacy_b: "user_2" });

    await deleteMigration(baseOptions);

    const logs = fs.readdirSync(getLogDir());
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^user-deletion-\d{4}-\d{2}-\d{2}T[\d-]+\.log$/);
  });

  test("leaves users the migration did not create alone", async () => {
    stubBapi({ legacy_a: "user_1" });

    await deleteMigration(baseOptions);

    expect(deleteCalls()).toEqual([expect.stringContaining("/v1/users/user_1")]);
    expect(captured.err).toContain("1 of the file's user(s) are not in this instance");
  });

  test("does nothing when none of the migration's users are present", async () => {
    stubBapi({});

    await deleteMigration(baseOptions);

    expect(deleteCalls()).toHaveLength(0);
    expect(captured.err).toContain("Nothing to delete");
  });

  // Tests run non-TTY, which is the same signal an agent gives.
  test("refuses without -y when it cannot prompt, and says how many are at stake", async () => {
    stubBapi({ legacy_a: "user_1", legacy_b: "user_2" });

    await expect(deleteMigration({ secretKey: "sk_test_x" })).rejects.toThrow(
      /permanently deletes 2 user\(s\) and cannot prompt here/,
    );
    expect(deleteCalls()).toHaveLength(0);
  });

  test("fails before any API call when there is no saved migration", async () => {
    fs.rmSync(path.join(configDir, "config.json"), { force: true });
    stubBapi({ legacy_a: "user_1" });

    await expect(deleteMigration(baseOptions)).rejects.toThrow(CliError);
    expect(requests).toHaveLength(0);
  });

  test("exits non-zero when a deletion failed", async () => {
    stubBapi(
      { legacy_a: "user_1" },
      () =>
        new Response(JSON.stringify({ errors: [{ code: "e", message: "locked" }] }), {
          status: 422,
        }),
    );

    await deleteMigration(baseOptions);

    expect(process.exitCode).toBe(1);
  });
});

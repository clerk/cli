import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT_CODE, type CliError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import {
  continueRun,
  latestUserLines,
  listRuns,
  lockFile,
  patchRun,
  readRun,
  startRun,
  type RunRecord,
} from "./lib/run-store.ts";
import { keyInstanceId } from "./lib/target.ts";
import { undo } from "./undo.ts";

const captured = useCaptureLog();

let runsDir: string;
let originalFetch: typeof globalThis.fetch;
let requests: { method: string; url: string }[];
/** Clerk IDs the stubbed instance still holds, with each one's last sign-in. */
let instanceUsers: Map<string, number | null>;
/** Clerk IDs whose DELETE fails with a 500. */
let failing: Set<string>;
/** external_id → Clerk ID, for users whose create was in flight. */
let inFlight: Map<string, string>;
/** external_id → the run whose marker Clerk holds on that in-flight user. */
let inFlightMarker: Map<string, string>;

const IMPORT_STARTED = "2026-09-01T00:00:00.000Z";
const AFTER_IMPORT = Date.parse("2026-09-02T00:00:00.000Z");

beforeAll(() => {
  originalFetch = globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  runsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-undo-")));
  requests = [];
  failing = new Set();
  inFlight = new Map();
  inFlightMarker = new Map();
  instanceUsers = new Map([
    ["user_a", null],
    ["user_b", AFTER_IMPORT],
  ]);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    requests.push({ method, url: url.toString() });

    if (url.pathname === "/v1/instance") {
      return Response.json({ object: "instance", id: "ins_1", environment_type: "development" });
    }
    if (method === "GET" && url.pathname === "/v1/users" && url.searchParams.has("external_id")) {
      return Response.json(
        url.searchParams
          .getAll("external_id")
          .map((externalId) => externalId.replace(/^\+/, ""))
          .filter((externalId) => inFlight.has(externalId))
          .map((externalId) => ({
            id: inFlight.get(externalId),
            external_id: externalId,
            private_metadata: { clerkMigrateRun: inFlightMarker.get(externalId) },
          })),
      );
    }
    if (method === "GET" && url.pathname === "/v1/users") {
      const ids = url.searchParams.getAll("user_id");
      return Response.json(
        ids
          .filter((id) => instanceUsers.has(id))
          .map((id) => ({ id, last_sign_in_at: instanceUsers.get(id) })),
      );
    }
    if (method === "DELETE") {
      const id = url.pathname.split("/").pop() as string;
      if (failing.has(id)) {
        return Response.json({ errors: [{ code: "boom", message: "boom" }] }, { status: 500 });
      }
      instanceUsers.delete(id);
      return Response.json({ id, deleted: true });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exitCode = 0;
  fs.rmSync(runsDir, { recursive: true, force: true });
});

/** An import into `ins_1` that created two users and failed one. */
function importRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const run = startRun(runsDir, {
    kind: "import",
    target: { instanceId: "ins_1", env: "development" },
    source: "clerk",
  });
  run.update({ startedAt: IMPORT_STARTED });
  run.append({ sourceId: "a", status: "created", clerkId: "user_a" });
  run.append({ sourceId: "b", status: "created", clerkId: "user_b" });
  run.append({ sourceId: "c", status: "failed", error: "taken" });
  const record = run.finish();
  if (Object.keys(overrides).length > 0) run.update(overrides);
  return { ...record, ...overrides };
}

const options = { secretKey: "sk_test_x", runsDir: "" };
const withDir = (extra: Record<string, unknown> = {}) => ({ ...options, runsDir, ...extra });
const deletes = () => requests.filter((request) => request.method === "DELETE");

describe("refusals, all exit 2 and delete nothing", () => {
  const exitCodeOf = async (promise: Promise<unknown>) => {
    const error = (await promise.catch((caught: unknown) => caught)) as CliError;
    return error.exitCode;
  };

  test("an unknown run", async () => {
    expect(await exitCodeOf(undo("nope", withDir({ yes: true })))).toBe(EXIT_CODE.USAGE);
  });

  test("a run that is not an import", async () => {
    const run = startRun(runsDir, { kind: "export", target: { platform: "auth0" } });
    run.finish();
    await expect(undo(run.record.id, withDir({ yes: true }))).rejects.toThrow(
      /is an export run\. Only an import run can be undone/,
    );
    expect(deletes()).toHaveLength(0);
  });

  test("a run already undone", async () => {
    const record = importRun({ status: "undone", undoneBy: "20260901-000000-beef" });
    await expect(undo(record.id, withDir({ yes: true }))).rejects.toThrow(
      /already undone by run 20260901-000000-beef/,
    );
  });

  test("a key that addresses a different instance, naming both", async () => {
    const record = importRun({ target: { instanceId: "ins_other", env: "production" } });
    await expect(undo(record.id, withDir({ yes: true }))).rejects.toThrow(
      /imported into instance \(production, ins_other\).*addresses instance \(development, ins_1\)/s,
    );
    expect(deletes()).toHaveLength(0);
  });

  // `key_` is the identity fallback when GET /v1/instance failed, e.g. rate
  // limited straight after a large import. That is unknown, not different.
  test("an unconfirmed instance is not reported as a different one", async () => {
    const record = importRun({
      target: { instanceId: "key_0123456789abcdef", env: "development" },
    });
    const error = (await undo(record.id, withDir({ yes: true })).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("Could not confirm");
    expect(error.message).not.toContain("addresses instance");
    expect(deletes()).toHaveLength(0);
  });

  // The import ran while Clerk could not name the instance; the same key is
  // the same instance once it can.
  test("accepts a run recorded under this key's stand-in ID", async () => {
    const record = importRun({
      target: { instanceId: keyInstanceId("sk_test_x"), env: "development" },
    });

    await undo(record.id, withDir({ yes: true }));

    expect(deletes()).toHaveLength(2);
  });

  test("no consent where nobody can be asked: the preview, then the command", async () => {
    const record = importRun();

    const error = (await undo(record.id, withDir()).catch((caught: unknown) => caught)) as CliError;

    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(error.message).toContain("Pass --yes to confirm");
    expect(captured.err).toContain("Will delete 2 users");
    expect(deletes()).toHaveLength(0);
  });

  // Another process continues the import while the undo previews it.
  describe("the run changing during the preview", () => {
    const duringPreview = (act: () => void) => {
      const stubbed = globalThis.fetch;
      let acted = false;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (!acted && new URL(input.toString()).searchParams.has("user_id")) {
          acted = true;
          act();
        }
        return stubbed(input, init);
      }) as typeof fetch;
    };

    test("still running: refused by the import run's lock", async () => {
      const record = importRun();
      duringPreview(() => fs.writeFileSync(lockFile(runsDir, record.id), String(process.ppid)));

      await expect(undo(record.id, withDir({ yes: true }))).rejects.toThrow(
        /in use by another process/,
      );
      expect(deletes()).toHaveLength(0);
      expect(readRun(runsDir, record.id)?.status).not.toBe("undone");
    });

    test("finished: refused because the preview is out of date", async () => {
      const record = importRun();
      duringPreview(() => {
        const run = continueRun(runsDir, record);
        run.append({ sourceId: "c", status: "created", clerkId: "user_c" });
        run.finish();
      });

      await expect(undo(record.id, withDir({ yes: true }))).rejects.toThrow(
        /preview is out of date/,
      );
      expect(deletes()).toHaveLength(0);
      expect(fs.existsSync(lockFile(runsDir, record.id))).toBe(false);
    });

    test("undone by another undo: refused, and its undo is kept", async () => {
      const record = importRun();
      duringPreview(() =>
        patchRun(runsDir, record.id, { status: "undone", undoneBy: "20260901-000000-beef" }),
      );

      await expect(undo(record.id, withDir({ yes: true }))).rejects.toThrow(
        /already undone by run 20260901-000000-beef/,
      );
      expect(deletes()).toHaveLength(0);
      expect(readRun(runsDir, record.id)?.undoneBy).toBe("20260901-000000-beef");
      expect(listRuns(runsDir).filter((run) => run.kind === "undo")).toHaveLength(0);
    });
  });
});

describe("--dry-run", () => {
  test("previews the deletes and how many users signed in since, and deletes nothing", async () => {
    const record = importRun();

    await undo(record.id, withDir({ dryRun: true }));

    expect(captured.err).toContain("Target: development instance ins_1");
    expect(captured.err).toContain("Will delete 2 users");
    expect(captured.err).toContain("1 of them has signed in since the import");
    expect(deletes()).toHaveLength(0);
    expect(listRuns(runsDir)).toHaveLength(1);
  });

  test("--json returns the target, the run and the preview", async () => {
    const record = importRun();

    await undo(record.id, withDir({ dryRun: true, json: true }));

    expect(JSON.parse(captured.out)).toMatchObject({
      target: { instanceId: "ins_1", keySource: "--secret-key" },
      run: { id: record.id },
      preview: { toDelete: 2, signedInSince: 1, alreadyGone: 0, alreadyDeleted: 0 },
      dryRun: true,
    });
  });
});

describe("deleting", () => {
  // The run stopped with this user's POST /v1/users in flight: Clerk created
  // it, but its ID never reached the run record.
  test("finds a user whose create was in flight by external_id, and deletes it", async () => {
    const run = startRun(runsDir, {
      kind: "import",
      target: { instanceId: "ins_1", env: "development" },
      source: "clerk",
    });
    run.update({ startedAt: IMPORT_STARTED });
    run.append({ sourceId: "a", status: "created", clerkId: "user_a" });
    run.append({ sourceId: "d", status: "creating" });
    run.append({ sourceId: "e", status: "creating" });
    const record = run.finish();
    inFlight.set("d", "user_d");
    inFlightMarker.set("d", record.id);
    instanceUsers.set("user_d", null);

    await undo(record.id, withDir({ yes: true }));

    expect(deletes().map((request) => request.url.split("/").pop())).toEqual(
      expect.arrayContaining(["user_a", "user_d"]),
    );
    expect(deletes()).toHaveLength(2);
  });

  // Same source ID, but no marker from this run: an app or another tool's user.
  test("leaves an in-flight match that does not carry the run's marker", async () => {
    const run = startRun(runsDir, {
      kind: "import",
      target: { instanceId: "ins_1", env: "development" },
      source: "clerk",
    });
    run.append({ sourceId: "a", status: "created", clerkId: "user_a" });
    run.append({ sourceId: "d", status: "creating" });
    const record = run.finish();
    inFlight.set("d", "user_d");
    instanceUsers.set("user_d", null);

    await undo(record.id, withDir({ yes: true }));

    expect(deletes().map((request) => request.url.split("/").pop())).toEqual(["user_a"]);
  });

  // Run A stopped with d's create in flight; a later run B then created d.
  // The user Clerk holds is B's, so undoing A leaves it alone.
  test("leaves an in-flight user that another import run records as created", async () => {
    const runA = startRun(runsDir, {
      kind: "import",
      target: { instanceId: "ins_1", env: "development" },
      source: "clerk",
    });
    runA.append({ sourceId: "a", status: "created", clerkId: "user_a" });
    runA.append({ sourceId: "d", status: "creating" });
    const recordA = runA.finish();
    const runB = startRun(runsDir, {
      kind: "import",
      target: { instanceId: "ins_1", env: "development" },
      source: "clerk",
    });
    runB.append({ sourceId: "d", status: "created", clerkId: "user_d" });
    runB.finish();
    inFlight.set("d", "user_d");
    inFlightMarker.set("d", runB.record.id);
    instanceUsers.set("user_d", null);

    await undo(recordA.id, withDir({ yes: true }));

    expect(deletes().map((request) => request.url.split("/").pop())).toEqual(["user_a"]);
  });

  // The instance is over its limit for every delete, not just the one that hit it.
  test("holds every other delete through a 429's wait", async () => {
    const record = importRun();
    const stub = globalThis.fetch;
    const started = performance.now();
    const deletedAt: number[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== "DELETE") return stub(input, init);
      deletedAt.push(performance.now() - started);
      if (deletedAt.length === 1) {
        requests.push({ method: "DELETE", url: input.toString() });
        return new Response(JSON.stringify({ errors: [{ code: "x", message: "slow down" }] }), {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      return stub(input, init);
    }) as typeof fetch;
    process.env.CLERK_MIGRATE_CONCURRENCY_LIMIT = "1";
    try {
      await undo(record.id, withDir({ yes: true }));
    } finally {
      delete process.env.CLERK_MIGRATE_CONCURRENCY_LIMIT;
    }

    expect(deletedAt).toHaveLength(3);
    for (const at of deletedAt.slice(1)) expect(at - deletedAt[0]!).toBeGreaterThanOrEqual(900);
  });

  test("deletes what the import created, records an undo run, and marks the import undone", async () => {
    const record = importRun();

    await undo(record.id, withDir({ yes: true }));

    expect(
      deletes()
        .map((request) => new URL(request.url).pathname)
        .sort(),
    ).toEqual(["/v1/users/user_a", "/v1/users/user_b"]);
    const undoRun = listRuns(runsDir).find((candidate) => candidate.kind === "undo");
    expect(undoRun).toMatchObject({
      status: "complete",
      undoes: record.id,
      counts: { deleted: 2 },
    });
    expect(readRun(runsDir, record.id)).toMatchObject({
      status: "undone",
      undoneBy: undoRun?.id,
    });
    expect(process.exitCode).toBe(0);
  });

  test("counts a user already gone from the instance as deleted, without asking Clerk", async () => {
    instanceUsers.delete("user_a");
    const record = importRun();

    await undo(record.id, withDir({ yes: true }));

    expect(deletes()).toHaveLength(1);
    expect(readRun(runsDir, record.id)?.status).toBe("undone");
  });

  test("a failed delete leaves the undo partial, exits 1, and a re-run continues it", async () => {
    failing.add("user_b");
    const record = importRun();

    await undo(record.id, withDir({ yes: true }));

    expect(process.exitCode).toBe(1);
    const [partial] = listRuns(runsDir).filter((candidate) => candidate.kind === "undo");
    expect(partial).toMatchObject({ status: "partial", counts: { deleted: 1, failed: 1 } });
    expect(readRun(runsDir, record.id)?.status).toBe("partial");

    failing.clear();
    requests = [];
    process.exitCode = 0;
    await undo(record.id, withDir({ yes: true }));

    // Only the user that failed is retried, in the same undo run.
    expect(deletes().map((request) => new URL(request.url).pathname)).toEqual(["/v1/users/user_b"]);
    const undoRuns = listRuns(runsDir).filter((candidate) => candidate.kind === "undo");
    expect(undoRuns).toHaveLength(1);
    expect(undoRuns[0]).toMatchObject({ id: partial?.id, status: "complete" });
    expect(latestUserLines(runsDir, partial!.id).get("b")?.status).toBe("deleted");
    expect(readRun(runsDir, record.id)?.status).toBe("undone");
  });

  test("--json --yes returns the undo run and the result", async () => {
    const record = importRun();

    await undo(record.id, withDir({ yes: true, json: true }));

    expect(JSON.parse(captured.out)).toMatchObject({
      run: { kind: "undo", undoes: record.id, status: "complete" },
      result: { deleted: 2, failed: 0, errors: [] },
    });
  });
});

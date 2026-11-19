import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT_CODE, type CliError } from "../../lib/errors.ts";
import { quoteArg } from "../../lib/json-body.ts";
import { _resetInterruptState, abortInFlight, beginInterrupt } from "../../lib/signals.ts";
import { captureTelemetryPayload, useCaptureLog } from "../../test/lib/stubs.ts";
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
import { terminal } from "./lib/terminal.ts";
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

// `user_b` has signed in since the import; the guard on that has its own tests.
const withDir = (extra: Record<string, unknown> = {}) => ({
  secretKey: "sk_test_x",
  includeSignedIn: true,
  runsDir,
  ...extra,
});
const deletes = () => requests.filter((request) => request.method === "DELETE");

describe("refusals, all exit 2 and delete nothing", () => {
  const exitCodeOf = async (promise: Promise<unknown>) => {
    const error = (await promise.catch((caught: unknown) => caught)) as CliError;
    return error.exitCode;
  };

  test("an unknown run", async () => {
    expect(await exitCodeOf(undo("nope", withDir({ yes: true })))).toBe(EXIT_CODE.USAGE);
  });

  test("an unknown run lists the same runs folder", async () => {
    await expect(undo("nope", withDir({ yes: true }))).rejects.toThrow(
      `clerk migrate runs --runs-dir ${quoteArg(runsDir)}`,
    );
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

  // Nothing is left to delete, but the import is still marked undone.
  test("no consent with every user already gone names the mark, not 0 deletes", async () => {
    instanceUsers.clear();
    const record = importRun();

    const error = (await undo(record.id, withDir()).catch((caught: unknown) => caught)) as CliError;

    expect(error.message).toContain(`marks run ${record.id} undone and needs consent`);
    expect(error.message).not.toContain("0 users");
    expect(error.examples?.[0]?.description).toBe(`Mark run ${record.id} undone`);
  });

  // The preview and the dry run say the same, rather than "Will delete 0 users".
  test("a dry run with every user already gone names the mark, not 0 deletes", async () => {
    instanceUsers.clear();
    const record = importRun();

    await undo(record.id, withDir({ dryRun: true }));

    const err = Bun.stripANSI(captured.err);
    expect(err).toContain(`Will mark import run ${record.id} undone: nothing is left to delete.`);
    expect(err).toContain("to mark it undone.");
    expect(err).not.toContain("Will delete 0");
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

    // The run's own folder takes the lock, but the undo run can't be created
    // beside it. `--runs-dir` is never written to by resolveRunsDir.
    // Root writes through 0o555, so the undo run would be created.
    test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "--json prints the preview, marked writeFailed, when the runs folder can't be written",
      async () => {
        const record = importRun();
        fs.chmodSync(runsDir, 0o555);
        try {
          await expect(undo(record.id, withDir({ yes: true, json: true }))).rejects.toThrow();
        } finally {
          fs.chmodSync(runsDir, 0o755);
        }
        expect(JSON.parse(captured.out)).toMatchObject({
          import: { id: record.id },
          run: null,
          writeFailed: true,
        });
        expect(deletes()).toHaveLength(0);
      },
    );

    // After the preview, --json always prints its object.
    test("--json prints the preview, marked changed, when another process holds the run", async () => {
      const record = importRun();
      duringPreview(() => fs.writeFileSync(lockFile(runsDir, record.id), String(process.ppid)));

      await expect(undo(record.id, withDir({ yes: true, json: true }))).rejects.toThrow(
        /in use by another process/,
      );
      expect(JSON.parse(captured.out)).toMatchObject({ import: { id: record.id }, changed: true });
      expect(deletes()).toHaveLength(0);
    });

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

    // After the preview, --json always prints its object.
    test("--json prints the preview, marked changed, when it is out of date", async () => {
      const record = importRun();
      duringPreview(() => {
        const run = continueRun(runsDir, record);
        run.append({ sourceId: "c", status: "created", clerkId: "user_c" });
        run.finish();
      });

      await expect(undo(record.id, withDir({ yes: true, json: true }))).rejects.toThrow(
        /preview is out of date/,
      );
      expect(JSON.parse(captured.out)).toMatchObject({ import: { id: record.id }, changed: true });
    });

    // --yes agreed to the preview's count, not to someone who signed in since.
    test("refuses when a user signs in after the preview, without --include-signed-in", async () => {
      instanceUsers.set("user_b", null);
      const record = importRun();
      let lookups = 0;
      const stubbed = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.searchParams.has("user_id") && lookups++ === 1)
          instanceUsers.set("user_a", AFTER_IMPORT);
        return stubbed(input, init);
      }) as typeof fetch;

      await expect(undo(record.id, withDir({ yes: true, includeSignedIn: false }))).rejects.toThrow(
        /1 more user the import created signed in after the preview/,
      );
      expect(deletes()).toHaveLength(0);
      expect(readRun(runsDir, record.id)?.status).not.toBe("undone");
    });

    // Past the preview, --json still prints its object, whatever happens next.
    test("--json prints the preview, marked, when the recheck itself fails", async () => {
      instanceUsers.set("user_b", null);
      const record = importRun();
      let lookups = 0;
      const stubbed = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.searchParams.has("user_id") && lookups++ === 1) {
          return Response.json({ errors: [{ code: "boom", message: "boom" }] }, { status: 500 });
        }
        return stubbed(input, init);
      }) as typeof fetch;

      await expect(
        undo(record.id, withDir({ yes: true, includeSignedIn: false, json: true })),
      ).rejects.toThrow();
      expect(JSON.parse(captured.out)).toMatchObject({
        import: { id: record.id },
        recheckFailed: true,
      });
      expect(deletes()).toHaveLength(0);
    });

    test("--include-signed-in deletes a user who signed in after the preview", async () => {
      instanceUsers.set("user_b", null);
      const record = importRun();
      let lookups = 0;
      const stubbed = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.searchParams.has("user_id") && lookups++ === 0)
          instanceUsers.set("user_a", AFTER_IMPORT);
        return stubbed(input, init);
      }) as typeof fetch;

      await undo(record.id, withDir({ yes: true, includeSignedIn: true }));

      expect(deletes()).toHaveLength(2);
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

  // `run` is the undo's own run, as an import's is: null until one is written.
  test("--json returns the target, the import, no run yet, and the preview", async () => {
    const record = importRun();

    await undo(record.id, withDir({ dryRun: true, json: true }));

    expect(JSON.parse(captured.out)).toMatchObject({
      target: { instanceId: "ins_1", keySource: "--secret-key" },
      import: { id: record.id },
      run: null,
      preview: { toDelete: 2, signedInSince: 1, alreadyGone: 0, alreadyDeleted: 0 },
      dryRun: true,
    });
  });
});

describe("another undo during the preview", () => {
  test("refuses when another undo started an undo run on the import", async () => {
    const record = importRun();
    const stubbed = globalThis.fetch;
    let raced = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      // The other undo gets its lock between this one's preview and its own.
      if (!raced && (init?.method ?? "GET") === "GET" && input.toString().includes("/v1/users")) {
        raced = true;
        const other = startRun(runsDir, {
          kind: "undo",
          target: { instanceId: "ins_1", env: "development" },
          undoes: record.id,
          source: "clerk",
        });
        other.append({ sourceId: "a", clerkId: "user_a", status: "deleted" });
        other.append({ sourceId: "b", clerkId: "user_b", status: "failed", error: "boom" });
        other.finish();
      }
      return stubbed(input, init);
    }) as typeof fetch;

    const error = (await undo(record.id, withDir({ yes: true })).catch(
      (caught: unknown) => caught,
    )) as CliError;

    expect(error.message).toContain("preview is out of date");
    expect(deletes()).toHaveLength(0);
    expect(listRuns(runsDir).filter((run) => run.kind === "undo")).toHaveLength(1);
  });
});

describe("stopped part-way", () => {
  // The deletes still queued are rejected; the undo must not read as done.
  test("a Ctrl-C during the deletes leaves the undo unfinished, as interrupted", async () => {
    const record = importRun();
    const clerk = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await clerk(input, init);
      if (init?.method === "DELETE") {
        beginInterrupt();
        abortInFlight();
      }
      return response;
    }) as typeof fetch;
    try {
      await expect(undo(record.id, withDir({ yes: true }))).rejects.toThrow();
    } finally {
      _resetInterruptState();
      globalThis.fetch = clerk;
    }

    const undoRun = listRuns(runsDir).find((r) => r.kind === "undo");
    expect(undoRun?.finishedAt).toBeUndefined();
    expect(fs.existsSync(path.join(runsDir, undoRun?.id ?? "", "lock"))).toBe(false);
    expect(readRun(runsDir, record.id)?.status).not.toBe("undone");
  });

  // A script reads `run` to find the undo's folder.
  test("--json names the undo run a Ctrl-C left on disk", async () => {
    const record = importRun();
    const clerk = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await clerk(input, init);
      if (init?.method === "DELETE") {
        beginInterrupt();
        abortInFlight();
      }
      return response;
    }) as typeof fetch;
    try {
      await expect(undo(record.id, withDir({ yes: true, json: true }))).rejects.toThrow();
    } finally {
      _resetInterruptState();
      globalThis.fetch = clerk;
    }

    const undoRun = listRuns(runsDir).find((r) => r.kind === "undo");
    // As it stands on disk, not as it opened: counted from its lines.
    const printed = JSON.parse(captured.out) as { run: RunRecord };
    expect(printed).toMatchObject({
      stopped: true,
      run: { id: undoRun?.id, state: "interrupted" },
    });
    expect(printed.run.counts.deleted).toBe(latestUserLines(runsDir, undoRun!.id).size);
    expect(printed.run.counts.deleted).toBeGreaterThan(0);
  });
});

// `CLERK_MODE=human` with no terminal: the prompt would fail to open one and spin.
describe("forced human mode with no terminal", () => {
  test("refuses for consent rather than prompting", async () => {
    const record = importRun();
    const mode = process.env.CLERK_MODE;
    const available = spyOn(terminal, "available").mockReturnValue(false);
    process.env.CLERK_MODE = "human";
    try {
      await expect(undo(record.id, withDir())).rejects.toThrow(/needs consent/);
    } finally {
      available.mockRestore();
      if (mode === undefined) delete process.env.CLERK_MODE;
      else process.env.CLERK_MODE = mode;
    }
    expect(deletes()).toHaveLength(0);
  });
});

describe("users who signed in since the import", () => {
  test("--yes alone refuses to delete them, and deletes nothing", async () => {
    const record = importRun();

    const error = (await undo(record.id, withDir({ yes: true, includeSignedIn: false })).catch(
      (caught: unknown) => caught,
    )) as CliError;

    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(error.message).toContain("1 user the import created has signed in since");
    expect(error.examples?.[0]?.command).toContain("--yes --include-signed-in");
    expect(deletes()).toHaveLength(0);
  });

  // `consent` alone would tell a script to retry with --yes, which it gave.
  test("--yes --json marks the refusal as needing --include-signed-in", async () => {
    const record = importRun();

    await expect(
      undo(record.id, withDir({ yes: true, json: true, includeSignedIn: false })),
    ).rejects.toThrow("--include-signed-in");

    expect(JSON.parse(captured.out)).toMatchObject({
      consent: "required",
      includeSignedIn: "required",
    });
  });

  // Without them the suggested command looks in the default runs folder, or
  // reaches another instance, and refuses.
  test("the suggested command keeps the runs folder and the key", async () => {
    const record = importRun();

    const error = (await undo(record.id, withDir({ yes: true, includeSignedIn: false })).catch(
      (caught: unknown) => caught,
    )) as CliError;

    expect(error.examples?.[0]?.command).toBe(
      `clerk migrate undo ${record.id} --yes --include-signed-in --secret-key <key> --runs-dir ${quoteArg(runsDir)}`,
    );
  });

  test("--include-signed-in deletes them too", async () => {
    const record = importRun();

    await undo(record.id, withDir({ yes: true, includeSignedIn: true }));

    expect(deletes()).toHaveLength(2);
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

  // Run later, the exported key may be gone: the retry names it as a placeholder.
  test("a failed delete with an exported key suggests the retry with the key", async () => {
    failing.add("user_b");
    const record = importRun();
    const previous = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    try {
      await undo(record.id, withDir({ yes: true, secretKey: undefined }));
    } finally {
      if (previous === undefined) delete process.env.CLERK_SECRET_KEY;
      else process.env.CLERK_SECRET_KEY = previous;
    }

    expect(Bun.stripANSI(captured.err)).toContain(
      `\`clerk migrate undo ${record.id} --secret-key <key> --runs-dir ${quoteArg(runsDir)}\` again to retry the users that failed`,
    );
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

  // `runs <undo-id>` builds the undo's retry from its record: the key this
  // attempt used, not the first one's `.env`, which may not be there.
  test("a continued undo records its own key source", async () => {
    failing.add("user_b");
    const record = importRun();
    await undo(record.id, withDir({ yes: true }));
    const [partial] = listRuns(runsDir).filter((candidate) => candidate.kind === "undo");
    patchRun(runsDir, partial!.id, { target: { ...partial!.target, keySource: ".env" } });

    process.exitCode = 0;
    await undo(record.id, withDir({ yes: true }));

    expect(readRun(runsDir, partial!.id)?.target.keySource).toBe("--secret-key");
  });

  test("--json --yes returns the undo run and the result", async () => {
    const record = importRun();

    await undo(record.id, withDir({ yes: true, json: true }));

    const out = JSON.parse(captured.out);
    // The import as it is now: undone, by this undo.
    expect(out.import).toMatchObject({ id: record.id, status: "undone", undoneBy: out.run.id });
    expect(out).toMatchObject({
      run: { kind: "undo", undoes: record.id, status: "complete" },
      result: { deleted: 2, failed: 0, errors: [] },
    });
  });
});

describe("telemetry", () => {
  const send = async (runId: string, options: Parameters<typeof undo>[1]) =>
    (
      await captureTelemetryPayload("migrate undo", () => undo(runId, options), {
        captureError: true,
      })
    ).payload;

  test("a finished undo ends at done, naming the import's source and instance", async () => {
    const payload = await send(importRun().id, withDir({ yes: true }));
    expect(payload).toMatchObject({
      outcome: "success",
      stage: "done",
      migrate_source: "clerk",
      instance_id: "ins_1",
    });
  });

  test("an undo with deletes left is coded", async () => {
    failing.add("user_a");
    const payload = await send(importRun().id, withDir({ yes: true }));
    expect(payload).toMatchObject({
      outcome: "error",
      stage: "done",
      error_code: "migrate_undo_incomplete",
    });
  });

  test.each([
    ["a dry run", { dryRun: true }, "migrate_dry_run"],
    ["no consent where nobody can be asked", {}, "migrate_confirm"],
  ])("%s stops at its stage", async (_label, extra, stage) => {
    const payload = await send(importRun().id, withDir(extra));
    expect(payload.stage).toBe(stage);
  });

  test("an unknown run stops at migrate_run_lookup", async () => {
    const payload = await send("20260101-000000-nope", withDir({ yes: true }));
    expect(payload.stage).toBe("migrate_run_lookup");
  });

  // Recorded before resolution, so a failed one still names the run's instance.
  test("a target that fails to resolve still names the run's instance", async () => {
    const record = importRun({ target: { instanceId: "ins_recorded", env: "development" } });
    const payload = await send(record.id, withDir({ yes: true, instance: "prod" }));
    expect(payload).toMatchObject({ stage: "migrate_target", instance_id: "ins_recorded" });
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setConfigDir } from "../../lib/config.ts";
import { type CliError, EXIT_CODE } from "../../lib/errors.ts";
import { credentialStoreStubs, useCaptureLog } from "../../test/lib/stubs.ts";

// Every test below names its own `--secret-key`, which short-circuits the
// signed-in check — except the one that asserts what happens without it.
mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
import { latestUserLines, listRuns, readRun, startRun } from "./lib/run-store.ts";
import { __resetCustomSourcesForTesting } from "./sources/registry.ts";
import { explainErrors, run, validateRunOptions } from "./run.ts";

/** A real-shaped bcrypt digest: the checks reject anything that is not. */
const BCRYPT = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

let workDir: string;
let configDir: string;
let originalCwd: string;

/** Where runs land for a project rooted at `workDir`. */
const runsDir = () => path.join(workDir, ".clerk", "migrate");

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-run-")));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-run-config-"));
  _setConfigDir(configDir);
  process.chdir(workDir);
  fs.writeFileSync(path.join(workDir, "users.json"), "[]");
  fs.writeFileSync(path.join(workDir, "users.txt"), "");
});

afterAll(() => {
  _setConfigDir(undefined);
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("validateRunOptions", () => {
  test("accepts a source and an existing JSON file", () => {
    expect(validateRunOptions({ source: "clerk", file: "users.json" })).toEqual({
      source: "clerk",
      file: "users.json",
    });
  });

  test.each([
    ["no source", { file: "users.json" }, /Missing --source/],
    ["no file", { source: "clerk" }, /Missing the file to import/],
    ["a missing file", { source: "clerk", file: "nope.json" }, /File not found/],
    ["an unsupported extension", { source: "clerk", file: "users.txt" }, /Unsupported file type/],
  ])("rejects %s", (_label, options, message) => {
    expect(() => validateRunOptions(options)).toThrow(message);
  });

  test("names the valid sources when one is missing", () => {
    expect(() => validateRunOptions({ file: "users.json" })).toThrow(/clerk/);
  });
});

type Stub = {
  /** What `/v1/environment` reports; `null` makes the settings unreadable. */
  settings?: { attributes?: object; social?: object; sign_up?: object } | null;
  /** Users already in the instance, as `GET /v1/users` returns them. */
  existing?: {
    id: string;
    external_id?: string;
    username?: string;
    email_addresses?: { email_address: string }[];
  }[];
  /** `GET /v1/users/count`. */
  count?: number;
  /** Source IDs whose `POST /v1/users` fails with a 422. */
  failing?: Set<string>;
};

describe("run", () => {
  const captured = useCaptureLog();
  let originalFetch: typeof globalThis.fetch;
  let requests: { method: string; url: string; body: unknown }[];

  const export2 = [
    {
      id: "u1",
      primary_email_address: "a@x.dev",
      password_digest: BCRYPT,
      password_hasher: "bcrypt",
    },
    { id: "u2", primary_email_address: "b@x.dev" },
  ];

  /** A fake Clerk: the instance, its settings, its users, and the writes. */
  function stubClerk(stub: Stub = {}): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
      requests.push({ method, url: url.toString(), body });

      if (url.pathname === "/v1/instance") {
        return Response.json({ object: "instance", id: "ins_1", environment_type: "development" });
      }
      if (url.pathname === "/v1/domains") {
        if (!stub.settings) return new Response("nope", { status: 500 });
        return Response.json({
          data: [{ is_satellite: false, frontend_api_url: "https://fapi.example.com" }],
        });
      }
      if (url.pathname.includes("/v1/dev_browser")) return Response.json({ token: "jwt" });
      if (url.pathname.includes("/v1/environment")) {
        return Response.json({ user_settings: stub.settings });
      }
      if (url.pathname === "/v1/users/count") {
        return Response.json({ object: "total_count", total_count: stub.count ?? 0 });
      }
      if (method === "GET" && url.pathname === "/v1/users") {
        // BAPI strips the `+` the lookup puts on each external_id.
        const wanted = new Set(
          [...url.searchParams.values()].map((value) => value.replace(/^\+(?!\d)/, "")),
        );
        return Response.json(
          (stub.existing ?? []).filter(
            (user) =>
              wanted.has(user.external_id ?? "") ||
              wanted.has(user.username ?? "") ||
              (user.email_addresses ?? []).some((email) => wanted.has(email.email_address)),
          ),
        );
      }
      if (method === "POST" && url.pathname === "/v1/users") {
        const externalId = body?.external_id as string;
        if (stub.failing?.has(externalId)) {
          return Response.json(
            {
              errors: [{ code: "form_identifier_exists", message: "That email address is taken." }],
            },
            { status: 422 },
          );
        }
        return Response.json({ id: `user_${externalId}` });
      }
      return Response.json({ id: "ok" });
    }) as typeof fetch;
  }

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  beforeEach(() => {
    requests = [];
    delete process.env.CLERK_MIGRATE_RATE_LIMIT;
    fs.rmSync(runsDir(), { recursive: true, force: true });
    fs.rmSync(path.join(configDir, "config.json"), { force: true });
    fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify(export2));
    stubClerk();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exitCode = 0;
  });

  const baseOptions = {
    source: "clerk",
    input: "export.json",
    yes: true,
    secretKey: "sk_test_x",
  };

  const created = () =>
    requests
      .filter((r) => r.method === "POST" && r.url.endsWith("/v1/users"))
      .map((r) => (r.body as { external_id: string }).external_id);

  const exitCodeOf = async (promise: Promise<unknown>) =>
    ((await promise.catch((caught: unknown) => caught)) as CliError | undefined)?.exitCode;

  test("refuses before anything else when nobody is signed in", async () => {
    const previous = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;
    try {
      await expect(run({ source: "clerk", input: "export.json", yes: true })).rejects.toThrow(
        /Not logged in/,
      );
      expect(requests).toHaveLength(0);
    } finally {
      if (previous !== undefined) process.env.CLERK_SECRET_KEY = previous;
    }
  });

  // --app needs an account to resolve its key, unlike --secret-key.
  test("refuses an --app import when nobody is signed in", async () => {
    const previous = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;
    try {
      await expect(
        run({ source: "clerk", input: "export.json", yes: true, app: "app_123" }),
      ).rejects.toThrow(/Not logged in/);
      expect(requests).toHaveLength(0);
    } finally {
      if (previous !== undefined) process.env.CLERK_SECRET_KEY = previous;
    }
  });

  test("imports every user in the file end to end", async () => {
    await run(baseOptions);

    expect(created()).toEqual(["u1", "u2"]);
    expect(captured.err).toContain("Imported:");
  });

  test("prints the target first", async () => {
    await run(baseOptions);
    expect(captured.err).toContain("Target: development instance ins_1");
    expect(captured.err.indexOf("Target:")).toBeLessThan(captured.err.indexOf("Checks"));
  });

  test("records the run in the project's run store", async () => {
    await run(baseOptions);

    const [record, ...rest] = listRuns(runsDir());
    expect(rest).toHaveLength(0);
    expect(record).toMatchObject({
      kind: "import",
      status: "complete",
      source: "clerk",
      counts: { total: 2, created: 2 },
      target: { keySource: "--secret-key", instanceType: "dev", instanceId: "ins_1" },
    });
    expect(record?.file?.path).toBe(path.join(workDir, "export.json"));
    expect(record?.file?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const lines = [...latestUserLines(runsDir(), record!.id).values()];
    expect(lines.map((line) => [line.sourceId, line.status, line.clerkId])).toEqual([
      ["u1", "created", "user_u1"],
      ["u2", "created", "user_u2"],
    ]);
  });

  // A complete import leaves the export's user data behind; say how to remove it.
  test("names the folders a complete import no longer needs", async () => {
    await run(baseOptions);
    const [record] = listRuns(runsDir());
    expect(captured.err).toContain(`rm -rf ${path.join(runsDir(), record!.id)}`);
  });

  // Pasted unquoted, `rm -rf …/app copy/…` deletes `…/app`.
  test("quotes the cleanup paths", async () => {
    const spaced = path.join(workDir, "app copy");
    await run({ ...baseOptions, runsDir: spaced });

    const [record] = listRuns(spaced);
    expect(captured.err).toContain(`rm -rf '${path.join(spaced, record!.id)}'`);
  });

  describe("export envelopes", () => {
    /** An export run whose envelope holds `users`, as `clerk migrate export` writes it. */
    function exportRun(source: string, rows: unknown[], extra: Record<string, unknown> = {}) {
      const run = startRun(runsDir(), { kind: "export", target: { platform: source }, source });
      const file = path.join(run.dir, "export.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          clerkMigrate: 1,
          source,
          exportedAt: "2026-09-01T00:00:00.000Z",
          runId: run.record.id,
          users: rows,
          ...extra,
        }),
      );
      run.update({ file: { path: file, sha256: "x" } });
      return { record: run.finish(), file };
    }

    const { source: _source, input: _input, ...noSource } = baseOptions;

    test("imports by export run ID, with the source the envelope names", async () => {
      const { record } = exportRun("clerk", export2);

      await run({ ...noSource, input: record.id });

      expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(2);
      const imported = listRuns(runsDir()).find((candidate) => candidate.kind === "import");
      expect(imported).toMatchObject({ source: "clerk", fromExport: record.id });
    });

    test("imports an envelope file with no source named", async () => {
      const { file } = exportRun("clerk", export2);

      await run({ ...noSource, input: file });

      expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(2);
    });

    test("refuses a source that contradicts the envelope", async () => {
      const { record } = exportRun("clerk", export2);

      await expect(run({ ...noSource, source: "auth0", input: record.id })).rejects.toThrow(
        /exported from clerk, but --source names auth0/,
      );
      expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(0);
    });

    test("refuses a run ID that is not an export", async () => {
      await run(baseOptions);
      const [imported] = listRuns(runsDir());

      await expect(run({ ...noSource, input: imported!.id })).rejects.toThrow(
        /is an import run, which has no file to import/,
      );
    });

    test("refuses a run ID with no run behind it", async () => {
      await expect(run({ ...noSource, input: "20260101-000000-abcd" })).rejects.toThrow(
        /No run `20260101-000000-abcd`/,
      );
      expect(requests).toHaveLength(0);
    });

    test("reads Firebase's hash parameters from the envelope", async () => {
      const firebase = {
        base64_signer_key: "SIGNER",
        base64_salt_separator: "Bw==",
        rounds: 8,
        mem_cost: 14,
      };
      const { record } = exportRun(
        "firebase",
        [{ localId: "f1", email: "f@x.dev", passwordHash: "HASH", salt: "SALT" }],
        { firebase },
      );

      await run({ ...noSource, input: record.id });

      const created = requests.find((r) => r.url.endsWith("/v1/users"));
      expect(created?.body).toMatchObject({
        password_hasher: "scrypt_firebase",
        password_digest: "HASH$SALT$SIGNER$Bw==$8$14",
      });
    });

    test("lets the --firebase-* flags override the envelope", async () => {
      const { record } = exportRun(
        "firebase",
        [{ localId: "f1", email: "f@x.dev", passwordHash: "HASH", salt: "SALT" }],
        {
          firebase: {
            base64_signer_key: "OLD",
            base64_salt_separator: "Bw==",
            rounds: 8,
            mem_cost: 14,
          },
        },
      );

      await run({
        ...noSource,
        input: record.id,
        firebaseSignerKey: "NEW",
        firebaseSaltSeparator: "Bw==",
        firebaseRounds: 8,
        firebaseMemCost: 14,
      });

      const created = requests.find((r) => r.url.endsWith("/v1/users"));
      expect((created!.body as { password_digest: string }).password_digest).toContain("$NEW$");
    });
  });

  test("gitignores the project's .clerk folder before writing a run", async () => {
    await run(baseOptions);
    expect(fs.readFileSync(path.join(workDir, ".gitignore"), "utf-8")).toContain(".clerk/");
  });

  test("leaves .gitignore alone when the import is refused for lack of consent", async () => {
    fs.rmSync(path.join(workDir, ".gitignore"), { force: true });

    await run({ ...baseOptions, yes: false }).catch(() => undefined);

    expect(fs.existsSync(path.join(workDir, ".gitignore"))).toBe(false);
  });

  test("--runs-dir puts the run somewhere else", async () => {
    await run({ ...baseOptions, runsDir: "elsewhere" });
    expect(listRuns(path.join(workDir, "elsewhere"))).toHaveLength(1);
    expect(listRuns(runsDir())).toHaveLength(0);
  });

  test("--require-password leaves out the users without one", async () => {
    await run({ ...baseOptions, requirePassword: true });

    expect(created()).toEqual(["u1"]);
    expect(captured.err).toContain("leaving out 1 user without a password");
    // On record, so the run is partial rather than "Already imported".
    const [record] = listRuns(runsDir());
    expect(latestUserLines(runsDir(), record!.id).get("u2")).toMatchObject({
      status: "skipped",
      reason: "no password (--require-password)",
    });
    expect(record?.status).toBe("partial");
  });

  // They never reach the checks, so the preview has to count them itself.
  test("--require-password counts the users it left out in the --json preview", async () => {
    await run({ ...baseOptions, requirePassword: true, dryRun: true, json: true });

    expect(JSON.parse(captured.out)).toMatchObject({
      dryRun: true,
      withoutPassword: 1,
      checks: { total: 1 },
    });
  });

  test("rejects a user with an unrecognized hasher, naming it", async () => {
    fs.writeFileSync(
      path.join(workDir, "export.json"),
      JSON.stringify([
        {
          id: "u1",
          primary_email_address: "a@x.dev",
          password_digest: "d",
          password_hasher: "rot13",
        },
      ]),
    );

    const error = (await run(baseOptions).catch((caught: unknown) => caught)) as CliError;
    expect(error.message).toContain("1 user would be rejected, so nothing was imported");
    expect(captured.err).toContain('Unknown password hasher "rot13"');
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(created()).toHaveLength(0);
  });

  test("exits 1 when some users failed", async () => {
    stubClerk({ failing: new Set(["u2"]) });

    await run(baseOptions);

    expect(process.exitCode).toBe(1);
    expect(listRuns(runsDir())[0]).toMatchObject({ status: "partial", counts: { failed: 1 } });
  });

  // Tests run non-TTY, the same signal an agent gives.
  describe("without a file or a source", () => {
    test("names what to pass rather than prompting for the file", async () => {
      await expect(run({ source: "clerk", yes: true, secretKey: "sk_test_x" })).rejects.toThrow(
        /needs the file to import, or the export run that wrote it, and cannot prompt here/,
      );
      expect(requests).toHaveLength(0);
    });

    test("asks for --source when the file does not name its own", async () => {
      await expect(
        run({ input: "export.json", yes: true, secretKey: "sk_test_x" }),
      ).rejects.toThrow(/Missing --source/);
    });
  });

  describe("continuing an earlier run", () => {
    test("a complete run is not imported again", async () => {
      await run(baseOptions);
      requests = [];

      await run(baseOptions);

      expect(created()).toHaveLength(0);
      expect(captured.err).toContain("Already imported in run");
      expect(listRuns(runsDir())).toHaveLength(1);
    });

    test("--new-run imports it again as a new run", async () => {
      await run(baseOptions);
      requests = [];

      await run({ ...baseOptions, newRun: true });

      expect(created()).toEqual(["u1", "u2"]);
      expect(listRuns(runsDir())).toHaveLength(2);
    });

    test("a partial run retries only the users that did not make it, in the same run", async () => {
      stubClerk({ failing: new Set(["u2"]) });
      await run(baseOptions);
      const [first] = listRuns(runsDir());

      requests = [];
      process.exitCode = 0;
      stubClerk();
      await run(baseOptions);

      expect(created()).toEqual(["u2"]);
      expect(captured.err).toContain(`Continuing run ${first!.id}, which finished partial`);
      const runs = listRuns(runsDir());
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: first!.id, status: "complete", counts: { created: 2 } });
    });

    test("an interrupted run skips the users it already created", async () => {
      stubClerk({ failing: new Set(["u2"]) });
      await run(baseOptions);
      const [first] = listRuns(runsDir());
      // A crash never writes a finish time.
      const record = readRun(runsDir(), first!.id)!;
      delete record.finishedAt;
      fs.writeFileSync(path.join(runsDir(), first!.id, "run.json"), JSON.stringify(record));

      requests = [];
      process.exitCode = 0;
      stubClerk();
      await run(baseOptions);

      expect(created()).toEqual(["u2"]);
      expect(captured.err).toContain("which was interrupted");
    });

    /** Rewrites a finished run as one a crash stopped: no finish time. */
    const interrupt = (id: string, patch: Record<string, unknown> = {}) => {
      const record = readRun(runsDir(), id)!;
      delete record.finishedAt;
      fs.writeFileSync(
        path.join(runsDir(), id, "run.json"),
        JSON.stringify({ ...record, ...patch }),
      );
    };

    // The create went out and the run stopped before the answer came back.
    test("an interrupted run adopts a user Clerk created with no ID on record", async () => {
      stubClerk({ failing: new Set(["u2"]) });
      await run(baseOptions);
      const [first] = listRuns(runsDir());
      fs.appendFileSync(
        path.join(runsDir(), first!.id, "users.ndjson"),
        `${JSON.stringify({ sourceId: "u2", status: "creating" })}\n`,
      );
      interrupt(first!.id);

      requests = [];
      process.exitCode = 0;
      stubClerk({ existing: [{ id: "user_found", external_id: "u2" }] });
      await run(baseOptions);

      expect(created()).toEqual([]);
      expect(captured.err).toContain("1 user whose create was cut off is already in the instance");
      expect(latestUserLines(runsDir(), first!.id).get("u2")).toMatchObject({
        status: "created",
        clerkId: "user_found",
      });
      expect(readRun(runsDir(), first!.id)?.status).toBe("complete");
    });

    // The `creating` line records what the create did; a continued run reads it
    // back rather than guessing from this run's flags.
    test("an adopted user whose create reserved its unverified email gets no attach for it", async () => {
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([
          { id: "u1", primary_email_address: "a@x.dev" },
          { id: "u2", primary_email_address: "b@x.dev", unverified_email_addresses: "c@x.dev" },
        ]),
      );
      stubClerk({ failing: new Set(["u2"]) });
      await run(baseOptions);
      const [first] = listRuns(runsDir());
      fs.appendFileSync(
        path.join(runsDir(), first!.id, "users.ndjson"),
        `${JSON.stringify({ sourceId: "u2", status: "creating", reserved: true })}\n`,
      );
      interrupt(first!.id);

      requests = [];
      process.exitCode = 0;
      stubClerk({ existing: [{ id: "user_found", external_id: "u2" }] });
      await run(baseOptions);

      expect(created()).toEqual([]);
      expect(requests.filter((r) => r.url.endsWith("/v1/email_addresses"))).toEqual([]);
      expect(latestUserLines(runsDir(), first!.id).get("u2")).toMatchObject({
        status: "created",
        clerkId: "user_found",
      });
    });

    test("an interrupted run creates a user whose in-flight create never landed", async () => {
      stubClerk({ failing: new Set(["u2"]) });
      await run(baseOptions);
      const [first] = listRuns(runsDir());
      fs.appendFileSync(
        path.join(runsDir(), first!.id, "users.ndjson"),
        `${JSON.stringify({ sourceId: "u2", status: "creating" })}\n`,
      );
      interrupt(first!.id);

      requests = [];
      process.exitCode = 0;
      stubClerk();
      await run(baseOptions);

      expect(created()).toEqual(["u2"]);
    });

    test("a continued run with nothing left to do is finished", async () => {
      await run(baseOptions);
      const [first] = listRuns(runsDir());
      interrupt(first!.id);
      requests = [];

      await run(baseOptions);

      expect(created()).toEqual([]);
      expect(captured.err).toContain("No users left to import");
      expect(readRun(runsDir(), first!.id)).toMatchObject({ status: "complete" });
      expect(readRun(runsDir(), first!.id)?.finishedAt).toBeDefined();
    });

    // "Interrupted, so undo it and start over": the undo marks the run undone
    // but leaves it with no finish time.
    test("an interrupted run that was then undone is imported again as a new run", async () => {
      await run(baseOptions);
      const [first] = listRuns(runsDir());
      interrupt(first!.id, { status: "undone" });
      requests = [];

      await run(baseOptions);

      expect(created()).toEqual(["u1", "u2"]);
      expect(listRuns(runsDir()).filter((record) => record.kind === "import")).toHaveLength(2);
    });

    test("a run with an undo that did not finish refuses with exit 2", async () => {
      await run(baseOptions);
      const [first] = listRuns(runsDir());
      const undoRun = startRun(runsDir(), {
        kind: "undo",
        target: { instanceId: "ins_1" },
        undoes: first!.id,
      });
      undoRun.append({ sourceId: "u1", status: "deleted", clerkId: "user_u1" });
      undoRun.append({ sourceId: "u2", status: "failed", clerkId: "user_u2" });
      undoRun.finish();
      requests = [];

      const error = (await run(baseOptions).catch((caught: unknown) => caught)) as CliError;

      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      expect(error.message).toContain(`clerk migrate undo ${first!.id}`);
      expect(created()).toEqual([]);
    });

    test("an undone run is imported again as a new run", async () => {
      await run(baseOptions);
      const [first] = listRuns(runsDir());
      const record = readRun(runsDir(), first!.id)!;
      fs.writeFileSync(
        path.join(runsDir(), first!.id, "run.json"),
        JSON.stringify({ ...record, status: "undone" }),
      );
      requests = [];

      await run(baseOptions);

      expect(created()).toEqual(["u1", "u2"]);
      expect(listRuns(runsDir())).toHaveLength(2);
    });

    test("a run another live process holds refuses with exit 2", async () => {
      stubClerk({ failing: new Set(["u2"]) });
      await run(baseOptions);
      const [first] = listRuns(runsDir());
      const record = readRun(runsDir(), first!.id)!;
      delete record.finishedAt;
      fs.writeFileSync(path.join(runsDir(), first!.id, "run.json"), JSON.stringify(record));
      // PID 1 is always alive, and never this test.
      fs.writeFileSync(path.join(runsDir(), first!.id, "lock"), "1");

      expect(await exitCodeOf(run(baseOptions))).toBe(EXIT_CODE.USAGE);
    });

    // An edited file is a different job.
    test("a changed file is a new run", async () => {
      await run(baseOptions);
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([...export2, { id: "u3", primary_email_address: "c@x.dev" }]),
      );
      requests = [];

      await run(baseOptions);

      expect(listRuns(runsDir())).toHaveLength(2);
    });
  });

  describe("checks", () => {
    test("a reject stops the import, with the command that imports the rest", async () => {
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([...export2, { id: "u3" }]),
      );

      const error = (await run(baseOptions).catch((caught: unknown) => caught)) as CliError;

      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      expect(error.message).toContain("1 user would be rejected, so nothing was imported");
      expect(error.examples?.[0]?.command).toContain("--allow-partial --yes");
      expect(created()).toHaveLength(0);
      expect(listRuns(runsDir())).toHaveLength(0);
    });

    test("--allow-partial imports the rest and records each reject as skipped", async () => {
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([...export2, { id: "u3" }]),
      );

      await run({ ...baseOptions, allowPartial: true });

      expect(created()).toEqual(["u1", "u2"]);
      const [record] = listRuns(runsDir());
      expect(record).toMatchObject({ status: "partial", counts: { created: 2, skipped: 1 } });
      expect(latestUserLines(runsDir(), record!.id).get("u3")).toMatchObject({
        status: "skipped",
        reason: expect.stringContaining("invalid:"),
      });
      // The operator accepted the skips; only a failed user exits 1.
      expect(process.exitCode).toBe(0);
    });

    test("--dry-run writes nothing, and exits 2 when the import would be refused", async () => {
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([...export2, { id: "u3" }]),
      );

      await run({ ...baseOptions, dryRun: true });

      expect(created()).toHaveLength(0);
      expect(listRuns(runsDir())).toHaveLength(0);
      expect(captured.err).toContain("Dry run: nothing was written.");
      expect(process.exitCode).toBe(2);
    });

    test("--dry-run exits 0 when nothing would be rejected", async () => {
      await run({ ...baseOptions, dryRun: true });

      expect(created()).toHaveLength(0);
      expect(process.exitCode).toBe(0);
    });

    test("a user whose only email is unverified is rejected where email is required, with a fix", async () => {
      stubClerk({
        settings: { attributes: { email_address: { enabled: true, required: true } } },
      });
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([
          { id: "u1", primary_email_address: "a@x.dev" },
          { id: "u2", unverified_email_addresses: "b@x.dev" },
        ]),
      );

      await run({ ...baseOptions, dryRun: true });

      expect(captured.err).toContain(
        "only has an unverified email, and this instance requires an email",
      );
      expect(captured.err).toContain(
        `clerk config patch --app <app_id> --instance ins_1 --json '{"auth_email":{"required_for_sign_up":false}}'`,
      );
    });

    // Reserved meets the requirement, so neither the reject nor the fix applies.
    test("with --reserve-unverified, an unverified-only user is neither rejected nor a fix", async () => {
      stubClerk({
        settings: { attributes: { email_address: { enabled: true, required: true } } },
      });
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([
          { id: "u1", primary_email_address: "a@x.dev" },
          { id: "u2", unverified_email_addresses: "b@x.dev" },
        ]),
      );

      await run({ ...baseOptions, dryRun: true, reserveUnverified: true });

      expect(captured.err).not.toContain("only has an unverified email");
      expect(captured.err).not.toContain("required_for_sign_up");
      expect(process.exitCode).toBe(0);
    });

    test("legal consent: refused without --skip-legal-checks, sent with skip_legal_checks with it", async () => {
      stubClerk({
        settings: {
          attributes: { email_address: { enabled: true } },
          sign_up: { legal_consent_enabled: true },
        },
      });

      const error = (await run(baseOptions).catch((caught: unknown) => caught)) as CliError;
      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      expect(captured.err).toContain("no legal acceptance on record");
      expect(created()).toEqual([]);

      await run({ ...baseOptions, skipLegalChecks: true });
      const bodies = requests
        .filter((r) => r.method === "POST" && r.url.endsWith("/v1/users"))
        .map((r) => r.body);
      expect(bodies).toEqual([
        expect.objectContaining({ external_id: "u1", skip_legal_checks: true }),
        expect.objectContaining({ external_id: "u2", skip_legal_checks: true }),
      ]);
    });

    test("a user already in the instance is rejected", async () => {
      stubClerk({
        existing: [{ id: "user_old", email_addresses: [{ email_address: "b@x.dev" }] }],
      });

      await run({ ...baseOptions, dryRun: true });

      expect(captured.err).toContain("email is already used by a user in the instance");
      expect(Bun.stripANSI(captured.err)).toContain("u2");
    });

    test("the dev quota rejects users past the headroom; --allow-partial imports up to it", async () => {
      stubClerk({ count: 99 });

      expect(await exitCodeOf(run(baseOptions))).toBe(EXIT_CODE.USAGE);
      expect(created()).toHaveLength(0);

      await run({ ...baseOptions, allowPartial: true });
      expect(created()).toEqual(["u1"]);
      const [record] = listRuns(runsDir());
      expect(latestUserLines(runsDir(), record!.id).get("u2")?.reason).toContain("100-user limit");
    });

    test("supabase users whose only provider is disabled are rejected", async () => {
      stubClerk({
        settings: {
          attributes: { email_address: { enabled: true } },
          social: { oauth_google: { enabled: true } },
        },
      });
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([
          {
            id: "sb1",
            email: "a@x.dev",
            email_confirmed_at: "2024-01-01 00:00:00+00",
            raw_app_meta_data: '{"providers":["discord"]}',
          },
          {
            id: "sb2",
            email: "b@x.dev",
            email_confirmed_at: "2024-01-01 00:00:00+00",
            raw_app_meta_data: '{"providers":["email","discord"]}',
          },
        ]),
      );

      await run({ ...baseOptions, source: "supabase", dryRun: true });

      expect(captured.err).toContain("only signs in with Discord, which is not enabled in Clerk");
      expect(captured.err).toContain(
        "1 user signed in with Discord, which is not enabled in Clerk",
      );
    });

    test("names the fields Clerk won't store", async () => {
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify(export2.map((user) => ({ ...user, department: "Sales" }))),
      );

      await run({ ...baseOptions, dryRun: true });

      expect(captured.err).toContain("Clerk won't store: department (2 users)");
    });
  });

  describe("consent", () => {
    test("without --yes where nobody can be asked: the preview, then exit 2 with the command", async () => {
      const error = (await run({ ...baseOptions, yes: false }).catch(
        (caught: unknown) => caught,
      )) as CliError;

      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      expect(error.message).toContain("needs consent. Pass --yes to confirm");
      expect(error.examples?.[0]?.command).toBe(
        "clerk migrate import export.json --source clerk --secret-key <key> --yes",
      );
      expect(captured.err).toContain("Checks");
      expect(created()).toHaveLength(0);
    });

    test("--json --yes returns { target, run, checks, result }", async () => {
      await run({ ...baseOptions, json: true });

      expect(JSON.parse(captured.out)).toMatchObject({
        target: { instanceId: "ins_1" },
        run: { kind: "import", status: "complete" },
        checks: { total: 2, importable: 2, rejects: [] },
        result: { created: 2, failed: 0, skipped: 0 },
      });
    });

    test("--json leaves colour codes out of stderr", async () => {
      await run({ ...baseOptions, json: true });
      expect(captured.err).not.toContain("\x1b[");
    });

    test("--json without --yes returns the preview with consent required, and exits 2", async () => {
      expect(await exitCodeOf(run({ ...baseOptions, yes: false, json: true }))).toBe(
        EXIT_CODE.USAGE,
      );
      expect(JSON.parse(captured.out)).toMatchObject({
        consent: "required",
        checks: { importable: 2 },
      });
      expect(created()).toHaveLength(0);
    });
  });

  describe("--source <path>", () => {
    const CUSTOM = `export default {
      key: "myplatform",
      label: "My Platform",
      description: "Exports from My Platform.",
      transformer: { account_ref: "userId", contact_email: "email", given: "firstName", pw: "password" },
      carries: {
        passwords: { level: "yes", note: "bcrypt." },
        mfa: { level: "no", note: "None." },
        metadata: { level: "no", note: "None." },
      },
      defaults: { passwordHasher: "bcrypt" },
      postTransform: (user) => { if (!user.firstName) delete user.firstName; },
    };`;

    let customFile: string;
    let customCounter = 0;

    beforeEach(() => {
      // A fresh filename each time: dynamic import() caches by URL, so reusing
      // one would silently return a previous test's module.
      customFile = `./custom-run-${customCounter++}.ts`;
      fs.writeFileSync(path.join(workDir, customFile), CUSTOM);
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([
          { account_ref: "mp_1", contact_email: "a@x.dev", given: "Ada", pw: BCRYPT },
          { account_ref: "mp_2", contact_email: "b@x.dev", given: "", pw: BCRYPT },
        ]),
      );
    });

    afterEach(() => {
      __resetCustomSourcesForTesting();
    });

    const created = () => requests.filter((r) => r.url.endsWith("/v1/users"));

    // The registered key isn't something --source accepts; the path is.
    test("the printed command names the source's path, not its key", async () => {
      const error = (await run({
        input: "export.json",
        source: customFile,
        secretKey: "sk_test_x",
        json: true,
      }).catch((caught: unknown) => caught)) as CliError;

      expect(error.examples?.[0]?.command).toBe(
        `clerk migrate import export.json --source ${customFile} --secret-key <key> --json --yes`,
      );
    });

    test("imports through a user-authored source", async () => {
      await run({
        input: "export.json",
        source: customFile,
        yes: true,
        secretKey: "sk_test_x",
      });

      expect(created().map((r) => (r.body as { external_id: string }).external_id)).toEqual([
        "mp_1",
        "mp_2",
      ]);
      expect(captured.err).toContain("myplatform");
      expect(captured.err).toContain("source from");
    });

    test("applies the custom source's defaults and postTransform", async () => {
      await run({
        input: "export.json",
        source: customFile,
        yes: true,
        secretKey: "sk_test_x",
      });

      const bodies = created().map((r) => r.body as Record<string, unknown>);
      expect(bodies[0]).toMatchObject({ first_name: "Ada", password_hasher: "bcrypt" });
      // postTransform dropped the empty given name rather than sending "".
      expect("first_name" in (bodies[1] ?? {})).toBe(false);
    });

    // An edited source is a different source, so the run records which one.
    test("records the custom source's content hash on the run", async () => {
      await run({ input: "export.json", source: customFile, yes: true, secretKey: "sk_test_x" });

      const [record] = listRuns(runsDir());
      expect(record?.source).toBe("myplatform");
      expect(record?.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    });

    test("an unknown built-in key is a usage error listing the valid ones", async () => {
      await expect(
        run({ input: "export.json", source: "okta", yes: true, secretKey: "sk_test_x" }),
      ).rejects.toThrow(/Unknown source "okta". Valid sources: clerk, auth0/);
      expect(created()).toHaveLength(0);
    });

    test("fails before any request when the file is not there", async () => {
      await expect(
        run({
          input: "export.json",
          source: "./nope.ts",
          yes: true,
          secretKey: "sk_test_x",
        }),
      ).rejects.toThrow(/No source file at/);
      expect(requests).toHaveLength(0);
    });

    test("fails before any request when the file is malformed", async () => {
      const bad = `./bad-${customCounter++}.ts`;
      fs.writeFileSync(
        path.join(workDir, bad),
        `export default { key: "x", label: "X", transformer: {} };`,
      );

      const error = (await run({
        input: "export.json",
        source: bad,
        yes: true,
        secretKey: "sk_test_x",
      }).catch((caught: unknown) => caught)) as CliError;
      expect(error.message).toMatch(/no source field maps to `userId`/);
      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      expect(requests).toHaveLength(0);
    });

    test("still requires a file", async () => {
      await expect(run({ source: customFile, yes: true, secretKey: "sk_test_x" })).rejects.toThrow(
        /needs the file to import/,
      );
    });
  });

  describe("per-platform imports", () => {
    /** One realistic record per platform, in that platform's export shape. */
    const PLATFORMS: [string, unknown, string][] = [
      [
        "auth0",
        [
          {
            user_id: "auth0|1",
            email: "a@x.dev",
            email_verified: true,
            given_name: "Ada",
            family_name: "L",
          },
        ],
        "auth0|1",
      ],
      ["authjs", [{ id: "aj1", email: "a@x.dev", email_verified: "2024-01-01T00:00:00Z" }], "aj1"],
      [
        "betterauth",
        [{ user_id: "ba1", email: "a@x.dev", email_verified: true, password_hash: BCRYPT }],
        "ba1",
      ],
      [
        "supabase",
        [
          {
            id: "sb1",
            email: "a@x.dev",
            email_confirmed_at: "2024-06-29 20:25:06+00",
            encrypted_password: BCRYPT,
          },
        ],
        "sb1",
      ],
    ];

    test.each(PLATFORMS)(
      "%s transforms, validates and imports its export",
      async (key, records, externalId) => {
        fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify(records));

        await run({ ...baseOptions, source: key });

        const created = requests.filter((r) => r.url.endsWith("/v1/users"));
        expect(created).toHaveLength(1);
        expect((created[0]?.body as { external_id: string } | undefined)?.external_id).toBe(
          externalId,
        );
      },
    );

    test("firebase imports its wrapped export and builds the scrypt digest", async () => {
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify({
          users: [
            {
              localId: "fb1",
              email: "a@x.dev",
              emailVerified: true,
              passwordHash: "SGFzaA==",
              salt: "U2FsdA==",
            },
          ],
        }),
      );

      await run({
        ...baseOptions,
        source: "firebase",
        firebaseSignerKey: "SIGNER",
        firebaseSaltSeparator: "Bw==",
        firebaseRounds: 8,
        firebaseMemCost: 14,
      });

      const body = requests.find((r) => r.url.endsWith("/v1/users"))?.body as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        external_id: "fb1",
        password_digest: "SGFzaA==$U2FsdA==$SIGNER$Bw==$8$14",
        password_hasher: "scrypt_firebase",
      });
    });

    test("the printed command keeps the --firebase-* flags, as placeholders", async () => {
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify({ users: [{ localId: "fb1", email: "a@x.dev", emailVerified: true }] }),
      );

      const error = (await run({
        ...baseOptions,
        yes: false,
        source: "firebase",
        firebaseSignerKey: "SIGNER",
        firebaseSaltSeparator: "Bw==",
        firebaseRounds: 8,
        firebaseMemCost: 14,
      }).catch((caught: unknown) => caught)) as CliError;

      expect(error.examples?.[0]?.command).toContain(
        "--firebase-signer-key <key> --firebase-salt-separator <separator> --firebase-rounds <n> --firebase-mem-cost <n>",
      );
    });

    test("a partial firebase flag set fails before anything is read", async () => {
      await expect(
        run({ ...baseOptions, source: "firebase", firebaseSignerKey: "SIGNER" }),
      ).rejects.toThrow(/--firebase-salt-separator/);
      expect(requests).toHaveLength(0);
    });

    test("an unknown source fails listing the valid keys", async () => {
      await expect(run({ ...baseOptions, source: "okta" })).rejects.toThrow(
        /Unknown source "okta".*clerk.*supabase/s,
      );
    });
  });
});

describe("explainErrors", () => {
  const COUNTRY =
    "Phone numbers from this country (France) are currently not supported. For more information, please contact support.";
  const QUOTA =
    "You have reached your limit of 100 users. If you need more users, please use a Production instance.";

  test("names the development instance as the reason countries are blocked", () => {
    const [note] = explainErrors([COUNTRY], "dev");
    expect(note).toContain("Development instances block SMS to most countries");
    expect(note).toContain("test-emails-and-phones");
  });

  test("sends a production operator to the Dashboard instead of support", () => {
    const [note] = explainErrors([COUNTRY], "prod");
    expect(note).toContain("customization/sms/settings");
    expect(note).not.toContain("Development instances");
  });

  test("explains the user quota only where one applies", () => {
    expect(explainErrors([QUOTA], "dev").join(" ")).toContain("development-instance quota");
    // Production has no such quota, and the API's message already names the
    // plan upgrade in the one case it does.
    expect(explainErrors([QUOTA], "prod")).toEqual([]);
  });

  test("says nothing about errors it does not recognize", () => {
    expect(explainErrors(["Something else went wrong."], "dev")).toEqual([]);
  });
});

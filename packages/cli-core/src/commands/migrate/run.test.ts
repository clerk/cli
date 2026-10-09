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
import { explainErrors, run, validateRunOptions } from "./run.ts";
// After run.ts: imported first, signals.ts loads version.ts ahead of its Bun
// macro here, and the file fails to load.
import { _resetInterruptState, abortInFlight, beginInterrupt } from "../../lib/signals.ts";

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
  settings?: {
    attributes?: object;
    social?: object;
    sign_up?: object;
    enterprise_sso?: object;
  } | null;
  /** Users already in the instance, as `GET /v1/users` returns them. */
  existing?: {
    id: string;
    external_id?: string;
    username?: string;
    private_metadata?: Record<string, unknown>;
    email_addresses?: { email_address: string }[];
  }[];
  /** `GET /v1/users/count`. */
  count?: number;
  /** Source IDs whose `POST /v1/users` fails with a 422. */
  failing?: Set<string>;
  /** `GET /v1/instance` fails, so the target falls back to the key's stand-in ID. */
  instanceDown?: boolean;
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

      if (url.pathname === "/v1/instance" && stub.instanceDown) {
        return new Response("unavailable", { status: 503 });
      }
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

  // resolveBapiSecretKey takes --app over the exported key, so the sign-in is
  // still needed: without it the Platform API call fails instead.
  test("refuses an --app import when nobody is signed in, even with CLERK_SECRET_KEY set", async () => {
    const previous = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    try {
      await expect(
        run({ source: "clerk", input: "export.json", yes: true, app: "app_123" }),
      ).rejects.toThrow(/Not logged in/);
      expect(requests).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.CLERK_SECRET_KEY;
      else process.env.CLERK_SECRET_KEY = previous;
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
        /needs the file to import, and cannot prompt here/,
      );
      expect(requests).toHaveLength(0);
    });

    test("asks for --source when the file does not name its own", async () => {
      await expect(
        run({ input: "export.json", yes: true, secretKey: "sk_test_x" }),
      ).rejects.toThrow(/Missing --source/);
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

    // "will create 0 users" hides that the run records the rest as skipped.
    test("--allow-partial without --yes names the users it would skip", async () => {
      fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify([{ id: "u3" }]));

      await expect(run({ ...baseOptions, allowPartial: true, yes: false })).rejects.toThrow(
        "will create 0 users and skip 1 user. Pass --yes to confirm.",
      );
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
        settings: {
          attributes: { email_address: { enabled: true, required: true } },
          // A way in besides a password, so users without one import.
          enterprise_sso: { enabled: true },
        },
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
        `clerk config patch --app APP_ID --instance ins_1 --json '{"auth_email":{"required_for_sign_up":false}}'`,
      );
    });

    test("legal consent: refused without --skip-legal-checks, sent with skip_legal_checks with it", async () => {
      stubClerk({
        settings: {
          attributes: { email_address: { enabled: true } },
          sign_up: { legal_consent_enabled: true },
          // A way in besides a password, so users without one import.
          enterprise_sso: { enabled: true },
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
          // A way in besides a password, so users without one import.
          enterprise_sso: { enabled: true },
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
      expect(error.message).toContain(". Pass --yes to confirm");
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

    // An agent reads stderr as text.
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

  // The two `--json` outcomes that stop before a run exists: each says why,
  // with `run: null`.
  describe("--json, stopped before any run", () => {
    test("a refused import reports refused, and exits 2", async () => {
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([...export2, { id: "u3" }]),
      );
      expect(await exitCodeOf(run({ ...baseOptions, json: true }))).toBe(EXIT_CODE.USAGE);
      expect(JSON.parse(captured.out)).toMatchObject({ run: null, refused: true });
      expect(created()).toHaveLength(0);
    });

    test("a file with nobody to import reports nothingToImport", async () => {
      fs.writeFileSync(path.join(workDir, "export.json"), "[]");
      await run({ ...baseOptions, json: true });
      expect(JSON.parse(captured.out)).toMatchObject({ run: null, nothingToImport: true });
      expect(created()).toHaveLength(0);
    });
  });

  describe("stopped part-way", () => {
    // `importUsers` returns normally on a Ctrl-C; the run must not read as done.
    test("a Ctrl-C after the first create leaves the run unfinished, as interrupted", async () => {
      process.env.CLERK_MIGRATE_CONCURRENCY_LIMIT = "1";
      const clerk = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const response = await clerk(input, init);
        if (init?.method === "POST" && new URL(input.toString()).pathname === "/v1/users") {
          beginInterrupt();
          abortInFlight();
        }
        return response;
      }) as typeof fetch;
      try {
        // Thrown, so the gutter closes as paused rather than done.
        await expect(run(baseOptions)).rejects.toThrow();
      } finally {
        _resetInterruptState();
        delete process.env.CLERK_MIGRATE_CONCURRENCY_LIMIT;
      }

      const [record] = listRuns(runsDir());
      // The run folder is the only record of who was created.
      expect(captured.err).toContain(`Run ${record?.id}: `);
      expect(record?.finishedAt).toBeUndefined();
      expect(fs.existsSync(path.join(runsDir(), record?.id ?? "", "lock"))).toBe(false);
      expect(created()).toHaveLength(1);
    });

    test("the user quota leaves the rest not sent, and the run partial", async () => {
      stubClerk();
      const clerk = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST" && new URL(input.toString()).pathname === "/v1/users"
          ? Response.json(
              {
                errors: [
                  {
                    code: "user_quota_exceeded",
                    message: "user quota exceeded",
                    long_message: "You have reached your limit of 100 users.",
                  },
                ],
              },
              { status: 403 },
            )
          : clerk(input, init)) as typeof fetch;
      process.env.CLERK_MIGRATE_CONCURRENCY_LIMIT = "1";
      try {
        await run({ ...baseOptions, json: true });
      } finally {
        delete process.env.CLERK_MIGRATE_CONCURRENCY_LIMIT;
      }

      expect(JSON.parse(captured.out)).toMatchObject({
        run: { status: "partial" },
        result: {
          created: 0,
          failed: 1,
          notSent: 1,
          stopReason: "You have reached your limit of 100 users.",
        },
      });
    });

    // In the summary, after the progress bar: printed mid-run, the bar redrew
    // over it.
    test("the summary says why the import stopped", async () => {
      stubClerk();
      const clerk = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST" && new URL(input.toString()).pathname === "/v1/users"
          ? Response.json(
              {
                errors: [
                  {
                    code: "user_quota_exceeded",
                    message: "user quota exceeded",
                    long_message: "You have reached your limit of 100 users.",
                  },
                ],
              },
              { status: 403 },
            )
          : clerk(input, init)) as typeof fetch;
      await run(baseOptions);

      const err = Bun.stripANSI(captured.err);
      expect(err).toContain("Not sent: 1");
      expect(err).toContain(
        "No more users were sent. Once the limit is raised, run the import again with `--allow-partial --yes` to send them.",
      );
    });
  });

  describe("a phone Clerk refuses", () => {
    const COUNTRY =
      "Phone numbers from this country (France) are currently not supported. For more information, please contact support.";

    beforeEach(() => {
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([
          { id: "u1", primary_email_address: "a@x.dev", primary_phone_number: "+33612345678" },
        ]),
      );
      const clerk = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
        const isCreate =
          init?.method === "POST" && new URL(input.toString()).pathname === "/v1/users";
        if (isCreate && body.phone_number) {
          requests.push({ method: "POST", url: input.toString(), body });
          return Response.json(
            {
              errors: [
                { code: "unsupported_country_code", message: "unsupported", long_message: COUNTRY },
              ],
            },
            { status: 403 },
          );
        }
        return clerk(input, init);
      }) as typeof fetch;
    });

    // The user imports, so it is no failure, but the phone is gone.
    test("is counted in the summary, with the SMS note", async () => {
      await run(baseOptions);
      const err = Bun.stripANSI(captured.err);
      expect(err).toContain("Failed: 0");
      expect(err).toContain(`Imported without their phone:\n  1 user: ${COUNTRY}`);
      expect(err).toContain("Development instances block SMS");
    });

    test("is a warning in --json", async () => {
      await run({ ...baseOptions, json: true });
      expect(JSON.parse(captured.out)).toMatchObject({
        result: {
          created: 1,
          failed: 0,
          errors: [],
          warnings: [{ warning: `imported without their phone: ${COUNTRY}`, count: 1 }],
        },
      });
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
      stubClerk({
        existing: [
          { id: "user_found", external_id: "u2", private_metadata: { clerkMigrateRun: first!.id } },
        ],
      });
      await run(baseOptions);

      expect(created()).toEqual([]);
      expect(captured.err).toContain("1 user whose create was cut off is already in the instance");
      expect(latestUserLines(runsDir(), first!.id).get("u2")).toMatchObject({
        status: "created",
        clerkId: "user_found",
      });
      expect(readRun(runsDir(), first!.id)?.status).toBe("complete");
    });

    // A reject would stop a create; an adopted user needs none. Rejected, it
    // stayed `creating` and the run could never finish.
    test("an adopted user a check would reject still finishes the run", async () => {
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
      stubClerk({
        // Legal consent turned on since: u2 has no acceptance on record.
        settings: {
          attributes: { email_address: { enabled: true } },
          sign_up: { legal_consent_enabled: true },
          enterprise_sso: { enabled: true },
        },
        existing: [
          { id: "user_found", external_id: "u2", private_metadata: { clerkMigrateRun: first!.id } },
        ],
      });
      await run(baseOptions);

      expect(latestUserLines(runsDir(), first!.id).get("u2")).toMatchObject({
        status: "created",
        clerkId: "user_found",
      });
      expect(readRun(runsDir(), first!.id)?.status).toBe("complete");
    });

    // Same source ID, but no marker from this run: an app or another tool's
    // user, so it is never adopted.
    test("an interrupted run does not adopt a match without its marker", async () => {
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
      stubClerk({
        existing: [{ id: "user_theirs", external_id: "u2", private_metadata: {} }],
      });
      await run({ ...baseOptions, allowPartial: true });

      expect(created()).toEqual([]);
      expect(captured.err).not.toContain("whose create was cut off");
      expect(latestUserLines(runsDir(), first!.id).get("u2")).toMatchObject({
        status: "skipped",
        reason: "already in the instance, with this source ID",
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
    // Rate limiting right after a large import is when this lookup fails, and
    // that is when someone re-runs after an interruption.
    test("refuses to start over when Clerk can't name the instance a run of this file was in", async () => {
      stubClerk({ failing: new Set(["u2"]) });
      await run(baseOptions);

      requests = [];
      process.exitCode = 0;
      stubClerk({ instanceDown: true });
      await expect(run(baseOptions)).rejects.toThrow(/did not confirm which instance/);
      expect(created()).toEqual([]);
      expect(listRuns(runsDir())).toHaveLength(1);

      await run({ ...baseOptions, newRun: true, allowPartial: true });
      expect(listRuns(runsDir())).toHaveLength(2);
    });

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

  describe("per-platform imports", () => {
    test("supabase transforms, validates and imports its export", async () => {
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([
          {
            id: "sb1",
            email: "a@x.dev",
            email_confirmed_at: "2024-06-29 20:25:06+00",
            encrypted_password: BCRYPT,
          },
        ]),
      );

      await run({ ...baseOptions, source: "supabase" });

      expect(created()).toEqual(["sb1"]);
    });

    test("an unknown source fails listing the valid keys", async () => {
      const error = (await run({ ...baseOptions, source: "nope" }).catch(
        (caught: unknown) => caught,
      )) as CliError;
      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      expect(error.message).toContain('Unknown source "nope". Valid sources: clerk, supabase.');
      expect(requests).toHaveLength(0);
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
    // Production has no such quota by default, and the API's message already
    // names the plan upgrade when a plan sets one.
    expect(explainErrors([QUOTA], "prod")).toEqual([]);
  });

  test("says nothing about errors it does not recognize", () => {
    expect(explainErrors(["Something else went wrong."], "dev")).toEqual([]);
  });
});

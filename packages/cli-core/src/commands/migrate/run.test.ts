import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setConfigDir } from "../../lib/config.ts";
import { CliError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import { getLogDir } from "./lib/logger.ts";
import { __resetCustomTransformersForTesting } from "./transformers/registry.ts";
import { loadSettings } from "./lib/settings.ts";
import { applyResumeAfter, resolveFirebaseHashConfig, run, validateRunOptions } from "./run.ts";
import type { User } from "./types.ts";

let workDir: string;
let configDir: string;
let originalCwd: string;

const users = (...ids: string[]): User[] => ids.map((userId) => ({ userId }) as User);

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
  test("accepts a transformer and an existing JSON file", () => {
    expect(validateRunOptions({ transformer: "clerk", file: "users.json" })).toEqual({
      transformer: "clerk",
      file: "users.json",
    });
  });

  test.each([
    ["no transformer", { file: "users.json" }, /--transformer/],
    ["an unknown transformer", { transformer: "okta", file: "users.json" }, /Unknown transformer/],
    ["no file", { transformer: "clerk" }, /--file/],
    ["a missing file", { transformer: "clerk", file: "nope.json" }, /File not found/],
    [
      "an unsupported extension",
      { transformer: "clerk", file: "users.txt" },
      /Unsupported file type/,
    ],
  ])("rejects %s", (_label, options, message) => {
    expect(() => validateRunOptions(options)).toThrow(message);
  });

  test("names the valid transformers when one is missing", () => {
    expect(() => validateRunOptions({ file: "users.json" })).toThrow(/clerk/);
  });
});

describe("resolveFirebaseHashConfig", () => {
  const ALL = {
    firebaseSignerKey: "SIGNER",
    firebaseSaltSeparator: "Bw==",
    firebaseRounds: 8,
    firebaseMemCost: 14,
  };

  test("builds the config when all four flags are present", async () => {
    expect(await resolveFirebaseHashConfig(ALL)).toEqual({
      base64_signer_key: "SIGNER",
      base64_salt_separator: "Bw==",
      rounds: 8,
      mem_cost: 14,
    });
  });

  // A digest built from a partial set is well-formed but verifies against
  // nothing, so every migrated user would silently fail to sign in.
  test.each([
    ["firebaseSignerKey", "--firebase-signer-key"],
    ["firebaseSaltSeparator", "--firebase-salt-separator"],
    ["firebaseRounds", "--firebase-rounds"],
    ["firebaseMemCost", "--firebase-mem-cost"],
  ] as const)("rejects a set missing %s, naming the flag", async (omit, flag) => {
    const partial = { ...ALL };
    delete (partial as Record<string, unknown>)[omit];
    await expect(resolveFirebaseHashConfig(partial)).rejects.toThrow(new RegExp(flag));
  });

  test("names every missing flag at once", async () => {
    await expect(resolveFirebaseHashConfig({ firebaseSignerKey: "SIGNER" })).rejects.toThrow(
      /--firebase-salt-separator.*--firebase-rounds.*--firebase-mem-cost/,
    );
  });

  describe("environment fallback", () => {
    const captured = useCaptureLog();
    const ENV = {
      CLERK_FIREBASE_SIGNER_KEY: "ENV_SIGNER",
      CLERK_FIREBASE_SALT_SEPARATOR: "Bw==",
      CLERK_FIREBASE_ROUNDS: "8",
      CLERK_FIREBASE_MEM_COST: "14",
    };

    afterEach(() => {
      for (const name of Object.keys(ENV)) delete process.env[name];
    });

    const setEnv = (vars: Partial<typeof ENV>) => Object.assign(process.env, vars);

    test("builds the config when no flag is passed", async () => {
      setEnv(ENV);
      expect(await resolveFirebaseHashConfig({})).toEqual({
        base64_signer_key: "ENV_SIGNER",
        base64_salt_separator: "Bw==",
        rounds: 8,
        mem_cost: 14,
      });
    });

    test("prefers a flag over the environment", async () => {
      setEnv(ENV);
      expect((await resolveFirebaseHashConfig(ALL))?.base64_signer_key).toBe("SIGNER");
    });

    // Half from the environment and half from flags is still a complete set.
    test("fills only the gaps the flags left", async () => {
      setEnv({ CLERK_FIREBASE_ROUNDS: "8", CLERK_FIREBASE_MEM_COST: "14" });
      expect(
        await resolveFirebaseHashConfig({
          firebaseSignerKey: "SIGNER",
          firebaseSaltSeparator: "Bw==",
        }),
      ).toEqual({
        base64_signer_key: "SIGNER",
        base64_salt_separator: "Bw==",
        rounds: 8,
        mem_cost: 14,
      });
    });

    // Stale saved config, not an instruction: a signer key left over from a
    // Firebase migration must not fail the Supabase run that follows it. The
    // flag path stays strict — see "rejects a set missing %s" above.
    test("ignores a partial set rather than failing a run that never asked for it", async () => {
      setEnv({ CLERK_FIREBASE_SIGNER_KEY: "ENV_SIGNER" });

      expect(await resolveFirebaseHashConfig({})).toBeUndefined();
      expect(captured.err).toContain("Ignoring an incomplete Firebase hash configuration");
    });

    test("still fails when a flag supplied part of the set", async () => {
      setEnv({ CLERK_FIREBASE_SIGNER_KEY: "ENV_SIGNER" });
      await expect(resolveFirebaseHashConfig({ firebaseRounds: 8 })).rejects.toThrow(
        /--firebase-salt-separator/,
      );
    });

    // An empty var is how a shell spells "unset", and treating it as set would
    // demand the other three for a config nobody asked for.
    test("ignores an empty variable", async () => {
      setEnv({ CLERK_FIREBASE_SIGNER_KEY: "" });
      expect(await resolveFirebaseHashConfig({})).toBeUndefined();
    });
  });

  test("returns nothing when neither flags nor the environment supply a config", async () => {
    expect(await resolveFirebaseHashConfig({})).toBeUndefined();
  });
});

describe("applyResumeAfter", () => {
  test("returns everything when no ID is given", () => {
    expect(applyResumeAfter(users("a", "b"), undefined)).toHaveLength(2);
  });

  test("skips up to and including the named user", () => {
    expect(applyResumeAfter(users("a", "b", "c"), "b").map((u) => u.userId)).toEqual(["c"]);
  });

  test("returns nothing when the named user is last", () => {
    expect(applyResumeAfter(users("a", "b"), "b")).toEqual([]);
  });

  test("throws rather than silently re-importing everyone", () => {
    expect(() => applyResumeAfter(users("a"), "zz")).toThrow(CliError);
  });
});

describe("run", () => {
  const captured = useCaptureLog();
  let originalFetch: typeof globalThis.fetch;
  let requests: { method: string; url: string; body: unknown }[];

  const export2 = [
    {
      id: "u1",
      primary_email_address: "a@x.dev",
      password_digest: "d1",
      password_hasher: "bcrypt",
    },
    { id: "u2", primary_email_address: "b@x.dev" },
  ];

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  beforeEach(() => {
    requests = [];
    delete process.env.CLERK_MIGRATE_RATE_LIMIT;
    fs.rmSync(getLogDir(), { recursive: true, force: true });
    fs.rmSync(path.join(configDir, "config.json"), { force: true });
    fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify(export2));
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? "GET",
        url: input.toString(),
        body: init?.body ? JSON.parse(init.body as string) : null,
      });
      return new Response(JSON.stringify({ id: "user_created" }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exitCode = 0;
  });

  const baseOptions = {
    transformer: "clerk",
    file: "export.json",
    yes: true,
    secretKey: "sk_test_x",
  };

  test("imports every user in the file end to end", async () => {
    await run(baseOptions);

    const created = requests.filter((r) => r.url.endsWith("/v1/users"));
    expect(created).toHaveLength(2);
    expect(created[0]?.method).toBe("POST");
    expect(created.map((r) => (r.body as { external_id: string }).external_id)).toEqual([
      "u1",
      "u2",
    ]);
    expect(captured.err).toContain("Imported:");
  });

  test("writes a timestamped NDJSON log for the run", async () => {
    await run(baseOptions);

    const logs = fs.readdirSync(getLogDir());
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^migration-\d{4}-\d{2}-\d{2}T[\d-]+\.log$/);

    const entries = fs
      .readFileSync(path.join(getLogDir(), logs[0] as string), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.filter((e) => e.status === "success")).toHaveLength(2);
  });

  test("records the run's transformer and file for the next run", async () => {
    await run(baseOptions);
    expect(await loadSettings()).toEqual({ transformer: "clerk", file: "export.json" });
  });

  test("--require-password imports only the users that have one", async () => {
    await run({ ...baseOptions, requirePassword: true });

    const created = requests.filter((r) => r.url.endsWith("/v1/users"));
    expect(created.map((r) => (r.body as { external_id: string }).external_id)).toEqual(["u1"]);
    expect(captured.err).toContain("skipping 1 user without a password");
  });

  test("--resume-after skips everyone up to and including that ID", async () => {
    await run({ ...baseOptions, resumeAfter: "u1" });

    const created = requests.filter((r) => r.url.endsWith("/v1/users"));
    expect(created.map((r) => (r.body as { external_id: string }).external_id)).toEqual(["u2"]);
  });

  test("logs validation failures and imports the rest", async () => {
    fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify([...export2, { id: "u3" }]));

    await run(baseOptions);

    expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(2);
    expect(captured.err).toContain("1 user failed validation");
  });

  test("warns that --clerk-secret-key is deprecated but still honours it", async () => {
    await run({ ...baseOptions, secretKey: undefined, clerkSecretKey: "sk_test_x" });

    expect(captured.err).toContain("--clerk-secret-key is deprecated");
    expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(2);
  });

  test("refuses to exceed the development-instance user limit", async () => {
    fs.writeFileSync(
      path.join(workDir, "export.json"),
      JSON.stringify(
        Array.from({ length: 501 }, (_, i) => ({
          id: `u${i}`,
          primary_email_address: `u${i}@x.dev`,
        })),
      ),
    );

    await expect(run(baseOptions)).rejects.toThrow(/development instance/);
    expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(0);
  });

  test("aborts before any API call when the hasher is unrecognized", async () => {
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

    await expect(run(baseOptions)).rejects.toThrow(/Invalid password hasher/);
    expect(requests.filter((r) => r.url.endsWith("/v1/users"))).toHaveLength(0);
  });

  test("exits non-zero when some users failed", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ code: "e", message: "taken" }] }), {
        status: 422,
      })) as unknown as typeof fetch;

    await run(baseOptions);
    expect(process.exitCode).toBe(1);
  });

  // Tests run non-TTY, so `isHuman()` is false and the wizard path is never
  // reached — the same guard an agent hits.
  describe("without --transformer or --file", () => {
    test.each([
      [{}, /--transformer <platform> and --file <path>/],
      [{ transformer: "clerk" }, /--file <path>/],
      [{ file: "export.json" }, /--transformer <platform>/],
    ])("names the missing flags rather than prompting (%p)", async (partial, expected) => {
      await expect(run({ ...partial, yes: true, secretKey: "sk_test_x" })).rejects.toThrow(
        expected,
      );
      expect(requests).toHaveLength(0);
    });

    test("explains that it cannot prompt", async () => {
      await expect(run({ yes: true, secretKey: "sk_test_x" })).rejects.toThrow(
        /cannot prompt in agent mode/,
      );
    });
  });

  describe("readiness report", () => {
    /** Stubs BAPI plus the FAPI environment lookup the report depends on. */
    function stubInstanceSettings(
      settings: { attributes?: object; social?: object } | null,
      onUsers?: () => Response,
    ) {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        requests.push({
          method: init?.method ?? "GET",
          url,
          body: init?.body ? JSON.parse(init.body as string) : null,
        });
        if (url.endsWith("/v1/domains")) {
          if (!settings) return new Response("nope", { status: 500 });
          return Response.json({
            data: [{ is_satellite: false, frontend_api_url: "https://fapi.example.com" }],
          });
        }
        if (url.includes("/v1/dev_browser")) return Response.json({ token: "jwt" });
        if (url.includes("/v1/environment")) return Response.json({ user_settings: settings });
        return onUsers ? onUsers() : Response.json({ id: "user_created" });
      }) as unknown as typeof fetch;
    }

    const created = () => requests.filter((r) => r.url.endsWith("/v1/users"));

    // `-y` means nobody is watching, so the two extra round-trips buy nothing.
    test("is skipped for a -y run", async () => {
      stubInstanceSettings({ attributes: { email_address: { enabled: true } } });

      await run(baseOptions);

      expect(requests.some((r) => r.url.endsWith("/v1/domains"))).toBe(false);
      expect(captured.err).not.toContain("Migration readiness");
      expect(created()).toHaveLength(2);
    });

    test("renders before any user is created, and flags a required-but-missing field", async () => {
      stubInstanceSettings({
        attributes: {
          email_address: { enabled: true, required: true },
          username: { enabled: true },
        },
      });
      // One user has no email, so a required email address will cost them.
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([
          { id: "u1", primary_email_address: "a@x.dev" },
          { id: "u2", username: "bob" },
        ]),
      );

      await run({ ...baseOptions, yes: false });

      expect(captured.err).toContain("Migration readiness");
      expect(captured.err).toContain("1 user will not be imported");

      // The report was printed before the first POST /v1/users.
      const reportIndex = requests.findIndex((r) => r.url.includes("/v1/environment"));
      const firstCreate = requests.findIndex((r) => r.url.endsWith("/v1/users"));
      expect(reportIndex).toBeGreaterThanOrEqual(0);
      expect(reportIndex).toBeLessThan(firstCreate);
    });

    test("degrades to a note when the instance settings cannot be read", async () => {
      stubInstanceSettings(null);

      await run({ ...baseOptions, yes: false });

      expect(captured.err).toContain("Could not read this instance's settings");
      expect(created()).toHaveLength(2);
    });

    test("cross-references supabase providers against the instance", async () => {
      stubInstanceSettings({
        attributes: { email_address: { enabled: true } },
        social: { oauth_google: { enabled: true } },
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
        ]),
      );

      await run({ ...baseOptions, transformer: "supabase", yes: false });

      expect(captured.err).toContain("Social connections");
      expect(captured.err).toContain("Discord");
      expect(captured.err).toContain("not enabled in Clerk");
    });

    // Supabase lists `email` and `phone` in `providers` alongside real social
    // connections, and Clerk has no `oauth_email` to enable — so counting them
    // as social flagged every password user as a blocking problem.
    test("leaves supabase's email and phone pseudo-providers out of the social section", async () => {
      stubInstanceSettings({
        attributes: { email_address: { enabled: true } },
        social: { oauth_google: { enabled: true } },
      });
      fs.writeFileSync(
        path.join(workDir, "export.json"),
        JSON.stringify([
          {
            id: "sb1",
            email: "a@x.dev",
            email_confirmed_at: "2024-01-01 00:00:00+00",
            raw_app_meta_data: '{"providers":["email","discord"]}',
          },
        ]),
      );

      await run({ ...baseOptions, transformer: "supabase", yes: false });

      const social = captured.err.slice(captured.err.indexOf("Social connections"));
      expect(social).toContain("Discord");
      expect(social).not.toContain("Email");
      expect(social).not.toContain("Phone");
    });
  });

  describe("--transformer-file", () => {
    const CUSTOM = `export default {
      key: "myplatform",
      label: "My Platform",
      description: "Exports from My Platform.",
      transformer: { account_ref: "userId", contact_email: "email", given: "firstName", pw: "password" },
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
          { account_ref: "mp_1", contact_email: "a@x.dev", given: "Ada", pw: "$2b$10$hash" },
          { account_ref: "mp_2", contact_email: "b@x.dev", given: "", pw: "$2b$10$hash" },
        ]),
      );
    });

    afterEach(() => {
      __resetCustomTransformersForTesting();
    });

    const created = () => requests.filter((r) => r.url.endsWith("/v1/users"));

    test("imports through a user-authored transformer", async () => {
      await run({
        file: "export.json",
        transformerFile: customFile,
        yes: true,
        secretKey: "sk_test_x",
      });

      expect(created().map((r) => (r.body as { external_id: string }).external_id)).toEqual([
        "mp_1",
        "mp_2",
      ]);
      expect(captured.err).toContain("myplatform");
      expect(captured.err).toContain("transformer from");
    });

    test("applies the custom transformer's defaults and postTransform", async () => {
      await run({
        file: "export.json",
        transformerFile: customFile,
        yes: true,
        secretKey: "sk_test_x",
      });

      const bodies = created().map((r) => r.body as Record<string, unknown>);
      expect(bodies[0]).toMatchObject({ first_name: "Ada", password_hasher: "bcrypt" });
      // postTransform dropped the empty given name rather than sending "".
      expect("first_name" in (bodies[1] ?? {})).toBe(false);
    });

    // No sensible precedence between "the one you wrote" and "the one we ship".
    test("conflicts with --transformer rather than picking one", async () => {
      await expect(
        run({
          transformer: "clerk",
          file: "export.json",
          transformerFile: customFile,
          yes: true,
          secretKey: "sk_test_x",
        }),
      ).rejects.toThrow(/both name a transformer. Pass one or the other/);
      expect(created()).toHaveLength(0);
    });

    test("fails before any request when the file is not there", async () => {
      await expect(
        run({
          file: "export.json",
          transformerFile: "./nope.ts",
          yes: true,
          secretKey: "sk_test_x",
        }),
      ).rejects.toThrow(/No transformer file at/);
      expect(requests).toHaveLength(0);
    });

    test("fails before any request when the file is malformed", async () => {
      const bad = `./bad-${customCounter++}.ts`;
      fs.writeFileSync(
        path.join(workDir, bad),
        `export default { key: "x", label: "X", transformer: {} };`,
      );

      await expect(
        run({ file: "export.json", transformerFile: bad, yes: true, secretKey: "sk_test_x" }),
      ).rejects.toThrow(/no source field maps to `userId`/);
      expect(requests).toHaveLength(0);
    });

    test("still requires --file", async () => {
      await expect(
        run({ transformerFile: customFile, yes: true, secretKey: "sk_test_x" }),
      ).rejects.toThrow(/--file/);
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
        [{ user_id: "ba1", email: "a@x.dev", email_verified: true, password_hash: "$2a$10$h" }],
        "ba1",
      ],
      [
        "supabase",
        [
          {
            id: "sb1",
            email: "a@x.dev",
            email_confirmed_at: "2024-06-29 20:25:06+00",
            encrypted_password: "$2b$10$h",
          },
        ],
        "sb1",
      ],
    ];

    test.each(PLATFORMS)(
      "%s transforms, validates and imports its export",
      async (key, records, externalId) => {
        fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify(records));

        await run({ ...baseOptions, transformer: key });

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
        transformer: "firebase",
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

    test("a partial firebase flag set fails before anything is read", async () => {
      await expect(
        run({ ...baseOptions, transformer: "firebase", firebaseSignerKey: "SIGNER" }),
      ).rejects.toThrow(/--firebase-salt-separator/);
      expect(requests).toHaveLength(0);
    });

    test("an unknown transformer fails listing the valid keys", async () => {
      await expect(run({ ...baseOptions, transformer: "okta" })).rejects.toThrow(
        /Unknown transformer "okta".*clerk.*supabase/s,
      );
    });
  });

  describe("--skip-unsupported-providers", () => {
    const supabaseExport = [
      {
        id: "sb_email",
        email: "a@x.dev",
        email_confirmed_at: "2024-01-01 00:00:00+00",
        raw_app_meta_data: '{"providers":["email"]}',
      },
      {
        id: "sb_discord",
        email: "b@x.dev",
        email_confirmed_at: "2024-01-01 00:00:00+00",
        raw_app_meta_data: '{"providers":["discord"]}',
      },
      {
        id: "sb_both",
        email: "c@x.dev",
        email_confirmed_at: "2024-01-01 00:00:00+00",
        raw_app_meta_data: '{"providers":["email","discord"]}',
      },
    ];

    /** Stubs BAPI plus the FAPI environment lookup the check depends on. */
    function stubInstance(enabledSocial: Record<string, { enabled: boolean }> | null) {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        requests.push({
          method: init?.method ?? "GET",
          url,
          body: init?.body ? JSON.parse(init.body as string) : null,
        });
        if (url.endsWith("/v1/domains")) {
          if (!enabledSocial) return new Response("nope", { status: 500 });
          return Response.json({
            data: [{ is_satellite: false, frontend_api_url: "https://fapi.example.com" }],
          });
        }
        if (url.includes("/v1/dev_browser")) return Response.json({ token: "jwt" });
        if (url.includes("/v1/environment")) {
          return Response.json({ user_settings: { social: enabledSocial } });
        }
        return Response.json({ id: "user_created" });
      }) as unknown as typeof fetch;
    }

    const created = () =>
      requests
        .filter((r) => r.url.endsWith("/v1/users"))
        .map((r) => (r.body as { external_id: string }).external_id);

    beforeEach(() => {
      fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify(supabaseExport));
    });

    test("skips only the user whose sole provider is disabled", async () => {
      stubInstance({ oauth_google: { enabled: true }, oauth_discord: { enabled: false } });

      await run({ ...baseOptions, transformer: "supabase", skipUnsupportedProviders: true });

      expect(created()).toEqual(["sb_email", "sb_both"]);
      expect(captured.err).toContain("skipping 1 user ");
      expect(captured.err).toContain("discord: 1");
    });

    test("imports everyone when the provider is enabled", async () => {
      stubInstance({ oauth_discord: { enabled: true } });

      await run({ ...baseOptions, transformer: "supabase", skipUnsupportedProviders: true });

      expect(created()).toHaveLength(3);
    });

    // A failed lookup must not be read as "nothing is enabled" — that would
    // silently drop every social user.
    test("imports everyone when the instance config cannot be read", async () => {
      stubInstance(null);

      await run({ ...baseOptions, transformer: "supabase", skipUnsupportedProviders: true });

      expect(created()).toHaveLength(3);
      expect(captured.err).toContain("Could not read the instance's enabled providers");
    });

    test("is a no-op with a warning on a non-supabase transformer", async () => {
      fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify(export2));

      await run({ ...baseOptions, skipUnsupportedProviders: true });

      expect(created()).toHaveLength(2);
      expect(captured.err).toContain("only applies to supabase");
    });

    test("records the flag for the next run", async () => {
      stubInstance({ oauth_discord: { enabled: true } });

      await run({ ...baseOptions, transformer: "supabase", skipUnsupportedProviders: true });

      expect((await loadSettings()).skipUnsupportedProviders).toBe(true);
    });
  });
});

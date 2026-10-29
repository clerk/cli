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
import { _setConfigDir, setProfile } from "../../../lib/config.ts";
import { _resetMode, setMode } from "../../../mode.ts";
import { EXIT_CODE, type CliError } from "../../../lib/errors.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import {
  describeTarget,
  fetchInstanceIdentity,
  printTarget,
  resolveClerkTarget,
} from "./target.ts";

const captured = useCaptureLog();
const plapiModule = await import("../../../lib/plapi.ts");

describe("printTarget", () => {
  test.each([
    [
      "a linked app",
      {
        env: "production",
        appId: "app_1",
        appLabel: "My App",
        instanceId: "ins_1",
        keySource: "linked profile",
      },
      "Target: My App (app_1), production instance ins_1",
      "Key from: linked profile",
    ],
    [
      "a bare --secret-key",
      { env: "development", instanceId: "ins_2", keySource: "--secret-key" },
      "Target: development instance ins_2",
      "Key from: --secret-key",
    ],
    [
      "an exported CLERK_SECRET_KEY",
      { env: "development", instanceId: "ins_3", keySource: "CLERK_SECRET_KEY env var" },
      "Target: development instance ins_3",
      "Key from: CLERK_SECRET_KEY env var",
    ],
  ])("names %s", (_label, target, first, second) => {
    printTarget(target);
    const lines = Bun.stripANSI(captured.err).split("\n");
    expect(lines).toEqual([first, second]);
  });

  test("prints no escape codes for an agent", () => {
    setMode("agent");
    try {
      printTarget({ env: "development", instanceId: "ins_2", keySource: "--secret-key" });
    } finally {
      _resetMode();
    }
    expect(captured.err).toBe("Target: development instance ins_2\nKey from: --secret-key");
  });

  test("names an export's source platform", () => {
    printTarget({ platform: "auth0" });
    expect(captured.err).toBe("Source: auth0");
  });

  test("names the Clerk instance a Clerk export reads", () => {
    printTarget({ platform: "clerk", env: "production", instanceId: "ins_9" });
    expect(Bun.stripANSI(captured.err)).toBe("Source: Clerk, production instance ins_9");
  });
});

describe("describeTarget", () => {
  test("is one line for a list", () => {
    expect(describeTarget({ appLabel: "My App", env: "development", instanceId: "ins_1" })).toBe(
      "My App (development, ins_1)",
    );
    expect(describeTarget({ platform: "auth0" })).toBe("auth0");
  });
});

describe("fetchInstanceIdentity", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test("reads the instance behind the key", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        object: "instance",
        id: "ins_7",
        environment_type: "production",
      })) as unknown as typeof fetch;

    expect(await fetchInstanceIdentity("sk_live_x")).toEqual({
      instanceId: "ins_7",
      env: "production",
    });
  });

  // Absent means Clerk did not say (an API that predates the field), which is
  // not the same as `null`, no limit.
  test.each([
    [100, { maxAllowedUsers: 100 }],
    [null, { maxAllowedUsers: null }],
    [undefined, {}],
    ["100", {}],
    [-1, {}],
  ])("reads max_allowed_users %p", async (maxAllowedUsers, expected) => {
    globalThis.fetch = (async () =>
      Response.json({
        id: "ins_7",
        environment_type: "development",
        ...(maxAllowedUsers === undefined ? {} : { max_allowed_users: maxAllowedUsers }),
      })) as unknown as typeof fetch;

    expect(await fetchInstanceIdentity("sk_test_x")).toEqual({
      instanceId: "ins_7",
      env: "development",
      ...expected,
    });
  });

  test("retries a 429 rather than falling back", async () => {
    let calls = 0;
    globalThis.fetch = (async () =>
      ++calls === 1
        ? new Response("{}", { status: 429, headers: { "retry-after": "1" } })
        : Response.json({
            id: "ins_7",
            environment_type: "development",
          })) as unknown as typeof fetch;

    expect((await fetchInstanceIdentity("sk_test_x")).instanceId).toBe("ins_7");
    expect(calls).toBe(2);
  });

  // The same key always addresses the same instance, so a hash still tells two
  // instances apart when the API cannot say.
  test("falls back to a stable hash of the key when the instance cannot be read", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const first = await fetchInstanceIdentity("sk_test_a");
    expect(first.instanceId).toMatch(/^key_[0-9a-f]{16}$/);
    expect(first.env).toBe("development");
    expect(await fetchInstanceIdentity("sk_test_a")).toEqual(first);
    expect((await fetchInstanceIdentity("sk_test_b")).instanceId).not.toBe(first.instanceId);
  });
});

describe("resolveClerkTarget --instance", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalKey: string | undefined;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
    originalKey = process.env.CLERK_SECRET_KEY;
    globalThis.fetch = (async () =>
      Response.json({ id: "ins_prod", environment_type: "production" })) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = originalKey;
  });

  // An exported production key would otherwise win over `--instance dev`
  // without a word, and the import would write to production.
  test.each([
    ["an exported key", { instance: "dev" }, "sk_live_x"],
    ["--secret-key", { instance: "dev", secretKey: "sk_live_x" }, undefined],
    ["--secret-key, with a literal ID", { instance: "ins_dev", secretKey: "sk_live_x" }, undefined],
  ])("refuses %s that addresses another instance", async (_label, options, envKey) => {
    if (envKey) process.env.CLERK_SECRET_KEY = envKey;
    else delete process.env.CLERK_SECRET_KEY;

    const error = (await resolveClerkTarget(options).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(error.message).toContain("does not match the key");
  });

  test("says a literal --instance could not be verified when the lookup fails", async () => {
    delete process.env.CLERK_SECRET_KEY;
    const working = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    try {
      const error = (await resolveClerkTarget({
        instance: "ins_prod",
        secretKey: "sk_live_x",
      }).catch((e: unknown) => e)) as CliError;
      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      expect(error.message).toContain("Could not verify");
      expect(error.message).not.toContain("does not match");
    } finally {
      globalThis.fetch = working;
    }
  });

  test.each([["prod"], ["production"], ["ins_prod"]])("accepts --instance %s", async (instance) => {
    delete process.env.CLERK_SECRET_KEY;
    const { target } = await resolveClerkTarget({ instance, secretKey: "sk_live_x" });
    expect(target.instanceId).toBe("ins_prod");
  });
});

describe("resolveClerkTarget key source", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalKey: string | undefined;
  let originalCwd: string;
  let workDir: string;
  let configDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalKey = process.env.CLERK_SECRET_KEY;
    originalCwd = process.cwd();
    delete process.env.CLERK_SECRET_KEY;
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-target-")));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-target-config-"));
    _setConfigDir(configDir);
    process.chdir(workDir);
    globalThis.fetch = (async () =>
      Response.json({ id: "ins_1", environment_type: "development" })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = originalKey;
    _setConfigDir(undefined);
    process.chdir(originalCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  // A key in `.env` may be any app's, an account's included.
  test("names a key from .env by its file, not as an accountless app", async () => {
    fs.writeFileSync(path.join(workDir, ".env"), "CLERK_SECRET_KEY=sk_test_x\n");
    const { target } = await resolveClerkTarget({});
    expect(target.keySource).toBe(".env");
    expect(target.appLabel).toBeUndefined();
  });

  test("names the SDK's own keyless file as an accountless app", async () => {
    fs.mkdirSync(path.join(workDir, ".clerk", ".tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, ".clerk", ".tmp", "keyless.json"),
      JSON.stringify({ secretKey: "sk_test_x", publishableKey: "pk_test_x" }),
    );
    const { target } = await resolveClerkTarget({});
    expect(target).toMatchObject({
      keySource: "accountless app (.clerk/.tmp/keyless.json)",
      appLabel: "accountless app",
    });
  });

  // The profile names the instance; a stand-in would leave `runs` nothing it
  // can pass back with `--instance`.
  describe("a linked profile while GET /v1/instance fails", () => {
    let fetchApplication: ReturnType<typeof spyOn>;

    beforeEach(async () => {
      await setProfile(workDir, {
        workspaceId: "org_1",
        appId: "app_1",
        appName: "My App",
        instances: { development: "ins_dev", production: "ins_prod" },
      });
      fetchApplication = spyOn(plapiModule, "fetchApplication").mockResolvedValue({
        application_id: "app_1",
        name: "My App",
        instances: [
          {
            instance_id: "ins_prod",
            environment_type: "production",
            publishable_key: "pk_live_x",
            secret_key: "sk_live_x",
          },
        ],
      } as never);
      globalThis.fetch = (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch;
    });

    afterEach(() => {
      fetchApplication.mockRestore();
    });

    test("records the profile's instance", async () => {
      const { target } = await resolveClerkTarget({ instance: "prod" });
      expect(target).toMatchObject({
        instanceId: "ins_prod",
        env: "production",
        keySource: "linked profile",
      });
    });

    // The profile labels a literal ID with itself, which is no environment,
    // and the key prefix would only guess one: a staging key is `sk_live_`.
    test("records the environment as unknown for a literal --instance", async () => {
      const { target } = await resolveClerkTarget({ instance: "ins_prod" });
      expect(target).toMatchObject({ instanceId: "ins_prod", env: "unknown" });
    });
  });
});

// A stand-in is no ID `--app --instance` can resolve again, so a run recorded
// under one would suggest commands that fail, or reach another instance.
describe("resolveClerkTarget --app", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchApplication: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    fetchApplication = spyOn(plapiModule, "fetchApplication").mockResolvedValue({
      application_id: "app_123",
      name: "My App",
      instances: [
        {
          instance_id: "ins_staging",
          environment_type: "staging",
          publishable_key: "pk_test_x",
          secret_key: "sk_test_x",
        },
      ],
    } as never);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fetchApplication.mockRestore();
  });

  test("records the instance the Platform API named when GET /v1/instance fails", async () => {
    const { target } = await resolveClerkTarget({ app: "app_123", instance: "ins_staging" });
    expect(target).toMatchObject({ instanceId: "ins_staging", env: "staging", keySource: "--app" });
  });
});

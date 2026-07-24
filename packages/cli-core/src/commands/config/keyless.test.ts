import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setConfigDir, setProfile } from "../../lib/config.ts";
import { useCaptureLog, credentialStoreStubs, gitStubs, stubFetch } from "../../test/lib/stubs.ts";

mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
mock.module("../../lib/git.ts", () => gitStubs);
mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  pausedOutro: () => {},
  bar: () => {},
  withGutter: async (
    _title: string,
    fn: (controls: { setNextSteps: (steps: readonly string[]) => void }) => Promise<unknown>,
  ) => fn({ setNextSteps: () => {} }),
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const SECRET_KEY = "sk_test_keyless";
const BAPI_URL = "https://test-bapi.clerk.com";

const INSTANCE = { object: "instance", id: "ins_1", support_email: "old@example.com" };
const ORG_SETTINGS = { object: "organization_settings", enabled: false };
const COMMUNICATION = { object: "instance_communication", blocked_country_codes: [] };
const PROTECT = { object: "instance_protect", rules_enabled: false };
const OAUTH_SETTINGS = { object: "oauth_application_settings", dynamic_registration: false };

/** Readable groups keyed by BAPI path, mirroring what a pull collects. */
const READABLE_BODIES: Record<string, unknown> = {
  "/v1/instance": INSTANCE,
  "/v1/instance/communication": COMMUNICATION,
  "/v1/instance/organization_settings": ORG_SETTINGS,
  "/v1/instance/protect": PROTECT,
  "/v1/instance/oauth_application_settings": OAUTH_SETTINGS,
};

const FULL_ENVELOPE = {
  instance: INSTANCE,
  communication: COMMUNICATION,
  organization_settings: ORG_SETTINGS,
  protect: PROTECT,
  oauth_application_settings: OAUTH_SETTINGS,
};

describe("keyless config", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  let tempDir: string;
  let projectDir: string;
  let exitSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-keyless-config-"));
    projectDir = await mkdtemp(join(tmpdir(), "clerk-keyless-project-"));
    _setConfigDir(tempDir);
    process.env.CLERK_BACKEND_API_URL = BAPI_URL;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_PLATFORM_API_KEY;

    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    stubFetch(async (input, init) => {
      const path = input.toString().replace(BAPI_URL, "");
      const method = (init?.method ?? "GET").toUpperCase();

      // PATCH /v1/instance answers 204 with no body; every other group echoes.
      if (path === "/v1/instance" && method === "PATCH") {
        return new Response(null, { status: 204 });
      }
      if (path === "/v1/instance/restrictions" && method === "PATCH") {
        return new Response(JSON.stringify({ object: "instance_restrictions", allowlist: true }), {
          status: 200,
        });
      }
      if (path === "/v1/beta_features/instance_settings" && method === "PATCH") {
        return new Response(JSON.stringify({ object: "instance_settings", test_mode: true }), {
          status: 200,
        });
      }
      const body = READABLE_BODIES[path];
      if (body) return new Response(JSON.stringify(body), { status: 200 });

      throw new Error(`Unexpected fetch: ${method} ${path}`);
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    _setConfigDir(undefined);
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    exitSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  async function writeEnv(file: string, contents: string): Promise<void> {
    await writeFile(join(projectDir, file), contents);
  }

  describe("findLocalSecretKey", () => {
    test("returns undefined when the project has no secret key", async () => {
      const { findLocalSecretKey } = await import("../../lib/keyless-target.ts");
      expect(await findLocalSecretKey(projectDir)).toBeUndefined();
    });

    test("reads the key from .env", async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      const { findLocalSecretKey } = await import("../../lib/keyless-target.ts");

      expect(await findLocalSecretKey(projectDir)).toEqual({
        secretKey: SECRET_KEY,
        source: ".env",
      });
    });

    test(".env.local wins over .env", async () => {
      await writeEnv(".env", "CLERK_SECRET_KEY=sk_test_stale\n");
      await writeEnv(".env.local", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      const { findLocalSecretKey } = await import("../../lib/keyless-target.ts");

      expect(await findLocalSecretKey(projectDir)).toEqual({
        secretKey: SECRET_KEY,
        source: ".env.local",
      });
    });

    test("falls back to the keys an SDK created for itself", async () => {
      await mkdir(join(projectDir, ".clerk", ".tmp"), { recursive: true });
      await writeFile(
        join(projectDir, ".clerk", ".tmp", "keyless.json"),
        JSON.stringify({
          publishableKey: "pk_test_sdk",
          secretKey: SECRET_KEY,
          claimUrl: "https://dashboard.clerk.com/apps/claim?token=x",
        }),
      );
      const { findLocalSecretKey } = await import("../../lib/keyless-target.ts");

      expect(await findLocalSecretKey(projectDir)).toEqual({
        secretKey: SECRET_KEY,
        source: ".clerk/.tmp/keyless.json",
      });
    });

    test("prefers env files over the SDK's own keys", async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      await mkdir(join(projectDir, ".clerk", ".tmp"), { recursive: true });
      await writeFile(
        join(projectDir, ".clerk", ".tmp", "keyless.json"),
        JSON.stringify({ secretKey: "sk_test_sdk_stale" }),
      );
      const { findLocalSecretKey } = await import("../../lib/keyless-target.ts");

      expect(await findLocalSecretKey(projectDir)).toEqual({
        secretKey: SECRET_KEY,
        source: ".env",
      });
    });

    test("ignores a malformed SDK keyless file", async () => {
      await mkdir(join(projectDir, ".clerk", ".tmp"), { recursive: true });
      await writeFile(join(projectDir, ".clerk", ".tmp", "keyless.json"), "{ not json");
      const { findLocalSecretKey } = await import("../../lib/keyless-target.ts");

      expect(await findLocalSecretKey(projectDir)).toBeUndefined();
    });

    test("the environment wins over env files", async () => {
      await writeEnv(".env", "CLERK_SECRET_KEY=sk_test_from_file\n");
      process.env.CLERK_SECRET_KEY = SECRET_KEY;
      const { findLocalSecretKey } = await import("../../lib/keyless-target.ts");

      expect(await findLocalSecretKey(projectDir)).toEqual({
        secretKey: SECRET_KEY,
        source: "CLERK_SECRET_KEY env var",
      });
    });
  });

  describe("resolveKeylessTarget", () => {
    test("resolves for an unlinked project holding a secret key", async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      const { resolveKeylessTarget } = await import("../../lib/keyless-target.ts");

      expect(await resolveKeylessTarget({ cwd: projectDir })).toEqual({
        secretKey: SECRET_KEY,
        source: ".env",
      });
    });

    test("defers to the account path when --app is passed", async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      const { resolveKeylessTarget } = await import("../../lib/keyless-target.ts");

      expect(await resolveKeylessTarget({ app: "app_1", cwd: projectDir })).toBeUndefined();
    });

    test("resolves even when a platform API key is set, and says why", async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform";
      const { resolveKeylessTarget } = await import("../../lib/keyless-target.ts");

      expect(await resolveKeylessTarget({ cwd: projectDir })).toEqual({
        secretKey: SECRET_KEY,
        source: ".env",
      });
      expect(captured.err).toContain("isn't linked to an application");
    });

    test("stays quiet about the reduced coverage when there is no account", async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      const { resolveKeylessTarget } = await import("../../lib/keyless-target.ts");

      await resolveKeylessTarget({ cwd: projectDir });

      expect(captured.err).not.toContain("isn't linked to an application");
    });

    test("defers to the account path when the project is linked", async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      await setProfile(projectDir, {
        workspaceId: "org_1",
        appId: "app_1",
        instances: { development: "ins_dev" },
      });
      const { resolveKeylessTarget } = await import("../../lib/keyless-target.ts");

      expect(await resolveKeylessTarget({ cwd: projectDir })).toBeUndefined();
    });

    test("defers to the account path when no secret key is present", async () => {
      const { resolveKeylessTarget } = await import("../../lib/keyless-target.ts");
      expect(await resolveKeylessTarget({ cwd: projectDir })).toBeUndefined();
    });

    test("rejects --instance, which the secret key already determines", async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      const { resolveKeylessTarget } = await import("../../lib/keyless-target.ts");

      await expect(resolveKeylessTarget({ instance: "prod", cwd: projectDir })).rejects.toThrow(
        /--instance is not supported for an unclaimed keyless application/,
      );
    });

    test("rejects a key that is not a secret key", async () => {
      await writeEnv(".env", "CLERK_SECRET_KEY=pk_test_not_a_secret\n");
      const { resolveKeylessTarget } = await import("../../lib/keyless-target.ts");

      await expect(resolveKeylessTarget({ cwd: projectDir })).rejects.toThrow(
        /Expected a secret key starting with/,
      );
    });
  });

  describe("assertKeylessPayload", () => {
    test("accepts the supported groups", async () => {
      const { assertKeylessPayload } = await import("./keyless.ts");
      expect(() =>
        assertKeylessPayload({ instance: { support_email: "a@b.com" }, restrictions: {} }),
      ).not.toThrow();
    });

    test("rejects unknown keys and names the supported ones", async () => {
      const { assertKeylessPayload } = await import("./keyless.ts");
      expect(() => assertKeylessPayload({ session: { lifetime: 10 } })).toThrow(
        /Unsupported config key .*session.*\n.*instance, communication, restrictions, organization_settings, protect, oauth_application_settings, instance_settings/s,
      );
    });

    test("rejects a group whose value is not an object", async () => {
      const { assertKeylessPayload } = await import("./keyless.ts");
      expect(() => assertKeylessPayload({ instance: "nope" })).toThrow(/must be a JSON object/);
    });
  });

  describe("pullKeylessConfig", () => {
    test("returns an envelope of the readable groups", async () => {
      const { pullKeylessConfig } = await import("./keyless.ts");

      const config = await pullKeylessConfig({ secretKey: SECRET_KEY, source: ".env" });

      expect(config).toEqual(FULL_ENVELOPE);
    });

    test("stays quiet about restrictions on a default pull", async () => {
      const { pullKeylessConfig } = await import("./keyless.ts");

      await pullKeylessConfig({ secretKey: SECRET_KEY, source: ".env" });

      expect(captured.err).not.toContain("no read route");
    });

    test("warns that restrictions cannot be read and omits it", async () => {
      const { pullKeylessConfig } = await import("./keyless.ts");

      const config = await pullKeylessConfig({ secretKey: SECRET_KEY, source: ".env" }, [
        "restrictions",
      ]);

      expect(config).toEqual({});
      expect(captured.err).toContain("no read route for restrictions");
    });

    test("rejects unknown keys", async () => {
      const { pullKeylessConfig } = await import("./keyless.ts");

      await expect(
        pullKeylessConfig({ secretKey: SECRET_KEY, source: ".env" }, ["session"]),
      ).rejects.toThrow(/Unsupported config key/);
    });
  });

  describe("patchKeylessConfig", () => {
    test("sends each group to its own endpoint", async () => {
      const requests: string[] = [];
      stubFetch(async (input, init) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        requests.push(`${method} ${url.replace(BAPI_URL, "")}`);
        if (url.endsWith("/v1/instance") && method === "PATCH") {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/v1/instance")) {
          return new Response(JSON.stringify(INSTANCE), { status: 200 });
        }
        return new Response(JSON.stringify(ORG_SETTINGS), { status: 200 });
      });
      const { patchKeylessConfig } = await import("./keyless.ts");

      const result = await patchKeylessConfig(
        { secretKey: SECRET_KEY, source: ".env" },
        {
          instance: { support_email: "new@example.com" },
          organization_settings: { enabled: true },
        },
      );

      expect(requests).toEqual([
        "PATCH /v1/instance",
        // 204 carries no body, so the group is re-read for the caller.
        "GET /v1/instance",
        "PATCH /v1/instance/organization_settings",
      ]);
      expect(result).toEqual({ instance: INSTANCE, organization_settings: ORG_SETTINGS });
    });

    test("applies groups in table order, not payload order", async () => {
      const requests: string[] = [];
      stubFetch(async (input, init) => {
        const path = input.toString().replace(BAPI_URL, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "PATCH") requests.push(path);
        if (path === "/v1/instance" && method === "PATCH")
          return new Response(null, { status: 204 });
        return new Response(JSON.stringify(READABLE_BODIES[path] ?? {}), { status: 200 });
      });
      const { patchKeylessConfig } = await import("./keyless.ts");

      await patchKeylessConfig(
        { secretKey: SECRET_KEY, source: ".env" },
        { protect: { rules_enabled: true }, instance: { support_email: "a@b.com" } },
      );

      expect(requests).toEqual(["/v1/instance", "/v1/instance/protect"]);
    });

    test("names the already-applied groups when a later group fails", async () => {
      stubFetch(async (input, init) => {
        const path = input.toString().replace(BAPI_URL, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/v1/instance/protect" && method === "PATCH") {
          return new Response(JSON.stringify({ errors: [{ message: "nope" }] }), { status: 422 });
        }
        if (path === "/v1/instance" && method === "PATCH") {
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify(READABLE_BODIES[path] ?? {}), { status: 200 });
      });
      const { patchKeylessConfig } = await import("./keyless.ts");

      // `withApiContext` attaches the explanation as `error.context`, which the
      // global handler prints alongside the API message.
      await expect(
        patchKeylessConfig(
          { secretKey: SECRET_KEY, source: ".env" },
          { instance: { support_email: "a@b.com" }, protect: { rules_enabled: true } },
        ),
      ).rejects.toMatchObject({ context: "Failed to update protect (already applied: instance)" });
    });

    test("returns the response body for groups that answer with one", async () => {
      const { patchKeylessConfig } = await import("./keyless.ts");

      const result = await patchKeylessConfig(
        { secretKey: SECRET_KEY, source: ".env" },
        { restrictions: { allowlist: true } },
      );

      expect(result).toEqual({
        restrictions: { object: "instance_restrictions", allowlist: true },
      });
    });
  });

  describe("config commands in a keyless project", () => {
    beforeEach(async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      process.chdir(projectDir);
    });

    test("pull prints the BAPI envelope without an account", async () => {
      const { configPull } = await import("./pull.ts");

      await configPull({});

      expect(captured.out).toContain(JSON.stringify(FULL_ENVELOPE, null, 2));
    });

    test("patch applies the payload without an account", async () => {
      const { configPatch } = await import("./push.ts");

      await configPatch({ json: '{"instance":{"support_email":"new@example.com"}}', yes: true });

      expect(captured.err).toContain("Config pushed successfully");
    });

    test("patch --dry-run sends nothing", async () => {
      const requests: string[] = [];
      stubFetch(async (input, init) => {
        requests.push(`${(init?.method ?? "GET").toUpperCase()} ${input.toString()}`);
        return new Response(JSON.stringify(INSTANCE), { status: 200 });
      });
      const { configPatch } = await import("./push.ts");

      await configPatch({ json: '{"instance":{"support_email":"new@example.com"}}', dryRun: true });

      expect(requests.every((request) => request.startsWith("GET"))).toBe(true);
      expect(captured.err).toContain("[dry-run] Nothing sent");
    });

    test("patch rejects unreachable keys before showing a diff or touching the API", async () => {
      let requested = false;
      stubFetch(async () => {
        requested = true;
        return new Response(JSON.stringify(INSTANCE), { status: 200 });
      });
      const { configPatch } = await import("./push.ts");

      await expect(configPatch({ json: '{"session":{"lifetime":1}}', yes: true })).rejects.toThrow(
        /Unsupported config key/,
      );
      expect(requested).toBe(false);
      expect(captured.err).not.toContain("Updating config");
    });

    test("patch rejects config keys BAPI cannot reach", async () => {
      const { configPatch } = await import("./push.ts");

      await expect(
        configPatch({ json: '{"session":{"lifetime":3600}}', yes: true }),
      ).rejects.toThrow(/Unsupported config key/);
    });

    test("put explains that a full replace needs a claimed application", async () => {
      const { configPut } = await import("./push.ts");

      await expect(configPut({ json: '{"instance":{}}', yes: true })).rejects.toThrow(
        /Replacing the entire configuration is only available for a claimed application/,
      );
    });

    test("enable orgs applies organization settings without an account", async () => {
      const requests: string[] = [];
      stubFetch(async (input, init) => {
        const path = input.toString().replace(BAPI_URL, "");
        const method = (init?.method ?? "GET").toUpperCase();
        requests.push(`${method} ${path}`);
        return new Response(JSON.stringify(READABLE_BODIES[path] ?? ORG_SETTINGS), { status: 200 });
      });
      const { orgsEnable } = await import("../orgs/index.ts");

      await orgsEnable({ yes: true, maxMembers: "7" });

      expect(requests).toContain("PATCH /v1/instance/organization_settings");
      expect(captured.err).toContain("Organizations enabled");
    });

    test("whoami reports the keyless instance instead of demanding a login", async () => {
      const { whoami } = await import("../whoami/index.ts");

      await whoami({ json: true });

      const payload = JSON.parse(captured.out);
      expect(payload.email).toBeNull();
      expect(payload.keyless.instanceId).toBe("ins_1");
      expect(payload.keyless.keySource).toBe(".env");
    });

    test("env pull writes the locally-held keyless keys", async () => {
      await writeEnv(
        ".env",
        `CLERK_SECRET_KEY=${SECRET_KEY}\nCLERK_PUBLISHABLE_KEY=pk_test_local\n`,
      );
      const { pull } = await import("../env/pull.ts");

      await pull({ cwd: projectDir, file: join(projectDir, ".env.written") });

      const written = await Bun.file(join(projectDir, ".env.written")).text();
      expect(written).toContain(`CLERK_SECRET_KEY=${SECRET_KEY}`);
      expect(captured.err).toContain("Keyless application keys");
    });

    test("enable billing explains that billing needs a claimed application", async () => {
      const { billingEnable } = await import("../billing/index.ts");

      await expect(billingEnable({ for: ["users"], yes: true })).rejects.toThrow(
        /Billing can only be configured on a claimed application/,
      );
    });

    test("schema explains that it needs a claimed application", async () => {
      const { configSchema } = await import("./schema.ts");

      await expect(configSchema({})).rejects.toThrow(
        /Config schema is only available for a claimed application/,
      );
    });
  });
});

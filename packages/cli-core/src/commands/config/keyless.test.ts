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

  /** Mutable per-test state so a PATCH's effect actually shows up on the next GET/re-read. */
  let bapiState: Record<string, unknown>;

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

    bapiState = structuredClone(READABLE_BODIES);

    stubFetch(async (input, init) => {
      const path = input.toString().replace(BAPI_URL, "");
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET") {
        const body = bapiState[path];
        if (body) return new Response(JSON.stringify(body), { status: 200 });
        throw new Error(`Unexpected fetch: ${method} ${path}`);
      }

      // PATCH /v1/instance answers 204 with no body but does persist the
      // fields it accepts, so a re-read after it reflects the write.
      if (path === "/v1/instance" && method === "PATCH") {
        bapiState[path] = { ...(bapiState[path] as object), ...JSON.parse(init?.body as string) };
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
      if (method === "PATCH" && bapiState[path]) {
        bapiState[path] = { ...(bapiState[path] as object), ...JSON.parse(init?.body as string) };
        return new Response(JSON.stringify(bapiState[path]), { status: 200 });
      }

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

    test("resolves even when a platform API key is set", async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform";
      const { resolveKeylessTarget } = await import("../../lib/keyless-target.ts");

      expect(await resolveKeylessTarget({ cwd: projectDir })).toEqual({
        secretKey: SECRET_KEY,
        source: ".env",
      });
    });

    // The reduced-coverage warning belongs to the config surface, not to
    // resolution — `whoami`, `open` and `doctor` want the same keyless answer
    // whether or not an account exists, and a resolver that warns is one a
    // diagnostic tool can't call without polluting its own report.
    test("stays quiet about reduced coverage — that warning is the config surface's", async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform";
      const { resolveKeylessTarget } = await import("../../lib/keyless-target.ts");

      await resolveKeylessTarget({ cwd: projectDir });

      expect(captured.err).not.toContain("isn't linked to an application");
    });

    test("resolveInstanceTarget is the one that says the keyless view covers less", async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform";
      const { resolveInstanceTarget } = await import("../../lib/keyless-target.ts");

      const target = await resolveInstanceTarget({ cwd: projectDir });

      expect(target.kind).toBe("keyless");
      expect(captured.err).toContain("isn't linked to an application");
    });

    test("says nothing about linking when there is no account at all", async () => {
      await writeEnv(".env", `CLERK_SECRET_KEY=${SECRET_KEY}\n`);
      const { resolveInstanceTarget } = await import("../../lib/keyless-target.ts");

      await resolveInstanceTarget({ cwd: projectDir });

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

    test("points account-only keys at `clerk auth login`", async () => {
      const { assertKeylessPayload } = await import("./keyless.ts");
      expect(() => assertKeylessPayload({ session: { lifetime: 10 } })).toThrow(
        /Run `clerk auth login` to claim the application/,
      );
    });

    // enterprise_connections/saml_connections/oauth_applications/domains are
    // BAPI resource collections reachable on an unclaimed application today —
    // verified live via `clerk api /enterprise_connections`. Telling the user
    // to claim the app for these would be a detour to nowhere: claiming
    // doesn't add them to the config document either.
    test("points BAPI resource collections at `clerk api` instead of login", async () => {
      const { assertKeylessPayload } = await import("./keyless.ts");
      expect(() => assertKeylessPayload({ enterprise_connections: {} })).toThrow(
        /use `clerk api \/enterprise_connections` directly instead of this config document/,
      );
    });

    test("does not suggest `clerk auth login` for a BAPI resource collection", async () => {
      const { assertKeylessPayload } = await import("./keyless.ts");
      expect(() => assertKeylessPayload({ domains: {} })).not.toThrow(/clerk auth login/);
    });

    test("rejects a group whose value is not an object", async () => {
      const { assertKeylessPayload } = await import("./keyless.ts");
      expect(() => assertKeylessPayload({ instance: "nope" })).toThrow(/must be a JSON object/);
    });

    // `PATCH /v1/instance` answers 204 and drops field names it doesn't know,
    // so an unrecognised field there is invisible in the response — the only
    // place it can be caught is before the request goes out.
    test("rejects an `instance` field the Backend API would silently drop", async () => {
      const { assertKeylessPayload } = await import("./keyless.ts");
      expect(() => assertKeylessPayload({ instance: { suport_email: "a@b.com" } })).toThrow(
        /Unsupported field on `instance`.*suport_email/s,
      );
    });

    test.each([
      ["password", "which authentication strategies are enabled"],
      ["social", "social sign-in providers"],
      ["second_factors", "multi-factor authentication policy"],
    ])("explains that `instance.%s` has no Backend API route at all", async (field, reason) => {
      const { assertKeylessPayload } = await import("./keyless.ts");
      expect(() => assertKeylessPayload({ instance: { [field]: true } })).toThrow(
        new RegExp(`no route for ${reason}`),
      );
    });

    test.each([
      "test_mode",
      "hibp",
      "support_email",
      "clerk_js_version",
      "development_origin",
      "allowed_origins",
      "cookieless_dev",
      "url_based_session_syncing",
      "preferred_sign_in_strategy_when_password_required",
    ])("accepts the documented `instance` field %s", async (field) => {
      const { assertKeylessPayload } = await import("./keyless.ts");
      expect(() => assertKeylessPayload({ instance: { [field]: "x" } })).not.toThrow();
    });

    test("leaves fields on other groups alone — their writes echo back", async () => {
      const { assertKeylessPayload } = await import("./keyless.ts");
      expect(() => assertKeylessPayload({ protect: { nonsense_field: true } })).not.toThrow();
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
    test("sends each group to its own endpoint and confirms the fields landed", async () => {
      const requests: string[] = [];
      stubFetch(async (input, init) => {
        const path = input.toString().replace(BAPI_URL, "");
        const method = (init?.method ?? "GET").toUpperCase();
        requests.push(`${method} ${path}`);
        if (path === "/v1/instance" && method === "PATCH") {
          bapiState[path] = { ...(bapiState[path] as object), ...JSON.parse(init?.body as string) };
          return new Response(null, { status: 204 });
        }
        if (method === "GET") return new Response(JSON.stringify(bapiState[path]), { status: 200 });
        const updated = { ...(bapiState[path] as object), ...JSON.parse(init?.body as string) };
        bapiState[path] = updated;
        return new Response(JSON.stringify(updated), { status: 200 });
      });
      const { patchKeylessConfig } = await import("./keyless.ts");

      const result = await patchKeylessConfig(
        { secretKey: SECRET_KEY, source: ".env" },
        {
          instance: { support_email: "new@example.com" },
          organization_settings: { enabled: true },
        },
      );

      expect(requests).toEqual(["PATCH /v1/instance", "PATCH /v1/instance/organization_settings"]);
      // `instance` answered 204, so it contributes no state — deliberately
      // absent rather than re-read, because that read is eventually consistent
      // and would show the pre-write value under a success message.
      expect(result.applied).toEqual({
        organization_settings: { ...ORG_SETTINGS, enabled: true },
      });
      expect(result.verification).toEqual({
        verifiedFields: ["organization_settings.enabled"],
        droppedFields: [],
        unverifiableGroups: ["instance"],
      });
    });

    test("never re-reads a group whose write answered with no body", async () => {
      // Regression: the re-read this asserts against returned the pre-write
      // value often enough that `Config pushed successfully` was printed
      // directly above stale state, reading as though nothing had been applied.
      const requests: string[] = [];
      stubFetch(async (input, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        requests.push(`${method} ${input.toString().replace(BAPI_URL, "")}`);
        return new Response(null, { status: 204 });
      });
      const { patchKeylessConfig } = await import("./keyless.ts");

      const result = await patchKeylessConfig(
        { secretKey: SECRET_KEY, source: ".env" },
        { instance: { support_email: "new@example.com" } },
      );

      expect(requests).toEqual(["PATCH /v1/instance"]);
      expect(result.applied).toEqual({});
      expect(result.verification.unverifiableGroups).toEqual(["instance"]);
      expect(result.verification.droppedFields).toEqual([]);
    });

    test("names an unconfirmed group as already applied when a later group fails", async () => {
      // `instance` leaves no trace in the envelope, but it did land — a failure
      // downstream still has to say so or the user can't tell how far it got.
      stubFetch(async (input) => {
        const path = input.toString().replace(BAPI_URL, "");
        if (path === "/v1/instance") return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ errors: [{ message: "nope" }] }), { status: 500 });
      });
      const { patchKeylessConfig } = await import("./keyless.ts");

      // `withApiContext` attaches the context to the error rather than to its
      // message; the global handler prints the two together.
      const error = await patchKeylessConfig(
        { secretKey: SECRET_KEY, source: ".env" },
        { instance: { support_email: "new@example.com" }, protect: { rules_enabled: true } },
      ).catch((thrown: unknown) => thrown);

      expect((error as { context?: string }).context).toBe(
        "Failed to update protect (already applied: instance)",
      );
    });

    test("reports a field the API silently dropped instead of claiming it landed", async () => {
      // A typo'd field: BAPI's PATCH routes ignore unknown fields inside a
      // group rather than rejecting them, so the request answers 200 with the
      // resource as it actually stands — without the typo'd key.
      stubFetch(async () => new Response(JSON.stringify(PROTECT), { status: 200 }));
      const { patchKeylessConfig } = await import("./keyless.ts");

      const result = await patchKeylessConfig(
        { secretKey: SECRET_KEY, source: ".env" },
        { protect: { rules_enabledx: true } as Record<string, unknown> },
      );

      expect(result.verification).toEqual({
        verifiedFields: [],
        droppedFields: ["protect.rules_enabledx"],
        unverifiableGroups: [],
      });
    });

    // The whole point of checking the PATCH response and not a follow-up read.
    // `instance.support_email` is writable but never echoed by `GET /v1/instance`,
    // and BAPI's reads are eventually consistent — verifying against a re-read
    // reported both as dropped when the write had in fact landed.
    test("never calls a successful instance write dropped just because the read can't show it", async () => {
      stubFetch(async (input, init) => {
        const path = input.toString().replace(BAPI_URL, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/v1/instance" && method === "PATCH")
          return new Response(null, { status: 204 });
        // The read never carries support_email, and still shows the pre-write
        // allowed_origins — exactly what the real API does.
        return new Response(
          JSON.stringify({ ...INSTANCE, allowed_origins: ["https://stale.example.com"] }),
          { status: 200 },
        );
      });
      const { patchKeylessConfig } = await import("./keyless.ts");

      const result = await patchKeylessConfig(
        { secretKey: SECRET_KEY, source: ".env" },
        {
          instance: {
            support_email: "new@example.com",
            allowed_origins: ["https://fresh.example.com"],
          },
        },
      );

      expect(result.verification.droppedFields).toEqual([]);
      expect(result.verification.unverifiableGroups).toEqual(["instance"]);
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

    // A group having no GET route doesn't make its write unverifiable: what
    // the PATCH itself answers with is the resource as it now stands, which is
    // the only evidence the check ever uses.
    test("verifies a write-only group from the body its own PATCH returns", async () => {
      const { patchKeylessConfig } = await import("./keyless.ts");

      const result = await patchKeylessConfig(
        { secretKey: SECRET_KEY, source: ".env" },
        { restrictions: { allowlist: true } },
      );

      expect(result.applied).toEqual({
        restrictions: { object: "instance_restrictions", allowlist: true },
      });
      expect(result.verification).toEqual({
        verifiedFields: ["restrictions.allowlist"],
        droppedFields: [],
        unverifiableGroups: [],
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
        if (method === "PATCH") {
          // Reflect the write on the next read so the round-trip check confirms it.
          bapiState[path] = { ...(bapiState[path] as object), ...JSON.parse(init?.body as string) };
        }
        return new Response(JSON.stringify(bapiState[path] ?? ORG_SETTINGS), { status: 200 });
      });
      const { orgsEnable } = await import("../orgs/index.ts");

      await orgsEnable({ yes: true, maxMembers: "7" });

      expect(requests).toContain("PATCH /v1/instance/organization_settings");
      expect(captured.err).toContain("Organizations enabled");
    });

    test("disable orgs works without an account and without the billing pre-flight", async () => {
      // Start from orgs enabled, or the disable is a no-op and nothing is sent.
      bapiState["/v1/instance/organization_settings"] = { ...ORG_SETTINGS, enabled: true };
      const requests: string[] = [];
      stubFetch(async (input, init) => {
        const path = input.toString().replace(BAPI_URL, "");
        const method = (init?.method ?? "GET").toUpperCase();
        requests.push(`${method} ${path}`);
        if (method === "PATCH") {
          bapiState[path] = { ...(bapiState[path] as object), ...JSON.parse(init?.body as string) };
        }
        return new Response(JSON.stringify(bapiState[path] ?? ORG_SETTINGS), { status: 200 });
      });
      const { orgsDisable } = await import("../orgs/index.ts");

      // Keyless has no account config document, so `current` is undefined and
      // the org-billing pre-flight is skipped — this pins that the disable
      // path tolerates that instead of reaching for `current.billing`.
      await orgsDisable({ yes: true });

      expect(requests).toContain("PATCH /v1/instance/organization_settings");
      // Every request is a bare BAPI path (the BAPI base URL was stripped) —
      // a Platform API config fetch would show up here as a full foreign URL.
      expect(requests.every((line) => / \/v1\//.test(line))).toBe(true);
      expect(captured.err).toContain("Organizations disabled");
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

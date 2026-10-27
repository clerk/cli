import { describe, expect, test } from "bun:test";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import {
  applyGoogleConnection,
  auditGoogleConnection,
  auditGoogleHealth,
  googleCloudSteps,
  googleRedirectUri,
} from "./native-google.ts";
import {
  DEBUG_SHA1,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  fakeGoogleAPI,
} from "./test-helpers.ts";

const captured = useCaptureLog();
const target = { applicationId: "app_test", instanceId: "ins_test" };
const credentials = { clientId: FAKE_GOOGLE_CLIENT_ID, clientSecret: FAKE_GOOGLE_CLIENT_SECRET };
const SHARED_FIELD = "SHARED_CREDENTIAL_FIELD_MUST_SURVIVE";

describe("the Google connection", () => {
  test("reads health without credentials leaving the module", async () => {
    const { api } = fakeGoogleAPI({
      enabled: true,
      client_id: FAKE_GOOGLE_CLIENT_ID,
      client_secret: FAKE_GOOGLE_CLIENT_SECRET,
    });
    const health = await auditGoogleHealth(target, api);
    expect(health).toEqual({
      status: "satisfied",
      credentials: "satisfied",
      current: { enabled: true, authenticatable: true, clientId: FAKE_GOOGLE_CLIENT_ID },
      blockers: [],
    });
    expect(JSON.stringify(health)).not.toContain(FAKE_GOOGLE_CLIENT_SECRET);
  });

  test("a disabled connection without a client needs both", async () => {
    const { api } = fakeGoogleAPI({ enabled: false });
    const plan = await auditGoogleConnection(target, api);
    expect(plan).toMatchObject({
      status: "ready",
      credentials: "required",
      configVersion: "v1_1234abcd",
    });
    expect(plan.actions).toHaveLength(2);
  });

  test("Clerk's shared development credentials don't count as a Web client", async () => {
    const { api } = fakeGoogleAPI({ enabled: true, client_id: "" });
    const plan = await auditGoogleConnection(target, api);
    expect(plan).toMatchObject({ status: "ready", credentials: "required" });
    expect(plan.actions).toEqual([expect.stringContaining("Set the Google Web client ID")]);
  });

  test("blocks on an unauthenticatable connection, a missing schema, or a missing version", async () => {
    const policy = fakeGoogleAPI({ enabled: true, authenticatable: false });
    expect((await auditGoogleConnection(target, policy.api)).blockers.map((b) => b.code)).toEqual([
      "google-authenticatable-conflict",
    ]);
    const schema = fakeGoogleAPI({ enabled: false });
    schema.state.schemaMissing = true;
    expect((await auditGoogleConnection(target, schema.api)).blockers.map((b) => b.code)).toEqual([
      "google-config-unsupported",
    ]);
    const version = fakeGoogleAPI({ enabled: false });
    version.state.noVersion = true;
    expect((await auditGoogleConnection(target, version.api)).blockers.map((b) => b.code)).toEqual([
      "google-config-version-unavailable",
    ]);
    const invalid = fakeGoogleAPI({ enabled: "yes" });
    expect((await auditGoogleHealth(target, invalid.api)).blockers.map((b) => b.code)).toEqual([
      "google-config-invalid",
    ]);
  });

  test("enables and sets the Web client with a dry run, an If-Match write, and a verifying read", async () => {
    const { api, state } = fakeGoogleAPI({ enabled: false, some_other_field: SHARED_FIELD });
    const plan = await auditGoogleConnection(target, api);
    const checks: string[] = [];
    await applyGoogleConnection(plan, credentials, {
      api,
      revalidateLocalPreconditions: async () => {
        checks.push("local");
      },
    });
    expect(state.events).toEqual(["google-dry-run", "google-apply"]);
    expect(checks).toEqual(["local"]);
    expect(state.connection).toEqual({
      enabled: true,
      authenticatable: true,
      client_id: FAKE_GOOGLE_CLIENT_ID,
      client_secret: FAKE_GOOGLE_CLIENT_SECRET,
      some_other_field: SHARED_FIELD,
    });
    expect(captured.err + captured.out).not.toContain(FAKE_GOOGLE_CLIENT_SECRET);
  });

  test("leaves an existing Web client alone and only enables the connection", async () => {
    const { api, state } = fakeGoogleAPI({
      enabled: false,
      client_id: FAKE_GOOGLE_CLIENT_ID,
      client_secret: "EXISTING_SECRET_MUST_NOT_CHANGE",
    });
    const plan = await auditGoogleConnection(target, api);
    expect(plan.credentials).toBe("satisfied");
    await applyGoogleConnection(plan, credentials, { api });
    expect(state.patches).toEqual([{ enabled: true, authenticatable: true }]);
    expect(state.connection.client_secret).toBe("EXISTING_SECRET_MUST_NOT_CHANGE");
  });

  test("a satisfied connection makes no write", async () => {
    const { api, state } = fakeGoogleAPI({ enabled: true, client_id: FAKE_GOOGLE_CLIENT_ID });
    await applyGoogleConnection(await auditGoogleConnection(target, api), undefined, { api });
    expect(state.events).toEqual([]);
  });

  test("refuses to apply without credentials when the connection needs them", async () => {
    const { api, state } = fakeGoogleAPI({ enabled: false });
    await expect(
      applyGoogleConnection(await auditGoogleConnection(target, api), undefined, { api }),
    ).rejects.toThrow("--google-client-secret-file");
    expect(state.events).toEqual([]);
  });

  test("stops when the server's merge would change a field it doesn't own", async () => {
    const { api, state } = fakeGoogleAPI({ enabled: false, some_other_field: SHARED_FIELD });
    const plan = await auditGoogleConnection(target, api);
    const patch = api.patchInstanceConfig;
    api.patchInstanceConfig = async (...args) => {
      const response = await patch(...args);
      (
        response.after as Record<string, Record<string, unknown>>
      ).connection_oauth_google!.some_other_field = "changed";
      return response;
    };
    await expect(applyGoogleConnection(plan, credentials, { api })).rejects.toThrow(
      "did not match the approved change",
    );
    expect(state.events).toEqual(["google-dry-run"]);
  });

  test("names the project's values in the Google Cloud steps", () => {
    const steps = googleCloudSteps({
      packageName: "com.example.app",
      sha1: DEBUG_SHA1,
      frontendHost: "fixture.clerk.accounts.dev",
    });
    expect(steps.join("\n")).toContain(
      "package name com.example.app and SHA-1 certificate fingerprint " + DEBUG_SHA1,
    );
    expect(steps.join("\n")).toContain(googleRedirectUri("fixture.clerk.accounts.dev"));
    expect(googleRedirectUri("x.clerk.accounts.dev")).toBe(
      "https://x.clerk.accounts.dev/v1/oauth_callback",
    );
    expect(googleCloudSteps({ packageName: "a.b" }).join("\n")).toContain(
      "<SHA-1 of your signing certificate",
    );
  });
});

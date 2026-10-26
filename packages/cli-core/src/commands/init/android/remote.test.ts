import { describe, expect, test } from "bun:test";
import { PlapiError } from "../../../lib/errors.ts";
import {
  applyRemote,
  auditRemote,
  matchingRegistration,
  remoteActions,
  type RemoteContext,
} from "./remote.ts";
import {
  DEBUG_FINGERPRINT,
  FIXTURE_KEY,
  RELEASE_FINGERPRINT,
  fakeNativeAPI,
} from "./test-helpers.ts";

const context: RemoteContext = {
  applicationId: "app_test",
  instanceId: "ins_test",
  publishableKey: FIXTURE_KEY,
  frontendHost: "fixture.clerk.accounts.dev",
  packageName: "com.example.app",
  fingerprints: [DEBUG_FINGERPRINT],
};
const registration = (
  fingerprints: string[],
  packageName = "com.example.app",
  namespace = "android_app",
) => ({
  object: "android_application" as const,
  id: "androidapp_1",
  namespace,
  package_name: packageName,
  fingerprints,
});

describe("registrations", () => {
  test("matches the package exactly and accepts extra fingerprints", () => {
    expect(
      matchingRegistration(context, [registration([DEBUG_FINGERPRINT, RELEASE_FINGERPRINT])]),
    ).toBeDefined();
    expect(
      matchingRegistration(context, [registration([DEBUG_FINGERPRINT], "com.example.App")]),
    ).toBeUndefined();
    expect(matchingRegistration(context, [registration(["ab".repeat(32)])])).toBeDefined();
  });

  test("stops when the registration lacks a known fingerprint, with the Dashboard remedy", () => {
    expect(() => matchingRegistration(context, [registration([RELEASE_FINGERPRINT])])).toThrow(
      "Native Applications page",
    );
    expect(() => matchingRegistration(context, [registration([])])).toThrow("no fingerprints");
  });

  test("refuses duplicate or foreign-namespace registrations", () => {
    expect(() =>
      matchingRegistration(context, [
        registration([DEBUG_FINGERPRINT]),
        registration([DEBUG_FINGERPRINT]),
      ]),
    ).toThrow("2 registrations");
    expect(() =>
      matchingRegistration(context, [registration([DEBUG_FINGERPRINT], "com.example.app", "web")]),
    ).toThrow('namespace "web"');
  });

  test("lists what the instance still needs", () => {
    expect(remoteActions(context, false, []).actions).toEqual([
      "register-application",
      "enable-native-api",
    ]);
    expect(remoteActions(context, true, [registration([DEBUG_FINGERPRINT])]).actions).toEqual([]);
  });
});

describe("applying remote setup", () => {
  test("registers with a deterministic idempotency key, then enables Native API, then verifies", async () => {
    const { api, state } = fakeNativeAPI();
    const plan = await auditRemote(context, api);
    expect(plan.actions).toEqual(["register-application", "enable-native-api"]);
    await applyRemote(plan, api);
    expect(state.events).toEqual(["register", "enable-native"]);
    expect(state.registrations[0]).toMatchObject({
      namespace: "android_app",
      package_name: "com.example.app",
      fingerprints: [DEBUG_FINGERPRINT],
    });
    expect(state.keys[0]).toMatch(/^android-init-[a-f0-9]{64}$/);
    const { api: again, state: second } = fakeNativeAPI();
    await applyRemote(await auditRemote(context, again), again);
    expect(second.keys).toEqual(state.keys);
  });

  test("a rerun changes nothing", async () => {
    const { api, state } = fakeNativeAPI();
    await applyRemote(await auditRemote(context, api), api);
    state.events.length = 0;
    const plan = await auditRemote(context, api);
    expect(plan.actions).toEqual([]);
    await applyRemote(plan, api);
    expect(state.events).toEqual([]);
  });

  test("reconciles a registration whose response was lost", async () => {
    const { api, state } = fakeNativeAPI();
    state.lostCreate = true;
    await applyRemote(await auditRemote(context, api), api);
    expect(state.registrations).toHaveLength(1);
  });

  test("reports a failed registration and never registers twice", async () => {
    const { api, state } = fakeNativeAPI();
    state.createError = new PlapiError(500, "{}", "native_applications/android");
    await expect(applyRemote(await auditRemote(context, api), api)).rejects.toThrow(PlapiError);
    expect(state.events).toEqual(["register"]);
    expect(state.enabled).toBe(false);
  });

  test("needs a fingerprint to register", async () => {
    const { api } = fakeNativeAPI();
    const plan = await auditRemote({ ...context, fingerprints: [] }, api);
    await expect(applyRemote(plan, api)).rejects.toThrow("--android-fingerprint");
  });

  test("refuses a stale plan", async () => {
    const { api, state } = fakeNativeAPI();
    const plan = await auditRemote(context, api);
    state.changedKey = true;
    await expect(applyRemote(plan, api)).rejects.toThrow("instance key changed");
    state.changedKey = false;
    state.production = true;
    await expect(applyRemote(plan, api)).rejects.toThrow("exactly one development instance");
  });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import * as prompts from "../../../lib/prompts.ts";
import * as lists from "../../../lib/listage.ts";
import * as spinner from "../../../lib/spinner.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { runAndroidInit } from "./coordinator.ts";
import {
  createAndroidFixture,
  DEBUG_FINGERPRINT,
  DEBUG_SHA1,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  fakeGoogleAPI,
  fakeNativeAPI,
  FIXTURE_KEY,
  keystore,
  RELEASE_FINGERPRINT,
} from "./test-helpers.ts";

const captured = useCaptureLog();
const roots: string[] = [];
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(async () => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
  process.exitCode = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(options: Parameters<typeof createAndroidFixture>[0] = {}) {
  const root = await createAndroidFixture(options);
  roots.push(root);
  const { api, state } = fakeNativeAPI();
  return {
    root,
    state,
    dependencies: {
      api,
      googleAPI: fakeGoogleAPI({ enabled: false }).api,
      debugKeystore: keystore(),
    },
  };
}

describe("clerk init for Android", () => {
  test("interactive setup asks for the SDK artifact and confirmation, then reports next steps", async () => {
    const f = await fixture();
    const confirm = spyOn(prompts, "confirm").mockImplementation(
      async ({ message }) => message === "Apply this setup?",
    );
    const select = spyOn(lists, "select").mockResolvedValue("ui");
    const outro = spyOn(spinner, "outro").mockResolvedValue(undefined);
    spies.push(confirm, select, outro);
    await runAndroidInit({ root: f.root, agent: false }, "app_test", f.dependencies);
    expect(select.mock.calls[0]![0].message).toContain("Which Clerk SDK artifact");
    expect(confirm.mock.calls.map((call) => call[0].message)).toEqual([
      "Enable native Sign in with Google?",
      "Apply this setup?",
    ]);
    expect(await readFile(join(f.root, "app/build.gradle.kts"), "utf8")).toContain(
      "clerk-android-ui:1.3.0",
    );
    expect(f.state.registrations).toHaveLength(1);
    expect(captured.err).toContain("Found Android app: com.example.myapp");
    expect(captured.err).toContain("Register the native app in Clerk");
    expect(captured.err).toContain(
      "SDK dependency declared · Clerk initialized · native registration verified",
    );
    expect(captured.err).not.toContain(FIXTURE_KEY);
    expect(outro).toHaveBeenCalledWith("CLI setup complete; app verification remains");
  });

  test("declining the confirmation changes nothing", async () => {
    const f = await fixture();
    spies.push(
      spyOn(prompts, "confirm").mockResolvedValue(false),
      spyOn(lists, "select").mockResolvedValue("core"),
    );
    await expect(
      runAndroidInit({ root: f.root, agent: false }, "app_test", f.dependencies),
    ).rejects.toThrow();
    expect(f.state.events).toEqual([]);
    expect(await Bun.file(join(f.root, "app/src/main/res/values/clerk.xml")).exists()).toBe(false);
  });

  test("an agent gets the result and handoff as JSON; reruns are idempotent", async () => {
    const f = await fixture();
    await runAndroidInit({ root: f.root, agent: true, json: true }, "app_test", f.dependencies);
    const result = JSON.parse(captured.out);
    expect(result).toMatchObject({
      status: "requires-build-and-verification",
      appIntegrationComplete: false,
      remote: "verified",
      identity: { applicationId: "com.example.myapp", fingerprints: [DEBUG_FINGERPRINT] },
      handoff: { kind: "clerk-android-integration", publishableKey: FIXTURE_KEY },
    });
    captured.clear();
    await runAndroidInit({ root: f.root, agent: true, json: true }, "app_test", f.dependencies);
    expect(JSON.parse(captured.out)).toMatchObject({
      local: "unchanged",
      remote: "verified",
      changedFiles: [],
    });
    expect(f.state.registrations).toHaveLength(1);
  });

  test("--yes takes the core artifact and an installed UI artifact is kept", async () => {
    const f = await fixture({ clerk: { product: "ui", version: "1.3.0" } });
    await runAndroidInit({ root: f.root, agent: true, json: true }, "app_test", f.dependencies);
    expect(JSON.parse(captured.out).handoff.context.sdk).toBe("ui");
  });

  test("a dry run inspects without an application, keytool, or Clerk", async () => {
    const f = await fixture();
    const outro = spyOn(spinner, "outro").mockResolvedValue(undefined);
    spies.push(outro);
    await runAndroidInit({ root: f.root, agent: false, dryRun: true }, undefined, {
      api: {
        fetchApplication: async () => {
          throw new Error("unexpected");
        },
      } as never,
      debugKeystore: async () => {
        throw new Error("unexpected");
      },
    });
    expect(captured.err).toContain("Set up com.example.myapp (app)");
    expect(captured.err).toContain(
      "Create app/src/main/java/com/example/myapp/ClerkApplication.kt",
    );
    expect(outro).toHaveBeenCalledWith("Inspection complete; no setup applied");
    captured.clear();
    await runAndroidInit(
      { root: f.root, agent: true, dryRun: true, json: true },
      undefined,
      f.dependencies,
    );
    expect(JSON.parse(captured.out)).toMatchObject({
      mode: "read-only",
      remote: "Manual Dashboard setup",
    });
  });

  test("a missing fingerprint becomes an input-required status for agents", async () => {
    const f = await fixture();
    const dependencies = { api: f.dependencies.api, debugKeystore: keystore("no-keytool") };
    await expect(
      runAndroidInit({ root: f.root, agent: true, json: true }, "app_test", dependencies),
    ).rejects.toThrow("No signing certificate fingerprint");
    expect(JSON.parse(captured.out)).toMatchObject({
      status: "input-required",
      identity: {
        flag: "--android-fingerprint",
        applicationId: "com.example.myapp",
        fingerprintSources: { debugKeystore: "no-keytool" },
      },
    });
    captured.clear();
    await runAndroidInit(
      { root: f.root, agent: true, json: true, androidFingerprint: [RELEASE_FINGERPRINT] },
      "app_test",
      dependencies,
    );
    expect(JSON.parse(captured.out).identity.fingerprints).toEqual([RELEASE_FINGERPRINT]);
  });

  test("several modules become a selection-required status for agents", async () => {
    const f = await fixture();
    await createAndroidFixture({}, f.root);
    await Bun.$`cp -R ${join(f.root, "app")} ${join(f.root, "tv")}`.quiet();
    await expect(
      runAndroidInit({ root: f.root, agent: true, json: true }, "app_test", f.dependencies),
    ).rejects.toThrow("--android-module");
    expect(JSON.parse(captured.out)).toMatchObject({
      status: "selection-required",
      choices: [{ module: "app" }, { module: "tv" }],
    });
    captured.clear();
    await runAndroidInit(
      { root: f.root, agent: true, json: true, androidModule: "tv" },
      "app_test",
      f.dependencies,
    );
    expect(JSON.parse(captured.out).handoff.context.module).toBe("tv");
  });

  test("a registration without this machine's fingerprint gets local setup and a manual remote side", async () => {
    const f = await fixture();
    f.state.registrations.push({
      object: "android_application",
      id: "androidapp_1",
      namespace: "android_app",
      package_name: "com.example.myapp",
      fingerprints: [RELEASE_FINGERPRINT],
    });
    await runAndroidInit({ root: f.root, agent: true, json: true }, "app_test", f.dependencies);
    const result = JSON.parse(captured.out);
    expect(result).toMatchObject({
      status: "manual-steps-required",
      local: "updated",
      remote: "manual",
    });
    expect(result.message).toContain("Native Applications page");
    expect(result.handoff.remaining.map((item: { id: string }) => item.id)).toContain(
      "native-registration",
    );
    captured.clear();
    spies.push(spyOn(spinner, "outro").mockResolvedValue(undefined));
    await runAndroidInit({ root: f.root, agent: false, yes: true }, "app_test", f.dependencies);
    expect(captured.err).toContain("Native Applications page");
    expect(captured.err).toContain(DEBUG_FINGERPRINT);
  });

  test("an incomplete registration fails the command after writing local setup", async () => {
    const f = await fixture();
    f.state.failEnable = true;
    await expect(
      runAndroidInit({ root: f.root, agent: true, json: true }, "app_test", f.dependencies),
    ).rejects.toThrow("native registration is incomplete");
    expect(JSON.parse(captured.out)).toMatchObject({
      status: "incomplete",
      local: "updated",
      remote: "incomplete",
    });
  });
});

describe("clerk init --sign-in-with-google", () => {
  const secretFile = async (root: string, contents: string) => {
    const path = join(root, "..", `google-secret-${Date.now()}.json`);
    await Bun.write(path, contents);
    roots.push(path);
    return path;
  };

  test("interactive setup asks, explains the Google Cloud steps, prompts for the Web client, and configures Clerk", async () => {
    const f = await fixture();
    const google = fakeGoogleAPI({ enabled: false });
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const select = spyOn(lists, "select").mockResolvedValue("core");
    const text = spyOn(prompts, "text").mockResolvedValue(FAKE_GOOGLE_CLIENT_ID);
    const password = spyOn(prompts, "password").mockResolvedValue(FAKE_GOOGLE_CLIENT_SECRET);
    spies.push(
      confirm,
      select,
      text,
      password,
      spyOn(spinner, "outro").mockResolvedValue(undefined),
    );
    await runAndroidInit({ root: f.root, agent: false }, "app_test", {
      ...f.dependencies,
      googleAPI: google.api,
    });
    expect(confirm.mock.calls.map((call) => call[0].message)).toEqual([
      "Enable native Sign in with Google?",
      "Apply this setup?",
    ]);
    expect(text).toHaveBeenCalledTimes(1);
    expect(password).toHaveBeenCalledTimes(1);
    expect(google.state.connection).toMatchObject({
      enabled: true,
      client_id: FAKE_GOOGLE_CLIENT_ID,
    });
    expect(captured.err).toContain("Sign in with Google needs a Google Web client");
    expect(captured.err).toContain(`SHA-1 certificate fingerprint ${DEBUG_SHA1}`);
    expect(captured.err).toContain("Google sign-in configured");
    expect(captured.err + captured.out).not.toContain(FAKE_GOOGLE_CLIENT_SECRET);
  });

  test("declining while Google is on without a Web client warns", async () => {
    const f = await fixture();
    const google = fakeGoogleAPI({ enabled: true });
    spies.push(
      spyOn(prompts, "confirm").mockImplementation(
        async ({ message }) => message === "Apply this setup?",
      ),
      spyOn(lists, "select").mockResolvedValue("core"),
      spyOn(spinner, "outro").mockResolvedValue(undefined),
    );
    await runAndroidInit({ root: f.root, agent: false }, "app_test", {
      ...f.dependencies,
      googleAPI: google.api,
    });
    expect(captured.err).toContain("Sign in with Google was declined");
    expect(google.state.events).toEqual([]);
  });

  test("an agent without the Web client gets an input-required status with the Google Cloud steps", async () => {
    const f = await fixture();
    const google = fakeGoogleAPI({ enabled: false });
    await expect(
      runAndroidInit(
        { root: f.root, agent: true, json: true, signInWithGoogle: true },
        "app_test",
        { ...f.dependencies, googleAPI: google.api },
      ),
    ).rejects.toThrow("--google-client-secret-file");
    const status = JSON.parse(captured.out);
    expect(status).toMatchObject({
      status: "input-required",
      google: {
        flag: "--google-client-secret-file",
        packageName: "com.example.myapp",
        debugSha1: DEBUG_SHA1,
        redirectUri: "https://fixture.clerk.accounts.dev/v1/oauth_callback",
        current: { enabled: false },
      },
    });
    expect(status.google.steps).toHaveLength(4);
    expect(f.state.events).toEqual([]);
  });

  test("an agent passes the Web client through a file and gets the handoff task", async () => {
    const f = await fixture();
    const google = fakeGoogleAPI({ enabled: false });
    const path = await secretFile(
      f.root,
      JSON.stringify({
        web: { client_id: FAKE_GOOGLE_CLIENT_ID, client_secret: FAKE_GOOGLE_CLIENT_SECRET },
      }),
    );
    await runAndroidInit(
      {
        root: f.root,
        agent: true,
        json: true,
        signInWithGoogle: true,
        googleClientSecretFile: path,
      },
      "app_test",
      { ...f.dependencies, googleAPI: google.api },
    );
    const result = JSON.parse(captured.out);
    expect(result).toMatchObject({ status: "requires-build-and-verification", google: "verified" });
    expect(result.handoff.tasks.map((task: { id: string }) => task.id)).toContain(
      "google-cloud-oauth-clients",
    );
    expect(captured.out).not.toContain(FAKE_GOOGLE_CLIENT_SECRET);
    expect(google.state.connection.client_id).toBe(FAKE_GOOGLE_CLIENT_ID);
  });

  test("a dry run defers Sign in with Google to a chosen application", async () => {
    const f = await fixture();
    await runAndroidInit(
      { root: f.root, agent: true, dryRun: true, json: true, signInWithGoogle: true },
      undefined,
      {
        ...f.dependencies,
        googleAPI: {
          fetchInstanceConfig: async () => {
            throw new Error("unexpected");
          },
        } as never,
      },
    );
    expect(JSON.parse(captured.out).google).toBe(
      "Requested; planned once a Clerk application is chosen",
    );
  });
});

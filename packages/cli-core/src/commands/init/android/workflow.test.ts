import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLERK_ANDROID_MINIMUM_VERSION } from "./sdk.ts";
import { IdentityRequired } from "./identity.ts";
import {
  applySetup,
  describePreview,
  GoogleCredentialsRequired,
  prepareSetup,
  type SetupOptions,
} from "./workflow.ts";
import {
  createAndroidFixture,
  DEBUG_FINGERPRINT,
  DEBUG_SHA1,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  FIXTURE_KEY,
  RELEASE_FINGERPRINT,
  fakeGoogleAPI,
  fakeNativeAPI,
  keystore,
} from "./test-helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(options: Parameters<typeof createAndroidFixture>[0] = {}) {
  const root = await createAndroidFixture(options);
  roots.push(root);
  await Bun.$`git -c commit.gpgsign=false init -q && git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm init`
    .cwd(root)
    .quiet();
  return root;
}
const setup = (root: string, extra: Partial<SetupOptions> = {}): SetupOptions => ({
  root,
  sdk: "core",
  minimumVersion: CLERK_ANDROID_MINIMUM_VERSION,
  remote: { applicationId: "app_test" },
  ...extra,
});
const read = (root: string, path: string) => readFile(join(root, path), "utf8");

describe("Android setup workflow", () => {
  test("sets up a plain project: local edits, registration, Native API, handoff", async () => {
    const root = await fixture({ minSdk: 23 });
    const { api, state } = fakeNativeAPI();
    const deps = { api, debugKeystore: keystore() };
    const preview = await prepareSetup(setup(root), deps);
    expect(preview.remote?.actions).toEqual(["register-application", "enable-native-api"]);
    expect(preview.identity?.fingerprints).toEqual([DEBUG_FINGERPRINT]);
    const described = describePreview(preview);
    expect(JSON.stringify(described)).not.toContain(FIXTURE_KEY);
    expect(described.remote).toMatchObject({
      packageName: "com.example.myapp",
      fingerprints: [DEBUG_FINGERPRINT],
    });
    const result = await applySetup(preview, deps);
    expect(result).toMatchObject({
      status: "requires-build-and-verification",
      local: "updated",
      remote: "verified",
      backups: [],
      identity: { applicationId: "com.example.myapp", fingerprints: [DEBUG_FINGERPRINT] },
    });
    expect(result.changedFiles).toEqual([
      "app/build.gradle.kts",
      "app/src/main/java/com/example/myapp/ClerkApplication.kt",
      "app/src/main/AndroidManifest.xml",
      "app/src/main/res/values/clerk.xml",
    ]);
    expect(await read(root, "app/src/main/res/values/clerk.xml")).toContain(FIXTURE_KEY);
    expect(await read(root, "app/build.gradle.kts")).toContain("minSdk = 24");
    expect(state.enabled).toBe(true);
    expect(state.registrations).toHaveLength(1);
    expect(result.handoff).toMatchObject({
      kind: "clerk-android-integration",
      status: "requires-build-and-verification",
      publishableKey: FIXTURE_KEY,
      completed: expect.arrayContaining([expect.objectContaining({ id: "initialize-clerk" })]),
    });
    expect(result.handoff.tasks.find((task) => task.id === "build-module")?.instructions).toContain(
      "./gradlew :app:assembleDebug",
    );
    expect(result.handoff.tasks.some((task) => task.id === "optional-sign-in-ui")).toBe(false);
    // Clean tracked files were backed up and the backups removed once git could restore them.
    expect(await readdir(root)).not.toContain(".clerk");
    // A rerun changes nothing and reports the same status.
    const again = await applySetup(await prepareSetup(setup(root), deps), deps);
    expect(again).toMatchObject({
      status: "requires-build-and-verification",
      local: "unchanged",
      remote: "verified",
      changedFiles: [],
    });
    expect(state.registrations).toHaveLength(1);
  });

  test("a registration that lacks this machine's fingerprint still gets local setup, with the remote side manual", async () => {
    const root = await fixture();
    const { api, state } = fakeNativeAPI();
    state.registrations.push({
      object: "android_application",
      id: "androidapp_1",
      namespace: "android_app",
      package_name: "com.example.myapp",
      fingerprints: [RELEASE_FINGERPRINT],
    });
    const deps = { api, debugKeystore: keystore() };
    const preview = await prepareSetup(setup(root), deps);
    expect(preview.remote?.blocker).toContain(DEBUG_FINGERPRINT);
    expect(preview.remote?.actions).toEqual(["enable-native-api"]);
    expect(describePreview(preview).remote).toMatchObject({
      blocker: expect.stringContaining("Native Applications page"),
    });
    const result = await applySetup(preview, deps);
    expect(result).toMatchObject({
      status: "manual-steps-required",
      local: "updated",
      remote: "manual",
    });
    expect(result.message).toContain("Native Applications page");
    expect(state.enabled).toBe(true);
    expect(state.registrations).toHaveLength(1);
    expect(
      result.handoff.remaining.find((item) => item.id === "native-registration")?.detail,
    ).toContain(DEBUG_FINGERPRINT);
    expect(await read(root, "app/src/main/res/values/clerk.xml")).toContain(FIXTURE_KEY);
  });

  test("the build task in the handoff follows settings.gradle", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "settings.gradle.kts"),
      'include(":phone")\nproject(":phone").projectDir = file("app")\n',
    );
    await Bun.$`git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm settings`
      .cwd(root)
      .quiet();
    const { api } = fakeNativeAPI();
    const deps = { api, debugKeystore: keystore() };
    const result = await applySetup(await prepareSetup(setup(root), deps), deps);
    expect(result.handoff.tasks.find((task) => task.id === "build-module")?.instructions).toContain(
      "./gradlew :phone:assembleDebug",
    );
    expect(result.handoff.context).toMatchObject({ module: "app", gradlePath: ":phone" });
  });

  test("a registration conflict in the preview is dropped from the stale check", async () => {
    const root = await fixture();
    const { api, state } = fakeNativeAPI();
    state.registrations.push({
      object: "android_application",
      id: "androidapp_1",
      namespace: "android_app",
      package_name: "com.example.myapp",
      fingerprints: [RELEASE_FINGERPRINT],
    });
    const deps = { api, debugKeystore: keystore() };
    const preview = await prepareSetup(setup(root), deps);
    // The Dashboard added the fingerprint between preview and apply: registration is verified.
    state.registrations[0]!.fingerprints.push(DEBUG_FINGERPRINT);
    expect((await applySetup(preview, deps)).remote).toBe("verified");
  });

  test("asks for a fingerprint when none is known and nothing is registered", async () => {
    const root = await fixture();
    const { api } = fakeNativeAPI();
    await expect(
      prepareSetup(setup(root), { api, debugKeystore: keystore("no-keytool") }),
    ).rejects.toBeInstanceOf(IdentityRequired);
    // An explicit fingerprint is enough.
    const preview = await prepareSetup(setup(root, { fingerprints: ["ab".repeat(32)] }), {
      api,
      debugKeystore: keystore("no-keytool"),
    });
    expect(preview.identity?.fingerprints).toEqual([DEBUG_FINGERPRINT]);
    expect(
      preview.local.postInstructions.some((line) => line.includes("keytool was not found")),
    ).toBe(true);
  });

  test("an existing registration is reused without a known fingerprint, with a warning", async () => {
    const root = await fixture();
    const { api, state } = fakeNativeAPI();
    state.enabled = true;
    state.registrations.push({
      object: "android_application",
      id: "androidapp_1",
      namespace: "android_app",
      package_name: "com.example.myapp",
      fingerprints: [RELEASE_FINGERPRINT],
    });
    const preview = await prepareSetup(setup(root), {
      api,
      debugKeystore: keystore("no-keystore"),
    });
    expect(preview.remote?.actions).toEqual([]);
    const result = await applySetup(preview, { api });
    expect(result.status).toBe("manual-steps-required");
    expect(result.handoff.remaining.map((item) => item.id)).toContain("debug-fingerprint");
  });

  test("a dry run never touches the API or keytool", async () => {
    const root = await fixture();
    const preview = await prepareSetup(setup(root, { remote: undefined, inspectOnly: true }), {
      api: {
        fetchApplication: async () => {
          throw new Error("no");
        },
      } as never,
      debugKeystore: async () => {
        throw new Error("no keytool");
      },
    });
    expect(preview.remote).toBeUndefined();
    expect(preview.identity).toBeUndefined();
    expect(describePreview(preview).remote).toBe("Manual Dashboard setup");
  });

  test("refuses a stale project before writing", async () => {
    const root = await fixture();
    const { api } = fakeNativeAPI();
    const deps = { api, debugKeystore: keystore() };
    const preview = await prepareSetup(setup(root), deps);
    await writeFile(join(root, "app/build.gradle.kts"), "// changed\n");
    await expect(applySetup(preview, deps)).rejects.toThrow("changed after its preview");
    expect(await Bun.file(join(root, "app/src/main/res/values/clerk.xml")).exists()).toBe(false);
  });

  test("rolls back earlier edits when a later write fails, and attempts no remote change", async () => {
    const root = await fixture();
    const { api, state } = fakeNativeAPI();
    const deps = { api, debugKeystore: keystore() };
    const preview = await prepareSetup(setup(root), deps);
    const manifest = await read(root, "app/src/main/AndroidManifest.xml");
    const build = await read(root, "app/build.gradle.kts");
    // The key resource's folder can't be written to, so the last create fails.
    await mkdir(join(root, "app/src/main/res/values"), { recursive: true });
    await chmod(join(root, "app/src/main/res/values"), 0o555);
    let result: Awaited<ReturnType<typeof applySetup>>;
    try {
      result = await applySetup(preview, deps);
    } finally {
      await chmod(join(root, "app/src/main/res/values"), 0o755);
    }
    expect(result.status).toBe("incomplete");
    expect(result.local).toBe("incomplete");
    expect(result.message).toContain("No remote changes were attempted");
    expect(await read(root, "app/build.gradle.kts")).toBe(build);
    expect(await read(root, "app/src/main/AndroidManifest.xml")).toBe(manifest);
    expect(
      await Bun.file(
        join(root, "app/src/main/java/com/example/myapp/ClerkApplication.kt"),
      ).exists(),
    ).toBe(false);
    expect(state.events).toEqual([]);
  });

  test("keeps backups for files git can't restore", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "app/build.gradle.kts"),
      `${await read(root, "app/build.gradle.kts")}// local edit\n`,
    );
    const { api } = fakeNativeAPI();
    const deps = { api, debugKeystore: keystore() };
    const preview = await prepareSetup(setup(root), deps);
    expect(preview.dirtyFiles).toEqual(["app/build.gradle.kts"]);
    const result = await applySetup(preview, deps);
    expect(result.backups).toHaveLength(1);
    expect(result.backups[0]).toStartWith(".clerk/backups/app--build.gradle.kts.clerk-backup-");
    expect(await read(root, result.backups[0]!)).toContain("// local edit");
  });

  test("keeps local edits and reports an incomplete registration when Clerk fails", async () => {
    const root = await fixture();
    const { api, state } = fakeNativeAPI();
    state.failEnable = true;
    const deps = { api, debugKeystore: keystore() };
    const result = await applySetup(await prepareSetup(setup(root), deps), deps);
    expect(result).toMatchObject({ status: "incomplete", local: "updated", remote: "incomplete" });
    expect(result.message).toContain("rerun setup with the same application");
    expect(await Bun.file(join(root, "app/src/main/res/values/clerk.xml")).exists()).toBe(true);
    // The rerun reconciles: the registration exists, only Native API is left.
    state.failEnable = false;
    const again = await prepareSetup(setup(root), deps);
    expect(again.remote?.actions).toEqual(["enable-native-api"]);
    expect((await applySetup(again, deps)).remote).toBe("verified");
  });

  test("refuses a Kotlin compiler the SDK can't be consumed by", async () => {
    const root = await fixture({ kotlin: "2.2.21" });
    const { api } = fakeNativeAPI();
    await expect(prepareSetup(setup(root), { api, debugKeystore: keystore() })).rejects.toThrow(
      "Kotlin 2.2.21",
    );
    const preview = await prepareSetup(setup(root, { remote: undefined, inspectOnly: true }), {
      api,
    });
    expect(preview.kotlinCheck.status).toBe("fail");
  });

  test("an SDK below the baseline is reported, not replaced", async () => {
    const root = await fixture({ clerk: { product: "core", version: "1.1.7" } });
    const { api } = fakeNativeAPI();
    const deps = { api, debugKeystore: keystore() };
    const preview = await prepareSetup(setup(root), deps);
    expect(preview.sdk).toMatchObject({
      type: "skip",
      skipReason: expect.stringContaining("below the 1.3.0 baseline"),
    });
    const result = await applySetup(preview, deps);
    expect(result.status).toBe("manual-steps-required");
    expect(result.handoff.remaining.map((item) => item.id)).toContain("sdk-version");
    expect(await read(root, "app/build.gradle.kts")).toContain("clerk-android-api:1.1.7");
  });

  test("an SDK below the baseline still gets its minSdk raised, and no orphan catalog entries", async () => {
    const root = await fixture({
      catalog: true,
      minSdk: 21,
      clerk: { product: "core", version: "1.1.7" },
    });
    const catalog = await read(root, "gradle/libs.versions.toml");
    const { api } = fakeNativeAPI();
    const deps = { api, debugKeystore: keystore() };
    const preview = await prepareSetup(setup(root), deps);
    expect(preview.sdk).toMatchObject({
      type: "modify",
      description: "Raise minSdk from 21 to 24",
    });
    const result = await applySetup(preview, deps);
    expect(result.changedFiles).not.toContain("gradle/libs.versions.toml");
    expect(await read(root, "gradle/libs.versions.toml")).toBe(catalog);
    expect(await read(root, "app/build.gradle.kts")).toContain("minSdk = 24");
    expect(result.handoff.remaining.map((item) => item.id)).toContain("sdk-version");
  });

  test("the UI artifact adds the sign-in UI task behind user intent", async () => {
    const root = await fixture({ catalog: true });
    const { api } = fakeNativeAPI();
    const deps = { api, debugKeystore: keystore() };
    const result = await applySetup(await prepareSetup(setup(root, { sdk: "ui" }), deps), deps);
    expect(result.changedFiles[0]).toBe("gradle/libs.versions.toml");
    expect(await read(root, "app/build.gradle.kts")).toContain(
      "implementation(libs.clerk.android.ui)",
    );
    expect(result.handoff.tasks.find((task) => task.id === "optional-sign-in-ui")).toMatchObject({
      status: "requires-user-intent",
      requiresUserIntent: true,
    });
  });
});

describe("native Sign in with Google", () => {
  const googleCredentials = {
    clientId: FAKE_GOOGLE_CLIENT_ID,
    clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
  };

  test("enables Google with the Web client after registration, and reports the Google Cloud steps", async () => {
    const root = await fixture();
    const { api, state } = fakeNativeAPI();
    const google = fakeGoogleAPI({ enabled: false });
    const deps = { api, googleAPI: google.api, debugKeystore: keystore() };
    const preview = await prepareSetup(
      setup(root, { signInWithGoogle: true, googleCredentials }),
      deps,
    );
    expect(preview.google).toMatchObject({ status: "ready", credentials: "required" });
    expect(preview.googleCloudSteps?.join(" ")).toContain(DEBUG_SHA1);
    const described = JSON.stringify(describePreview(preview));
    expect(described).not.toContain(FAKE_GOOGLE_CLIENT_SECRET);
    expect(described).toContain("googleCloudSteps");
    const result = await applySetup(preview, deps);
    expect(result).toMatchObject({
      status: "requires-build-and-verification",
      remote: "verified",
      google: "verified",
    });
    expect(google.state.connection).toMatchObject({
      enabled: true,
      authenticatable: true,
      client_id: FAKE_GOOGLE_CLIENT_ID,
    });
    expect(state.events).toEqual(["register", "enable-native"]);
    expect(google.state.events).toEqual(["google-dry-run", "google-apply"]);
    expect(result.handoff.completed.map((item) => item.id)).toContain("native-google");
    expect(
      result.handoff.tasks.find((task) => task.id === "google-cloud-oauth-clients"),
    ).toMatchObject({ status: "requires-user-action" });
    expect(JSON.stringify(result)).not.toContain(FAKE_GOOGLE_CLIENT_SECRET);
  });

  test("asks for the Web client when the connection has none and nothing was passed", async () => {
    const root = await fixture();
    const { api } = fakeNativeAPI();
    const google = fakeGoogleAPI({ enabled: true, client_id: "" });
    const deps = { api, googleAPI: google.api, debugKeystore: keystore() };
    const error = await prepareSetup(setup(root, { signInWithGoogle: true }), deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GoogleCredentialsRequired);
    expect((error as GoogleCredentialsRequired).steps.join(" ")).toContain("com.example.myapp");
    expect((error as GoogleCredentialsRequired).frontendHost).toBe("fixture.clerk.accounts.dev");
  });

  test("keeps an existing Web client and only enables the connection", async () => {
    const root = await fixture();
    const { api } = fakeNativeAPI();
    const google = fakeGoogleAPI({
      enabled: false,
      client_id: FAKE_GOOGLE_CLIENT_ID,
      client_secret: "KEEP",
    });
    const deps = { api, googleAPI: google.api, debugKeystore: keystore() };
    const preview = await prepareSetup(setup(root, { signInWithGoogle: true }), deps);
    expect(preview.google?.credentials).toBe("satisfied");
    expect((await applySetup(preview, deps)).google).toBe("verified");
    expect(google.state.patches).toEqual([{ enabled: true, authenticatable: true }]);
  });

  test("a satisfied connection is reported and left alone", async () => {
    const root = await fixture();
    const { api } = fakeNativeAPI();
    const google = fakeGoogleAPI({ enabled: true, client_id: FAKE_GOOGLE_CLIENT_ID });
    const deps = { api, googleAPI: google.api, debugKeystore: keystore() };
    const result = await applySetup(
      await prepareSetup(setup(root, { signInWithGoogle: true }), deps),
      deps,
    );
    expect(result.google).toBe("verified");
    expect(google.state.events).toEqual([]);
  });

  test("warns when Google is on without a Web client and wasn't requested", async () => {
    const root = await fixture();
    const { api } = fakeNativeAPI();
    const google = fakeGoogleAPI({ enabled: true });
    const deps = { api, googleAPI: google.api, debugKeystore: keystore() };
    const preview = await prepareSetup(
      setup(root, { checkGoogleConnection: true, signInWithGoogle: false }),
      deps,
    );
    expect(preview.google).toBeUndefined();
    expect(preview.googleWarning).toContain("declined");
    const result = await applySetup(preview, deps);
    expect(result.status).toBe("manual-steps-required");
    expect(result.handoff.remaining.map((item) => item.id)).toContain("google-provider-review");
    expect(google.state.events).toEqual([]);
    const silent = await prepareSetup(setup(root, { checkGoogleConnection: true }), {
      api,
      googleAPI: fakeGoogleAPI({ enabled: false }).api,
      debugKeystore: keystore(),
    });
    expect(silent.googleWarning).toBeUndefined();
  });

  test("a blocked connection stops before any write", async () => {
    const root = await fixture();
    const { api, state } = fakeNativeAPI();
    const google = fakeGoogleAPI({ enabled: true, authenticatable: false });
    await expect(
      prepareSetup(setup(root, { signInWithGoogle: true, googleCredentials }), {
        api,
        googleAPI: google.api,
        debugKeystore: keystore(),
      }),
    ).rejects.toThrow("needs review in Clerk");
    expect(state.events).toEqual([]);
    expect(await Bun.file(join(root, "app/src/main/res/values/clerk.xml")).exists()).toBe(false);
  });

  test("a failed Google write leaves registration verified and reports the Google step", async () => {
    const root = await fixture();
    const { api } = fakeNativeAPI();
    const google = fakeGoogleAPI({ enabled: false });
    google.state.failPatch = true;
    const deps = { api, googleAPI: google.api, debugKeystore: keystore() };
    const result = await applySetup(
      await prepareSetup(setup(root, { signInWithGoogle: true, googleCredentials }), deps),
      deps,
    );
    expect(result).toMatchObject({
      status: "incomplete",
      remote: "verified",
      google: "incomplete",
    });
    expect(result.message).toContain("Sign in with Google was not configured");
  });

  test("a connection changed after the preview is not written", async () => {
    const root = await fixture();
    const { api } = fakeNativeAPI();
    const google = fakeGoogleAPI({ enabled: false });
    const deps = { api, googleAPI: google.api, debugKeystore: keystore() };
    const preview = await prepareSetup(
      setup(root, { signInWithGoogle: true, googleCredentials }),
      deps,
    );
    google.state.connection = { enabled: false, authenticatable: false };
    const result = await applySetup(preview, deps);
    expect(result.google).toBe("incomplete");
    expect(result.message).toContain("changed after the preview");
    expect(google.state.events).toEqual([]);
  });

  test("Sign in with Google needs a chosen application", async () => {
    const root = await fixture();
    await expect(
      prepareSetup(setup(root, { remote: undefined, signInWithGoogle: true }), {}),
    ).rejects.toThrow("explicitly selected Clerk application");
  });
});

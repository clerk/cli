import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLERK_ANDROID_MINIMUM_VERSION } from "./sdk.ts";
import { inspectAndroidProject } from "./project.ts";
import { planAndroidSetup } from "./plan.ts";
import { createAndroidFixture, FIXTURE_KEY } from "./test-helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function plan(
  options: Parameters<typeof createAndroidFixture>[0] = {},
  key: string | null = FIXTURE_KEY,
  sdk: "core" | "ui" = "core",
) {
  const root = await createAndroidFixture(options);
  roots.push(root);
  const inspection = await inspectAndroidProject({
    root,
    sdk,
    minimumVersion: CLERK_ANDROID_MINIMUM_VERSION,
  });
  return { root, inspection, plan: planAndroidSetup(inspection, key ?? undefined) };
}
const content = (actions: ReturnType<typeof planAndroidSetup>["actions"], path: string) => {
  const action = actions.find((item) => item.path === path);
  return action && action.type !== "skip" ? action.content : undefined;
};

describe("Android setup plan", () => {
  test("plans the SDK, a generated Application, the manifest, and the key resource", async () => {
    const { plan: result } = await plan({ minSdk: 23 });
    expect(result.actions.map((action) => [action.type, action.path])).toEqual([
      ["modify", "app/build.gradle.kts"],
      ["create", "app/src/main/java/com/example/myapp/ClerkApplication.kt"],
      ["modify", "app/src/main/AndroidManifest.xml"],
      ["create", "app/src/main/res/values/clerk.xml"],
    ]);
    const build = content(result.actions, "app/build.gradle.kts")!;
    expect(build).toContain("minSdk = 24");
    expect(build).toContain('implementation("com.clerk:clerk-android-api:1.3.0")');
    expect(result.sdk).toMatchObject({
      description: "Raise minSdk from 23 to 24; add com.clerk:clerk-android-api:1.3.0",
    });
    const application = content(
      result.actions,
      "app/src/main/java/com/example/myapp/ClerkApplication.kt",
    )!;
    expect(application).toContain("package com.example.myapp\n");
    expect(application).toContain(
      "Clerk.initialize(this, publishableKey = getString(R.string.clerk_publishable_key))",
    );
    const manifest = content(result.actions, "app/src/main/AndroidManifest.xml")!;
    expect(manifest).toContain('<application android:name=".ClerkApplication"');
    expect(manifest).toContain('<uses-permission android:name="android.permission.INTERNET" />');
    expect(manifest).toContain('<!-- android:name=".Commented" -->');
    expect(content(result.actions, "app/src/main/res/values/clerk.xml")).toContain(
      `translatable="false">${FIXTURE_KEY}<`,
    );
    expect(result.initializes).toBe(true);
  });

  test("a dry run leaves the key resource for later", async () => {
    const { plan: result } = await plan({}, null);
    expect(result.actions.at(-1)).toMatchObject({
      type: "skip",
      skipReason: expect.stringContaining("once a Clerk application is chosen"),
    });
  });

  test("a rerun plans nothing", async () => {
    const { root, plan: first } = await plan();
    for (const action of first.actions)
      if (action.type !== "skip")
        await writeFile(join(root, action.path), action.content).catch(async () => {
          await Bun.write(join(root, action.path), action.content);
        });
    const inspection = await inspectAndroidProject({
      root,
      sdk: "core",
      minimumVersion: CLERK_ANDROID_MINIMUM_VERSION,
    });
    const rerun = planAndroidSetup(inspection, FIXTURE_KEY);
    expect(rerun.actions.every((action) => action.type === "skip")).toBe(true);
    expect(rerun.sdk).toMatchObject({ skipReason: expect.stringContaining("already declared") });
    expect(rerun.initializes).toBe(true);
  });

  test("edits a custom Application after super.onCreate() and keeps its startup work", async () => {
    const { plan: result } = await plan({ application: "custom", internetPermission: true });
    const source = content(result.actions, "app/src/main/java/com/example/myapp/CustomApp.kt")!;
    expect(source).toContain(
      "super.onCreate() // keep\n        com.clerk.api.Clerk.initialize(this, publishableKey = getString(com.example.myapp.R.string.clerk_publishable_key))\n        startExistingService()",
    );
    expect(
      result.actions.find((action) => action.path.endsWith("AndroidManifest.xml")),
    ).toMatchObject({ type: "skip" });
  });

  test("preserves an Application that initializes Clerk with its own key", async () => {
    const { plan: result } = await plan({ application: "custom-initialized" });
    expect(result.actions.find((action) => action.path.endsWith("CustomApp.kt"))).toMatchObject({
      type: "skip",
      skipReason: expect.stringContaining("its own key"),
    });
    expect(result.actions.find((action) => action.path.endsWith("clerk.xml"))).toMatchObject({
      type: "skip",
      skipReason: expect.stringContaining("Not written"),
    });
    expect(result.initializes).toBe(true);
  });

  test("leaves an uneditable Application to the handoff but still writes the rest", async () => {
    const { plan: result } = await plan({ application: "unsupported" });
    expect(result.initializes).toBe(false);
    expect(result.actions.find((action) => action.path.endsWith("CustomApp.kt"))).toMatchObject({
      type: "skip",
    });
    expect(content(result.actions, "app/src/main/res/values/clerk.xml")).toBeDefined();
    expect(
      result.postInstructions.some((line) =>
        line.includes("Initialize Clerk in com.example.myapp.CustomApp"),
      ),
    ).toBe(true);
  });

  test("uses the version catalog and the UI artifact when asked", async () => {
    const { plan: result } = await plan({ catalog: true }, FIXTURE_KEY, "ui");
    expect(result.actions[0]).toMatchObject({ type: "modify", path: "gradle/libs.versions.toml" });
    expect(content(result.actions, "gradle/libs.versions.toml")).toContain('clerk = "1.3.0"');
    expect(content(result.actions, "app/build.gradle.kts")).toContain(
      "implementation(libs.clerk.android.ui)",
    );
  });

  test("replaces a catalog minSdk reference with the literal floor", async () => {
    const { plan: result } = await plan({ catalog: true, minSdk: "catalog" });
    expect(content(result.actions, "app/build.gradle.kts")).toContain("minSdk = 24");
    expect(content(result.actions, "gradle/libs.versions.toml")).toContain('minSdk = "23"');
  });

  test("supports Groovy scripts", async () => {
    const { plan: result } = await plan({ groovy: true, minSdk: 21 });
    const build = content(result.actions, "app/build.gradle")!;
    expect(build).toContain("minSdk 24");
    expect(build).toContain('implementation("com.clerk:clerk-android-api:1.3.0")');
  });

  test("rewrites a managed key resource with a new key", async () => {
    const { plan: result } = await plan({ keyResource: "pk_test_old" });
    expect(result.actions.find((action) => action.path.endsWith("clerk.xml"))).toMatchObject({
      type: "modify",
    });
  });

  test("refuses anything but a development key", async () => {
    const { inspection } = await plan();
    for (const bad of ["sk_test_secret", "pk_live_prod", "pk_test_<bad>"])
      expect(() => planAndroidSetup(inspection, bad)).toThrow("development publishable key");
  });
});

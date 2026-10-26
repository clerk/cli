import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLERK_ANDROID_MINIMUM_VERSION } from "./sdk.ts";
import { SelectionNeeded, findApplicationModules } from "./discovery.ts";
import { inspectAndroidProject } from "./project.ts";
import { createAndroidFixture, FIXTURE_KEY } from "./test-helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(options: Parameters<typeof createAndroidFixture>[0] = {}) {
  const root = await createAndroidFixture(options);
  roots.push(root);
  return root;
}
const inspect = (root: string, extra: Partial<Parameters<typeof inspectAndroidProject>[0]> = {}) =>
  inspectAndroidProject({
    root,
    sdk: "core",
    minimumVersion: CLERK_ANDROID_MINIMUM_VERSION,
    ...extra,
  });

describe("Android project inspection", () => {
  test("reads the module, identity, toolchain, and manifest", async () => {
    const root = await fixture({ catalog: true });
    const inspection = await inspect(root);
    expect(inspection.selection).toEqual({
      root,
      module: "app",
      namespace: "com.example.myapp",
      applicationId: "com.example.myapp",
      applicationIdSource: "gradle",
    });
    expect(inspection.minSdk).toMatchObject({ value: 24, source: "literal" });
    expect(inspection.kotlin).toMatchObject({ version: "2.3.21", applied: true });
    expect(inspection.agp.version).toBe("9.2.1");
    expect(inspection.internetPermission).toBe(false);
    expect(inspection.application).toMatchObject({
      className: "com.example.myapp.ClerkApplication",
      registered: false,
      initialized: "none",
      editable: true,
      path: "app/src/main/java/com/example/myapp/ClerkApplication.kt",
    });
    expect(inspection.dependencies).toEqual([]);
  });

  test("reads a literal Kotlin plugin version and Groovy scripts", async () => {
    const root = await fixture({ groovy: true, kotlin: "2.4.0", minSdk: 21 });
    const inspection = await inspect(root);
    expect(inspection.build.path).toBe("app/build.gradle");
    expect(inspection.kotlin).toMatchObject({
      version: "2.4.0",
      source: "plugin version in app/build.gradle",
    });
    expect(inspection.minSdk.value).toBe(21);
  });

  test("uses the debug applicationIdSuffix for the development identity", async () => {
    const root = await fixture({ debugSuffix: ".debug" });
    const inspection = await inspect(root);
    expect(inspection.selection.applicationId).toBe("com.example.myapp.debug");
    expect(inspection.selection.applicationIdSource).toBe("gradle-debug");
  });

  test("refuses a computed applicationId unless --android-package names it", async () => {
    const root = await fixture({ applicationId: false });
    await expect(inspect(root)).rejects.toThrow("--android-package");
    expect((await inspect(root, { applicationId: "com.example.final" })).selection).toMatchObject({
      applicationId: "com.example.final",
      applicationIdSource: "explicit",
    });
    await expect(inspect(root, { applicationId: "not a package" })).rejects.toThrow(
      "--android-package must be",
    );
  });

  test("refuses flavors and suffixes outside the debug build type", async () => {
    const root = await fixture();
    const path = join(root, "app/build.gradle.kts");
    const source = await Bun.file(path).text();
    await writeFile(
      path,
      source.replace("android {", 'android {\n    productFlavors { create("free") {} }'),
    );
    await expect(inspect(root)).rejects.toThrow("product flavors");
    await writeFile(
      path,
      source.replace(
        "android {",
        'android {\n    buildTypes { release { applicationIdSuffix = ".r" } }',
      ),
    );
    await expect(inspect(root)).rejects.toThrow("outside the debug build type");
  });

  test("does not mistake comments for configuration", async () => {
    const root = await fixture();
    const path = join(root, "app/build.gradle.kts");
    await writeFile(
      path,
      `// applicationIdSuffix = ".fake"\n// namespace = "com.bad"\n${await Bun.file(path).text()}`,
    );
    expect((await inspect(root)).selection.applicationId).toBe("com.example.myapp");
  });

  test("requires a literal namespace", async () => {
    const root = await fixture();
    const path = join(root, "app/build.gradle.kts");
    await writeFile(
      path,
      (await Bun.file(path).text()).replace(
        'namespace = "com.example.myapp"',
        "namespace = project.name",
      ),
    );
    await expect(inspect(root)).rejects.toThrow("android.namespace");
  });

  test("AGP 9's built-in Kotlin counts as its bundled 2.2.10 when no plugin declares a version", async () => {
    const root = await fixture({ catalog: true, kotlin: false });
    expect((await inspect(root)).kotlin).toEqual({
      version: "2.2.10",
      source: "AGP 9.2.1's built-in Kotlin",
      applied: true,
    });
  });

  test("reads minSdk from the version catalog", async () => {
    const root = await fixture({ catalog: true, minSdk: "catalog" });
    expect((await inspect(root)).minSdk).toMatchObject({ value: 23, source: "catalog" });
  });

  test("finds modules by their application plugin and asks when there are several", async () => {
    const root = await fixture({ catalog: true });
    await createAndroidFixture({ catalog: true }, root);
    await mkdir(join(root, "wear/src/main"), { recursive: true });
    await writeFile(
      join(root, "wear/src/main/AndroidManifest.xml"),
      await Bun.file(join(root, "app/src/main/AndroidManifest.xml")).text(),
    );
    await writeFile(
      join(root, "wear/build.gradle.kts"),
      await Bun.file(join(root, "app/build.gradle.kts")).text(),
    );
    await mkdir(join(root, "lib/src/main"), { recursive: true });
    await writeFile(join(root, "lib/src/main/AndroidManifest.xml"), "<manifest />");
    await writeFile(join(root, "lib/build.gradle.kts"), 'plugins { id("com.android.library") }');
    expect((await findApplicationModules(root)).map((item) => item.module)).toEqual([
      "app",
      "wear",
    ]);
    await expect(inspect(root)).rejects.toBeInstanceOf(SelectionNeeded);
    expect((await inspect(root, { module: "wear" })).selection.module).toBe("wear");
    expect(
      (await inspect(root, { chooseModule: async (choices) => choices[1]! })).selection.module,
    ).toBe("wear");
    await expect(inspect(root, { module: "lib" })).rejects.toThrow("com.android.application");
  });

  test("supports a root module", async () => {
    const root = await fixture({ rootModule: true });
    const inspection = await inspect(root);
    expect(inspection.selection.module).toBe(".");
    expect(inspection.build.path).toBe("build.gradle.kts");
    expect(inspection.application.path).toBe("src/main/java/com/example/myapp/ClerkApplication.kt");
  });

  test("refuses symlinked modules and paths outside the root", async () => {
    const root = await fixture();
    await symlink(join(root, "app"), join(root, "linked"));
    await expect(inspect(root, { module: "linked" })).rejects.toThrow("Symbolic links");
    await expect(inspect(root, { module: "../outside" })).rejects.toThrow("outside");
  });

  test("recognizes a custom Application it can edit", async () => {
    const root = await fixture({ application: "custom", internetPermission: true });
    const inspection = await inspect(root);
    expect(inspection.application).toMatchObject({
      className: "com.example.myapp.CustomApp",
      registered: true,
      initialized: "none",
      editable: true,
      path: "app/src/main/java/com/example/myapp/CustomApp.kt",
    });
    expect(inspection.internetPermission).toBe(true);
  });

  test("recognizes an Application that already initializes Clerk with its own key", async () => {
    const root = await fixture({ application: "custom-initialized" });
    expect((await inspect(root)).application).toMatchObject({
      initialized: "custom",
      editable: false,
    });
  });

  test("leaves an Application it can't edit safely to the handoff", async () => {
    const root = await fixture({ application: "unsupported" });
    expect((await inspect(root)).application).toMatchObject({
      editable: false,
      reason: expect.stringContaining("one onCreate override"),
    });
    const java = await fixture({ application: "java" });
    expect((await inspect(java)).application).toMatchObject({
      editable: false,
      reason: expect.stringContaining("Java class"),
    });
  });

  test("reports a registered Application whose source is missing", async () => {
    const root = await fixture({ application: "custom" });
    await rm(join(root, "app/src/main/java/com/example/myapp/CustomApp.kt"));
    expect((await inspect(root)).application).toMatchObject({
      editable: false,
      reason: expect.stringContaining("was not found"),
    });
  });

  test("refuses an unregistered class with the generated name that it didn't write", async () => {
    const root = await fixture();
    await mkdir(join(root, "app/src/main/java/com/example/myapp"), { recursive: true });
    await writeFile(
      join(root, "app/src/main/java/com/example/myapp/ClerkApplication.kt"),
      "package com.example.myapp\nclass ClerkApplication",
    );
    await expect(inspect(root)).rejects.toThrow("doesn't register it");
  });

  test("reads a managed key resource and refuses foreign ones", async () => {
    const root = await fixture({ keyResource: FIXTURE_KEY });
    expect((await inspect(root)).keyResource).toMatchObject({ managed: true, key: FIXTURE_KEY });
    await writeFile(join(root, "app/src/main/res/values/clerk.xml"), "<resources />");
    await expect(inspect(root)).rejects.toThrow("wasn't written by clerk init");
    await rm(join(root, "app/src/main/res/values/clerk.xml"));
    await mkdir(join(root, "app/src/debug/res/values"), { recursive: true });
    await writeFile(
      join(root, "app/src/debug/res/values/strings.xml"),
      '<resources><string name="clerk_publishable_key">old</string></resources>',
    );
    await expect(inspect(root)).rejects.toThrow("already defines a clerk_publishable_key");
  });

  test("finds declared SDK dependencies", async () => {
    const literal = await fixture({ clerk: { product: "ui", version: "1.3.0" } });
    expect((await inspect(literal)).dependencies).toEqual([
      { product: "ui", version: "1.3.0", via: "literal" },
    ]);
    const catalog = await fixture({ catalog: true, clerk: { product: "core", version: "1.2.0" } });
    expect((await inspect(catalog)).dependencies).toEqual([
      { product: "core", version: "1.2.0", via: "catalog", alias: "clerk-android-api" },
    ]);
  });

  test("requires a standard manifest", async () => {
    const root = await fixture();
    const path = join(root, "app/src/main/AndroidManifest.xml");
    await writeFile(
      path,
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /><application /></manifest>',
    );
    await expect(inspect(root)).rejects.toThrow("exactly one application element");
    await writeFile(path, "<!DOCTYPE x><manifest />");
    await expect(inspect(root)).rejects.toThrow("DOCTYPE");
  });
});

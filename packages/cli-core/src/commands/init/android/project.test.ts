import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAndroidProject,
  inspectAndroidProject,
  normalizeFingerprints,
  withPublishableKey,
} from "./project.ts";

let root: string;
const build = `plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") version "2.4.20" }
android {
    namespace = "com.example.code"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.example.installed"
        minSdk = 23
    }
}
dependencies {
    implementation("example:existing:1.0")
}
`;
const manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Example"><activity android:name=".MainActivity" /></application></manifest>`;
const key = "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk";
const sourcePath = "app/src/main/kotlin/com/example/code/ClerkApplication.kt";
const write = async (path: string, value: string) => {
  await Bun.write(join(root, path), value);
};
const read = async (path: string) => Bun.file(join(root, path)).text();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clerk-android-project-"));
  await write("app/build.gradle.kts", build);
  await write("app/src/main/AndroidManifest.xml", manifest);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Android project setup", () => {
  test("plans and applies Kotlin, Gradle and manifest setup using applicationId instead of namespace", async () => {
    const plan = await inspectAndroidProject(root);
    expect(plan.packageName).toBe("com.example.installed");
    expect(await read("app/build.gradle.kts")).toBe(build);
    expect(plan.plan.actions).toHaveLength(4);
    await applyAndroidProject(withPublishableKey(plan, key));
    expect(await read("app/build.gradle.kts")).toContain(
      'implementation("com.clerk:clerk-android-api:1.1.7")',
    );
    expect(await read("app/build.gradle.kts")).toContain("minSdk = 24");
    expect(await read("app/build.gradle.kts")).toContain("example:existing:1.0");
    expect(await read(sourcePath)).toContain(
      "getString(com.example.code.R.string.clerk_publishable_key)",
    );
    expect(await read("app/src/main/AndroidManifest.xml")).toContain(
      'android:name="com.example.code.ClerkApplication"',
    );
    expect(await read("app/src/main/AndroidManifest.xml")).toContain("android.permission.INTERNET");
    expect(await read("app/src/main/res/values/clerk.xml")).toContain(key);
    expect(await Bun.file(join(root, ".env")).exists()).toBe(false);
  });

  test("rerunning with the same key makes no file changes", async () => {
    await applyAndroidProject(withPublishableKey(await inspectAndroidProject(root), key));
    const rerun = withPublishableKey(await inspectAndroidProject(root), key);
    expect(rerun.plan.actions).toEqual([]);
  });

  test("supports Groovy build scripts", async () => {
    await rm(join(root, "app/build.gradle.kts"));
    await write("app/build.gradle", build.replace(/ = /g, " ").replaceAll('"', "'"));
    await applyAndroidProject(withPublishableKey(await inspectAndroidProject(root), key));
    expect(await read("app/build.gradle")).toContain("minSdk 24");
  });

  test("preserves a custom Kotlin Application and its startup work", async () => {
    await write(
      "app/src/main/AndroidManifest.xml",
      manifest.replace("<application", '<application android:name=".CustomApp"'),
    );
    const path = "app/src/main/java/com/example/code/CustomApp.kt";
    await write(
      path,
      `package com.example.code\nclass CustomApp : android.app.Application() {\n override fun onCreate() {\n super.onCreate()\n startExistingService()\n }\n}`,
    );
    await applyAndroidProject(withPublishableKey(await inspectAndroidProject(root), key));
    expect(await read(path)).toContain("startExistingService()");
    expect(await read(path)).toContain("com.clerk.api.Clerk.initialize(this");
    expect(await Bun.file(join(root, sourcePath)).exists()).toBe(false);
  });

  test("requires an explicit final package for suffixes", async () => {
    await write(
      "app/build.gradle.kts",
      build.replace("minSdk = 23", 'minSdk = 23\n applicationIdSuffix = ".debug"'),
    );
    await expect(inspectAndroidProject(root)).rejects.toThrow("--android-package");
    const project = await inspectAndroidProject(root, {
      androidPackage: "com.example.installed.debug",
    });
    expect(project.packageName).toBe("com.example.installed.debug");
  });

  test("does not mistake comments for variant configuration or namespace", async () => {
    await write(
      "app/build.gradle.kts",
      `// applicationIdSuffix = ".fake"\n// namespace = "com.bad"\n${build}`,
    );
    expect((await inspectAndroidProject(root)).packageName).toBe("com.example.installed");
  });

  test("rejects computed application IDs instead of registering a namespace", async () => {
    await write(
      "app/build.gradle.kts",
      build.replace(
        'applicationId = "com.example.installed"',
        'applicationId = providers.gradleProperty("appId").get()',
      ),
    );
    await expect(inspectAndroidProject(root)).rejects.toThrow("--android-package");
  });

  test("selects explicit modules in multi-module projects", async () => {
    await write("other/build.gradle.kts", build);
    await write("other/src/main/AndroidManifest.xml", manifest);
    await expect(inspectAndroidProject(root)).rejects.toThrow("--android-module");
    expect((await inspectAndroidProject(root, { androidModule: "other" })).module).toBe("other");
  });

  test("rejects symlinked module sources and escaping paths", async () => {
    await symlink(join(root, "app"), join(root, "linked"));
    await expect(inspectAndroidProject(root, { androidModule: "linked" })).rejects.toThrow(
      "symlinks",
    );
    await expect(inspectAndroidProject(root, { androidModule: "../outside" })).rejects.toThrow(
      "Unsafe",
    );
  });

  test("rejects stale plans before any local writes", async () => {
    const project = withPublishableKey(await inspectAndroidProject(root), key);
    await write("app/build.gradle.kts", build + "// user edit\n");
    await expect(applyAndroidProject(project)).rejects.toThrow("changed after inspection");
    expect(await Bun.file(join(root, sourcePath)).exists()).toBe(false);
    expect(await read("app/src/main/AndroidManifest.xml")).toBe(manifest);
  });

  test("refuses to overwrite a user-owned key resource", async () => {
    await write("app/src/main/res/values/clerk.xml", "<resources />");
    await expect(inspectAndroidProject(root)).rejects.toThrow("not managed by Clerk");
  });

  test("refuses existing unmanaged Clerk initialization", async () => {
    await write(
      "app/src/main/AndroidManifest.xml",
      manifest.replace("<application", '<application android:name=".CustomApp"'),
    );
    await write(
      "app/src/main/java/com/example/code/CustomApp.kt",
      'class CustomApp { fun start() { Clerk.initialize(this, "existing_key") } }',
    );
    await expect(inspectAndroidProject(root)).rejects.toThrow("already configures Clerk");
  });

  test("normalizes and deduplicates fingerprints", () => {
    expect(normalizeFingerprints(["ab".repeat(32), Array(32).fill("AB").join(":")])).toEqual([
      Array(32).fill("AB").join(":"),
    ]);
    expect(() => normalizeFingerprints(["ab".repeat(20)])).toThrow("SHA-256");
  });

  test("rejects secret keys, production keys and XML injection", async () => {
    const project = await inspectAndroidProject(root);
    for (const bad of ["sk_test_secret", "pk_live_prod", "pk_test_<bad>"]) {
      expect(() => withPublishableKey(project, bad)).toThrow("development publishable key");
    }
  });
});

test("does not accept the string prefix of a computed ID", async () => {
  await write(
    "app/build.gradle.kts",
    build.replace(
      'applicationId = "com.example.installed"',
      'applicationId = "com.example.installed" + suffix',
    ),
  );
  await expect(inspectAndroidProject(root)).rejects.toThrow("--android-package");
});

test("does not treat a commented SDK dependency as installed", async () => {
  await write(
    "app/build.gradle.kts",
    build + '\n// implementation("com.clerk:clerk-android-api:0.1.0")\n',
  );
  await applyAndroidProject(withPublishableKey(await inspectAndroidProject(root), key));
  expect(await read("app/build.gradle.kts")).toContain(
    '    implementation("com.clerk:clerk-android-api:1.1.7")',
  );
});

test("reuses a version-catalog SDK entry", async () => {
  await write(
    "gradle/libs.versions.toml",
    '[libraries]\nauth = { module = "com.clerk:clerk-android-api", version = "1.1.7" }\n',
  );
  await write(
    "app/build.gradle.kts",
    build.replace('implementation("example:existing:1.0")', "implementation(libs.auth)"),
  );
  await applyAndroidProject(withPublishableKey(await inspectAndroidProject(root), key));
  expect(await read("app/build.gradle.kts")).not.toContain("com.clerk:");
});

test("supports version-catalog minSdk without modifying the shared minimum", async () => {
  await write("gradle/libs.versions.toml", '[versions]\nminSdk = "23"\n');
  await write(
    "app/build.gradle.kts",
    build.replace("minSdk = 23", "minSdk = libs.versions.minSdk.get().toInt()"),
  );
  await applyAndroidProject(withPublishableKey(await inspectAndroidProject(root), key));
  expect(await read("app/build.gradle.kts")).toContain("minSdk = 24");
  expect(await read("gradle/libs.versions.toml")).toContain('minSdk = "23"');
});

test("upgrades a literal Kotlin plugin and keeps other declarations", async () => {
  await write("app/build.gradle.kts", build.replace('version "2.4.20"', 'version "2.2.10"'));
  await applyAndroidProject(withPublishableKey(await inspectAndroidProject(root), key));
  expect(await read("app/build.gradle.kts")).toContain('version "2.4.20"');
});

test("plans a KGP classpath override for AGP built-in Kotlin and preserves imports", async () => {
  await write(
    "app/build.gradle.kts",
    build.replace('; id("org.jetbrains.kotlin.android") version "2.4.20"', ""),
  );
  await write(
    "build.gradle.kts",
    'import java.util.Properties\nplugins { id("com.android.application") version "9.3.1" apply false }\n',
  );
  await applyAndroidProject(withPublishableKey(await inspectAndroidProject(root), key));
  const rootBuild = await read("build.gradle.kts");
  expect(rootBuild).toStartWith("import java.util.Properties\n");
  expect(rootBuild).toContain("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.20");
  expect(withPublishableKey(await inspectAndroidProject(root), key).plan.actions).toHaveLength(0);
});

test("does not silently upgrade a compiler with KSP processors", async () => {
  await write(
    "app/build.gradle.kts",
    build.replace('version "2.4.20"', 'version "2.2.10"') + '\nksp("example:processor:1.0")\n',
  );
  await expect(inspectAndroidProject(root)).rejects.toThrow("KSP/kapt");
});

test("rejects duplicate or variant key resources", async () => {
  await write(
    "app/src/debug/res/values/strings.xml",
    '<resources><string name="clerk_publishable_key">old</string></resources>',
  );
  await expect(inspectAndroidProject(root)).rejects.toThrow("resource already exists");
});

test("upgrades a shared Kotlin catalog version and keeps Compose in sync", async () => {
  await write(
    "gradle/libs.versions.toml",
    '[versions]\nkotlin = "2.2.10"\n[plugins]\nkotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }\nkotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }\n',
  );
  await write(
    "app/build.gradle.kts",
    build.replace(
      'id("org.jetbrains.kotlin.android") version "2.4.20"',
      "alias(libs.plugins.kotlin.android); alias(libs.plugins.kotlin.compose)",
    ),
  );
  await applyAndroidProject(withPublishableKey(await inspectAndroidProject(root), key));
  expect(await read("gradle/libs.versions.toml")).toContain('kotlin = "2.4.20"');
  expect(await read("gradle/libs.versions.toml")).toContain('version.ref = "kotlin"');
});

test("refuses Kotlin source generation in a Java-only AGP 8 module", async () => {
  await write(
    "app/build.gradle.kts",
    build.replace('; id("org.jetbrains.kotlin.android") version "2.4.20"', ""),
  );
  await write(
    "build.gradle.kts",
    'plugins { id("com.android.application") version "8.9.1" apply false }',
  );
  await expect(inspectAndroidProject(root)).rejects.toThrow("must apply the Kotlin Android plugin");
});

test("rolls back earlier edits if a later local write fails", async () => {
  const project = withPublishableKey(await inspectAndroidProject(root), key);
  await mkdir(join(root, sourcePath), { recursive: true });
  await expect(applyAndroidProject(project)).rejects.toThrow();
  expect(await read("app/build.gradle.kts")).toBe(build);
  expect(await read("app/src/main/AndroidManifest.xml")).toBe(manifest);
  expect(await Bun.file(join(root, "app/src/main/res/values/clerk.xml")).exists()).toBe(false);
});

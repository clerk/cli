import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { CLERK_ANDROID_MINIMUM_VERSION } from "./sdk.ts";
import { inspectAndroidProject } from "./project.ts";
import { planAndroidSetup } from "./plan.ts";
import {
  ANDROID_APP_NAME,
  STARTER_VERSIONS,
  signInMainActivity,
  starterMainActivity,
  starterProjectFiles,
  writeAndroidStarter,
} from "./starter-project.ts";
import { isUnchangedStarter, planStarter } from "./starter.ts";

const project = { name: "MyApp", applicationId: "com.example.myapp" };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("starterProjectFiles", () => {
  const files = starterProjectFiles(project);

  test("pins a toolchain the Clerk SDK can be consumed by", () => {
    const catalog = files["gradle/libs.versions.toml"]!;
    expect(catalog).toContain(`agp = "${STARTER_VERSIONS.agp}"`);
    expect(catalog).toContain(`kotlin = "${STARTER_VERSIONS.kotlin}"`);
    expect(catalog).toContain('kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose"');
    expect(files["app/build.gradle.kts"]).toContain("minSdk = 24");
    expect(files["app/build.gradle.kts"]).toContain("alias(libs.plugins.kotlin.compose)");
    expect(files["gradle/wrapper/gradle-wrapper.properties"]).toContain(
      `gradle-${STARTER_VERSIONS.gradle}-bin.zip`,
    );
    expect(files["gradle/wrapper/gradle-wrapper.properties"]).toContain(
      `distributionSha256Sum=${STARTER_VERSIONS.gradleSha256}`,
    );
  });

  test("names the app, package, and theme consistently", () => {
    expect(files["settings.gradle.kts"]).toContain('rootProject.name = "MyApp"');
    expect(files["app/build.gradle.kts"]).toContain('namespace = "com.example.myapp"');
    expect(files["app/build.gradle.kts"]).toContain('applicationId = "com.example.myapp"');
    expect(files["app/src/main/AndroidManifest.xml"]).toContain(
      'android:theme="@style/Theme.MyApp"',
    );
    expect(files["app/src/main/res/values/themes.xml"]).toContain('<style name="Theme.MyApp"');
    expect(files["app/src/main/java/com/example/myapp/MainActivity.kt"]).toContain("MyAppTheme {");
    expect(files["app/src/main/java/com/example/myapp/ui/theme/Theme.kt"]).toContain(
      "fun MyAppTheme(",
    );
  });

  test("starts without Clerk, so setup has everything to add", () => {
    const manifest = files["app/src/main/AndroidManifest.xml"]!;
    expect(manifest).not.toContain('android:name=".ClerkApplication"');
    expect(manifest).not.toContain("INTERNET");
    expect(files["gradle/libs.versions.toml"]).not.toContain("clerk");
  });

  test("accepts only Kotlin-identifier names", () => {
    expect(ANDROID_APP_NAME.test("MyApp")).toBe(true);
    expect(ANDROID_APP_NAME.test("my_app2")).toBe(true);
    expect(ANDROID_APP_NAME.test("2app")).toBe(false);
    expect(ANDROID_APP_NAME.test("my-app")).toBe(false);
  });
});

describe("writeAndroidStarter", () => {
  async function write() {
    const cwd = await mkdtemp(join(tmpdir(), "clerk-android-starter-"));
    roots.push(cwd);
    const dir = join(cwd, "MyApp");
    await writeAndroidStarter(dir, project);
    return dir;
  }

  test("writes every file, the executable wrapper, and an initial commit", async () => {
    const dir = await write();
    for (const path of Object.keys(starterProjectFiles(project)))
      expect(await Bun.file(join(dir, path)).exists()).toBe(true);
    expect((await stat(join(dir, "gradlew"))).mode & 0o111).toBeTruthy();
    expect((await stat(join(dir, "gradle/wrapper/gradle-wrapper.jar"))).size).toBeGreaterThan(
      40_000,
    );
    expect(await readFile(join(dir, "gradlew.bat"), "utf8")).toContain("gradle-wrapper.jar");
    const log = await Bun.$`git log --oneline`.cwd(dir).quiet().nothrow();
    expect(log.stdout.toString()).toContain("Initial commit");
    expect((await Bun.$`git status --porcelain`.cwd(dir).quiet()).stdout.toString()).toBe("");
  });

  test("refuses an existing directory and cleans up after a failure", async () => {
    const dir = await write();
    await expect(writeAndroidStarter(dir, project)).rejects.toThrow();
    expect(await readdir(dir)).toContain("app");
  });

  test("is the unchanged starter setup recognizes, and gets the sign-in screen with the UI artifact", async () => {
    const dir = await write();
    const inspection = await inspectAndroidProject({
      root: dir,
      sdk: "ui",
      minimumVersion: CLERK_ANDROID_MINIMUM_VERSION,
    });
    expect(inspection.selection).toMatchObject({
      module: "app",
      gradlePath: ":app",
      namespace: "com.example.myapp",
      applicationId: "com.example.myapp",
    });
    expect(inspection.kotlin).toMatchObject({ version: STARTER_VERSIONS.kotlin, applied: "yes" });
    expect(await isUnchangedStarter(inspection)).toBe(true);
    const plan = await planStarter(inspection, true);
    expect(plan.tasks).toEqual(["optional-sign-in-ui"]);
    expect(plan.actions[0]).toMatchObject({
      type: "modify",
      path: "app/src/main/java/com/example/myapp/MainActivity.kt",
    });
    expect((plan.actions[0] as { content: string }).content).toBe(
      signInMainActivity("com.example.myapp", "MyApp"),
    );
    // The whole local plan still adds the SDK, the Application class, the manifest edits, and the key.
    const local = planAndroidSetup(inspection, "pk_test_abc");
    expect(local.actions.filter((a) => a.type !== "skip").map((a) => a.path)).toEqual([
      "gradle/libs.versions.toml",
      "app/build.gradle.kts",
      "app/src/main/java/com/example/myapp/ClerkApplication.kt",
      "app/src/main/AndroidManifest.xml",
      "app/src/main/res/values/clerk.xml",
    ]);
  });

  test("a customized or already converted MainActivity is left alone", async () => {
    const dir = await write();
    const activity = join(dir, "app/src/main/java/com/example/myapp/MainActivity.kt");
    await Bun.write(activity, signInMainActivity("com.example.myapp", "MyApp"));
    const converted = await inspectAndroidProject({
      root: dir,
      sdk: "ui",
      minimumVersion: CLERK_ANDROID_MINIMUM_VERSION,
    });
    expect(await isUnchangedStarter(converted)).toBe(false);
    expect((await planStarter(converted, true)).actions[0]).toMatchObject({ type: "skip" });
    await Bun.write(
      activity,
      starterMainActivity("com.example.myapp", "MyApp").replace("Hello $name!", "Hi $name"),
    );
    const custom = await inspectAndroidProject({
      root: dir,
      sdk: "ui",
      minimumVersion: CLERK_ANDROID_MINIMUM_VERSION,
    });
    expect(await isUnchangedStarter(custom)).toBe(false);
    const plan = await planStarter(custom, true);
    expect(plan.actions).toEqual([]);
    expect(plan.reason).toContain("unchanged Compose starter");
    expect((await planStarter(custom, false)).reason).toBeUndefined();
  });
});

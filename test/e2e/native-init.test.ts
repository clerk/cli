import { test, expect } from "bun:test";
import { parse as parsePbxProject } from "@bacons/xcode/json";
import { mkdtemp, cp, rm, realpath, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitInit, linkProject } from "./lib/fixture-setup.ts";
import { log } from "./lib/logger.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");

/** Native Apple integration requires Xcode; Android has its own test below. */
const PLATFORMS = [
  {
    fixture: "ios",
    detectedName: "Set up MyApp",
    instructions: [
      "SDK linked",
      "starter initialized",
      "native registration verified",
      "capabilities configured",
      "packages downloaded",
    ],
    expectedGitEntries: ["M MyApp.xcodeproj/project.pbxproj", "M MyApp/MyAppApp.swift"],
  },
] as const;

function startIOSPlatformStub(applicationId: string) {
  const developmentInstanceId = "ins_ios_e2e";
  const publishableKey = `pk_test_${btoa("clerk.example.test$")}`;
  const applicationPath = `/v1/platform/applications/${applicationId}`;
  const nativePath = `${applicationPath}/instances/${developmentInstanceId}`;

  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === applicationPath) {
        return Response.json({
          application_id: applicationId,
          name: "Native iOS E2E",
          instances: [
            {
              instance_id: developmentInstanceId,
              environment_type: "development",
              publishable_key: publishableKey,
            },
          ],
        });
      }
      if (request.method === "GET" && url.pathname === `${nativePath}/native_settings`) {
        return Response.json({ object: "native_settings", api_enabled: true });
      }
      if (request.method === "GET" && url.pathname === `${nativePath}/native_applications/ios`) {
        return Response.json([
          {
            object: "ios_application",
            id: "iosapp_e2e",
            app_id_prefix: "LEGACY1234",
            bundle_id: "com.example.MyApp",
            created_at: 0,
            updated_at: 0,
          },
        ]);
      }
      if (request.method === "GET" && url.pathname === `${nativePath}/config`) {
        return Response.json({
          config_version: "v1_1234abcd",
          connection_oauth_apple: { enabled: false, authenticatable: true },
        });
      }
      if (request.method === "GET" && url.pathname === `${nativePath}/config/schema`) {
        return Response.json({ properties: {} });
      }
      return new Response("Not found", { status: 404 });
    },
  });
}

// Keep this opt-in check local-only: the shared production E2E application can
// change its enabled social connections, while AuthView's Apple entitlement
// decision must be exercised against a controlled local-stack environment.
test.skipIf(process.platform !== "darwin")(
  "clerk init dry-run inspects Xcode without authentication or source edits",
  async () => {
    const tmp = await realpath(tmpdir());
    const projectDir = await mkdtemp(join(tmp, "clerk-e2e-ios-auth-dry-run-"));
    const configDir = await mkdtemp(join(tmp, "clerk-e2e-ios-auth-config-"));

    try {
      await cp(join(FIXTURES_DIR, "ios"), projectDir, { recursive: true });
      await gitInit(projectDir);
      const pristineApp = await Bun.file(join(projectDir, "MyApp", "MyAppApp.swift")).text();
      const pristineContentView = await Bun.file(
        join(projectDir, "MyApp", "ContentView.swift"),
      ).text();

      const result =
        await Bun.$`bun ${CLI_PATH} --mode human init --dry-run --prebuilt-auth-ui --xcode-target MyApp --no-skills`
          .cwd(projectDir)
          .env({
            ...process.env,
            CLERK_CONFIG_DIR: configDir,
            CLERK_PLATFORM_API_KEY: "",
            CLERK_TELEMETRY_DISABLED: "1",
          })
          .quiet()
          .nothrow();
      const output = result.stdout.toString() + result.stderr.toString();
      log(`prebuilt auth dry-run output:\n${output}`);

      expect(result.exitCode).toBe(0);
      expect(output).toContain("Inspection complete; no setup applied");
      expect(output).toContain("Run clerk init to choose a Clerk application");
      expect(output).not.toContain("pk_test_");

      expect(await Bun.file(join(projectDir, "MyApp", "MyAppApp.swift")).text()).toBe(pristineApp);
      expect(await Bun.file(join(projectDir, "MyApp", "ContentView.swift")).text()).toBe(
        pristineContentView,
      );
      expect(await Bun.file(join(projectDir, ".env")).exists()).toBe(false);
      expect(await Bun.file(join(projectDir, "MyApp", "LocalSecrets.plist")).exists()).toBe(false);
      const status = await Bun.$`git status --porcelain`.cwd(projectDir).quiet().nothrow();
      expect(status.stdout.toString()).toBe("");
    } finally {
      await Promise.all(
        [projectDir, configDir].map((path) =>
          rm(path, { recursive: true, force: true }).catch((err) => log(`rm: ${err}`)),
        ),
      );
    }
  },
  { timeout: 30_000 },
);

test.each(PLATFORMS.filter(() => process.platform === "darwin"))(
  "clerk init sets up a $fixture project within its native write boundary",
  async ({ fixture, detectedName, instructions, expectedGitEntries }) => {
    const platformAPIKey =
      fixture === "ios" ? "ak_test_native_fixture" : process.env.CLERK_PLATFORM_API_KEY;
    if (!platformAPIKey) throw new Error("Missing required env var: CLERK_PLATFORM_API_KEY");

    const tmp = await realpath(tmpdir());
    const projectDir = await mkdtemp(join(tmp, `clerk-e2e-${fixture}-`));
    const configDir = await mkdtemp(join(tmp, "clerk-e2e-config-"));
    let iosPlatformStub: ReturnType<typeof Bun.serve> | undefined;

    try {
      await cp(join(FIXTURES_DIR, fixture), projectDir, { recursive: true });
      const pristineIOSContentView =
        fixture === "ios"
          ? await Bun.file(join(projectDir, "MyApp", "ContentView.swift")).text()
          : undefined;
      if (fixture === "ios") {
        iosPlatformStub = startIOSPlatformStub("app_native_fixture");
      }
      await gitInit(projectDir);
      if (iosPlatformStub) {
        const linked = await Bun.$`bun ${CLI_PATH} --mode human link --app app_native_fixture`
          .cwd(projectDir)
          .env({
            CLERK_CONFIG_DIR: configDir,
            CLERK_PLATFORM_API_KEY: platformAPIKey,
            CLERK_PLATFORM_API_URL: iosPlatformStub.url.origin,
            CLERK_TELEMETRY_DISABLED: "1",
          })
          .quiet()
          .nothrow();
        expect(linked.exitCode).toBe(0);
      } else await linkProject(projectDir, configDir);

      const result = await Bun.$`bun ${CLI_PATH} --mode human init --yes --no-skills`
        .cwd(projectDir)
        .env({
          CLERK_CONFIG_DIR: configDir,
          CLERK_PLATFORM_API_KEY: platformAPIKey,
          CLERK_TELEMETRY_DISABLED: "1",
          ...(iosPlatformStub ? { CLERK_PLATFORM_API_URL: iosPlatformStub.url.origin } : {}),
        })
        .quiet()
        .nothrow();
      const output = result.stdout.toString() + result.stderr.toString();
      log(`init output:\n${output}`);

      expect(result.exitCode).toBe(0);
      expect(output).toContain(detectedName);
      for (const instruction of instructions) {
        expect(output).toContain(instruction);
      }

      if (fixture === "ios") {
        // Fresh SwiftUI setup writes the public development key directly to
        // the proven @main source, never through an unused native dotenv/plist.
        expect(await Bun.file(join(projectDir, ".env")).exists()).toBe(false);
        expect(await Bun.file(join(projectDir, "MyApp", "LocalSecrets.plist")).exists()).toBe(
          false,
        );

        const project = await Bun.file(
          join(projectDir, "MyApp.xcodeproj", "project.pbxproj"),
        ).text();
        expect(project).toContain("https://github.com/clerk/clerk-ios");
        const archive = parsePbxProject(project) as unknown as {
          objects: Record<string, Record<string, unknown>>;
        };
        const target = Object.values(archive.objects).find(
          (object) => object.isa === "PBXNativeTarget" && object.name === "MyApp",
        );
        const dependencyIds = target?.packageProductDependencies;
        expect(Array.isArray(dependencyIds)).toBe(true);
        const products = (dependencyIds as string[])
          .map((id) => archive.objects[id]?.productName)
          .sort((left, right) => String(left).localeCompare(String(right)));
        expect(products).toEqual(["ClerkKit", "ClerkKitUI"]);

        const frameworkPhaseId = (target?.buildPhases as string[] | undefined)?.find(
          (id) => archive.objects[id]?.isa === "PBXFrameworksBuildPhase",
        );
        const buildFileIds = archive.objects[frameworkPhaseId!]?.files as string[];
        const linkedProducts = buildFileIds
          .map((id) => archive.objects[id]?.productRef)
          .map((id) => archive.objects[id as string]?.productName)
          .sort((left, right) => String(left).localeCompare(String(right)));
        expect(linkedProducts).toEqual(["ClerkKit", "ClerkKitUI"]);

        const sourcePhaseId = (target?.buildPhases as string[] | undefined)?.find(
          (id) => archive.objects[id]?.isa === "PBXSourcesBuildPhase",
        );
        const sourceBuildFileIds = archive.objects[sourcePhaseId!]?.files as string[];
        const sourceMembers = sourceBuildFileIds
          .map((id) => archive.objects[id]?.fileRef)
          .map((id) => archive.objects[id as string]?.path)
          .sort((left, right) => String(left).localeCompare(String(right)));
        expect(sourceMembers).toEqual(["ContentView.swift", "MyAppApp.swift"]);

        const source = await Bun.file(join(projectDir, "MyApp", "MyAppApp.swift")).text();
        expect(source).toContain("import ClerkKit");
        expect(source.match(/Clerk\.configure\(publishableKey:/g)).toHaveLength(1);
        expect(source).toContain(".environment(Clerk.shared)");
        const inlineKey = source.match(/Clerk\.configure\(publishableKey:\s*"([^"]+)"\)/)?.[1];
        expect(inlineKey).toStartWith("pk_test_");
        expect(output).not.toContain(inlineKey!);

        // --yes authorizes the core SDK/configuration work; it does not opt
        // into replacing even this proven canonical placeholder with AuthView.
        const contentView = await Bun.file(join(projectDir, "MyApp", "ContentView.swift")).text();
        expect(contentView).toBe(pristineIOSContentView!);
        expect(contentView).not.toContain("AuthView(");
        expect(contentView).not.toContain("UserButton(");
        expect(contentView).not.toContain("Clerk.preview()");
        expect(contentView).not.toContain(inlineKey!);
      }

      // Everything was committed by gitInit. Only the declared native setup
      // files and any platform-consumed publishable-key file may remain changed.
      const status = await Bun.$`git status --porcelain -uall`.cwd(projectDir).quiet().nothrow();
      const entries = status.stdout
        .toString()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (fixture === "ios") {
        for (const entry of expectedGitEntries) expect(entries).toContain(entry);
        expect(await Bun.file(join(projectDir, "MyApp/MyApp.entitlements")).text()).toContain(
          "webcredentials:clerk.example.test",
        );
        expect(
          await Bun.file(
            join(
              projectDir,
              "MyApp.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
            ),
          ).exists(),
        ).toBe(true);
        // Adjacent backups and Xcode workspace metadata are expected new files.
        expect(
          entries
            .filter((entry) => entry.startsWith("?? "))
            .every(
              (entry) =>
                entry.includes(".clerk-backup-") || entry.startsWith("?? MyApp.xcodeproj/"),
            ),
        ).toBe(true);
        await iosPlatformStub!.stop(true);
        iosPlatformStub = startIOSPlatformStub("app_native_relinked");
        const platformApiUrl = iosPlatformStub.url.origin;
        const runRelink = async (confirmed: boolean) => {
          const relink = Bun.spawn(
            [
              process.execPath,
              CLI_PATH,
              "--mode",
              "agent",
              "init",
              "--json",
              "--app",
              "app_native_relinked",
              ...(confirmed ? ["--relink"] : []),
            ],
            {
              cwd: projectDir,
              env: {
                CLERK_CONFIG_DIR: configDir,
                CLERK_PLATFORM_API_KEY: platformAPIKey,
                CLERK_PLATFORM_API_URL: platformApiUrl,
                CLERK_TELEMETRY_DISABLED: "1",
              },
              stdout: "pipe",
              stderr: "pipe",
              timeout: 30_000,
            },
          );
          const [json, , exitCode] = await Promise.all([
            new Response(relink.stdout).text(),
            new Response(relink.stderr).text(),
            relink.exited,
          ]);
          return { result: JSON.parse(json), exitCode };
        };
        const stopped = await runRelink(false);
        expect(stopped.exitCode).toBe(2);
        expect(stopped.result.status).toBe("input-required");
        expect(stopped.result.link.flag).toBe("--relink");
        expect(stopped.result.link.current.appId).toBe("app_native_fixture");
        const confirmed = await runRelink(true);
        expect(confirmed.exitCode).toBe(0);
        expect(confirmed.result.remote).toBe("verified");
      }
    } finally {
      if (iosPlatformStub) await iosPlatformStub.stop(true);
      await rm(projectDir, { recursive: true, force: true }).catch((err) => log(`rm: ${err}`));
      await rm(configDir, { recursive: true, force: true }).catch((err) => log(`rm: ${err}`));
    }
  },
  { timeout: 120_000 },
);

/**
 * A fixed certificate fingerprint for the shared e2e application's registration of
 * `com.clerk.cli.e2e`. The CLI reads this machine's debug keystore as well, so the test points
 * ANDROID_USER_HOME at an empty folder: a registration can't be amended through the Platform API
 * yet, and a per-machine fingerprint would stop every later run.
 */
const E2E_FINGERPRINT = Array(32).fill("E2").join(":");

/** Where the build step looks for an Android SDK; without one it is skipped, not failed. */
function androidSdkRoot(): string | undefined {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || undefined;
}

test(
  "clerk init sets up an Android project, reruns without changes, passes doctor, and builds",
  async () => {
    const platformAPIKey = process.env.CLERK_PLATFORM_API_KEY;
    if (!platformAPIKey) throw new Error("Missing required env var: CLERK_PLATFORM_API_KEY");
    const tmp = await realpath(tmpdir());
    const projectDir = await mkdtemp(join(tmp, "clerk-e2e-android-"));
    const configDir = await mkdtemp(join(tmp, "clerk-e2e-config-"));
    const androidUserHome = await mkdtemp(join(tmp, "clerk-e2e-android-home-"));
    const env = {
      ...process.env,
      CLERK_CONFIG_DIR: configDir,
      CLERK_PLATFORM_API_KEY: platformAPIKey,
      CLERK_TELEMETRY_DISABLED: "1",
      ANDROID_USER_HOME: androidUserHome,
    };
    try {
      await cp(join(FIXTURES_DIR, "android"), projectDir, { recursive: true });
      await gitInit(projectDir);
      await linkProject(projectDir, configDir);
      const run = async (...args: string[]) =>
        Bun.$`bun ${CLI_PATH} --mode human init --yes --no-skills --android-fingerprint ${E2E_FINGERPRINT} ${args}`
          .cwd(projectDir)
          .env(env)
          .quiet()
          .nothrow();

      const first = await run();
      const output = first.stdout.toString() + first.stderr.toString();
      log(`Android init output:\n${output}`);
      expect(first.exitCode).toBe(0);
      expect(output).toContain("Set up com.clerk.cli.e2e (app)");
      expect(output).toContain("native registration verified");
      expect(output).not.toContain("pk_test_");

      const build = await readFile(join(projectDir, "app/build.gradle.kts"), "utf8");
      expect(build).toContain("implementation(libs.clerk.android.api)");
      expect(await readFile(join(projectDir, "gradle/libs.versions.toml"), "utf8")).toContain(
        'clerk-android-api = { module = "com.clerk:clerk-android-api", version.ref = "clerk" }',
      );
      const application = await readFile(
        join(projectDir, "app/src/main/java/com/clerk/cli/e2e/ClerkApplication.kt"),
        "utf8",
      );
      expect(application).toContain(
        "Clerk.initialize(this, publishableKey = getString(R.string.clerk_publishable_key))",
      );
      const manifest = await readFile(join(projectDir, "app/src/main/AndroidManifest.xml"), "utf8");
      expect(manifest).toContain('android:name=".ClerkApplication"');
      expect(manifest).toContain('<uses-permission android:name="android.permission.INTERNET" />');
      const resource = await readFile(
        join(projectDir, "app/src/main/res/values/clerk.xml"),
        "utf8",
      );
      expect(resource).toMatch(
        /<string name="clerk_publishable_key" translatable="false">pk_test_/,
      );
      expect(resource).not.toContain("sk_");
      expect(await Bun.file(join(projectDir, ".env")).exists()).toBe(false);

      // Everything was committed by gitInit; only the planned edits may show, and no backups
      // (every edited file was clean and tracked, so git can restore it).
      const status = await Bun.$`git status --porcelain -uall`.cwd(projectDir).quiet().nothrow();
      const entries = status.stdout
        .toString()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort();
      expect(entries).toEqual(
        [
          "M app/build.gradle.kts",
          "M app/src/main/AndroidManifest.xml",
          "M gradle/libs.versions.toml",
          "?? app/src/main/java/com/clerk/cli/e2e/ClerkApplication.kt",
          "?? app/src/main/res/values/clerk.xml",
        ].sort(),
      );

      const second = await run();
      expect(second.exitCode).toBe(0);
      const rerunStatus = await Bun.$`git status --porcelain -uall`
        .cwd(projectDir)
        .quiet()
        .nothrow();
      expect(rerunStatus.stdout.toString().split("\n").filter(Boolean).sort()).toEqual(
        status.stdout.toString().split("\n").filter(Boolean).sort(),
      );
      expect(await readFile(join(projectDir, "app/build.gradle.kts"), "utf8")).toBe(build);

      const doctor = await Bun.$`bun ${CLI_PATH} --mode human doctor --json`
        .cwd(projectDir)
        .env(env)
        .quiet()
        .nothrow();
      const checks = JSON.parse(doctor.stdout.toString()) as {
        name: string;
        status: string;
        message: string;
      }[];
      log(`Android doctor output:\n${JSON.stringify(checks, null, 2)}`);
      expect(checks.map((check) => check.name)).toEqual(
        expect.arrayContaining(["SDK dependency", "Clerk initialization", "Native registration"]),
      );
      expect(checks.filter((check) => check.status === "fail")).toEqual([]);

      const sdkRoot = androidSdkRoot();
      if (!sdkRoot) {
        log("Skipping ./gradlew assembleDebug: no Android SDK (ANDROID_HOME or ANDROID_SDK_ROOT).");
        return;
      }
      const gradle = Bun.spawn(["./gradlew", "--no-daemon", "-q", ":app:assembleDebug"], {
        cwd: projectDir,
        env: { ...env, ANDROID_HOME: sdkRoot },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 600_000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(gradle.stdout).text(),
        new Response(gradle.stderr).text(),
        gradle.exited,
      ]);
      log(`gradle output:\n${stdout}${stderr}`);
      expect(exitCode).toBe(0);
      expect(
        await Bun.file(join(projectDir, "app/build/outputs/apk/debug/app-debug.apk")).exists(),
      ).toBe(true);
    } finally {
      await Promise.all(
        [projectDir, configDir, androidUserHome].map((path) =>
          rm(path, { recursive: true, force: true }).catch((err) => log(`rm: ${err}`)),
        ),
      );
    }
  },
  { timeout: 900_000 },
);

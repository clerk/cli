import { test, expect } from "bun:test";
import { parse as parsePbxProject } from "@bacons/xcode/json";
import { mkdtemp, cp, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { gitInit, linkProject } from "./lib/fixture-setup.ts";
import { log } from "./lib/logger.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");

/**
 * Native platforms (iOS, Android) have no package.json or npm install, and CI
 * does not need Xcode or Gradle to verify their local setup boundary. These
 * hand-authored fixtures exercise detection, key pulling, bounded project
 * writes, and the remaining quickstart guidance end to end.
 */
const PLATFORMS = [
  {
    fixture: "ios",
    detectedName: "iOS (Swift)",
    instructions: [
      "ClerkKit and ClerkKitUI linked to MyApp",
      "Clerk configured in MyApp/MyAppApp.swift",
      "Clerk Native API and iOS application registration verified",
    ],
    expectedGitEntries: ["M MyApp.xcodeproj/project.pbxproj", "M MyApp/MyAppApp.swift"],
  },
  {
    fixture: "android",
    detectedName: "Android (Kotlin)",
    instructions: ["app/build.gradle.kts", "dashboard.clerk.com/~/native-applications"],
    expectedGitEntries: ["?? .env"],
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
      return new Response("Not found", { status: 404 });
    },
  });
}

// Keep this opt-in check local-only: the shared production E2E application can
// change its enabled social connections, while AuthView's Apple entitlement
// decision must be exercised against a controlled local-stack environment.
test(
  "clerk init dry-run recognizes the explicit prebuilt AuthView opt-in without writing",
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
        await Bun.$`bun ${CLI_PATH} --mode human init --dry-run --prebuilt-auth-ui --target MyApp --no-skills`
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
      expect(output).toContain(
        "Add ClerkKitUI's documented UserButton entry, AuthView sheet, and image prefetching to MyApp/ContentView.swift",
      );
      expect(output).not.toContain("pending session tasks");
      expect(output).toContain(
        "No files, Xcode settings, Clerk applications, or remote resources were changed.",
      );
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

test.each([...PLATFORMS])(
  "clerk init sets up a $fixture project within its native write boundary",
  async ({ fixture, detectedName, instructions, expectedGitEntries }) => {
    const platformAPIKey = process.env.CLERK_PLATFORM_API_KEY;
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
        iosPlatformStub = startIOSPlatformStub(process.env.CLERK_CLI_TEST_APP_ID!);
      }
      await gitInit(projectDir);
      await linkProject(projectDir, configDir, {
        platformApiUrl: iosPlatformStub?.url.origin,
      });

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
      } else {
        const envFile = Bun.file(join(projectDir, ".env"));
        expect(await envFile.exists()).toBe(true);
        const envVars = parseEnv(await envFile.text()) as Record<string, string>;
        expect(envVars["CLERK_PUBLISHABLE_KEY"]).toStartWith("pk_");
        expect(envVars["CLERK_SECRET_KEY"]).toBeUndefined();
      }

      // Everything was committed by gitInit. Only the declared native setup
      // files and any platform-consumed publishable-key file may remain changed.
      const status = await Bun.$`git status --porcelain`.cwd(projectDir).quiet().nothrow();
      const entries = status.stdout
        .toString()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      expect(entries.sort()).toEqual([...expectedGitEntries].sort());
    } finally {
      if (iosPlatformStub) await iosPlatformStub.stop(true);
      await rm(projectDir, { recursive: true, force: true }).catch((err) => log(`rm: ${err}`));
      await rm(configDir, { recursive: true, force: true }).catch((err) => log(`rm: ${err}`));
    }
  },
  { timeout: 120_000 },
);

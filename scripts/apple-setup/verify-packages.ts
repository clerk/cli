import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIOSFixture } from "../../packages/cli-core/src/commands/init/ios/test-helpers.ts";
import {
  convertFixtureToXCProj,
  useStarterSources,
} from "../../packages/cli-core/src/commands/init/ios/setup-test-helpers.ts";
import {
  prepareSetup,
  applySetup,
} from "../../packages/cli-core/src/commands/init/ios/workflow.ts";
import { inspectSelectedProject } from "../../packages/cli-core/src/commands/init/ios/xcode.ts";
import { compatibleXcode } from "../../packages/cli-core/src/commands/init/ios/xcode-tools.ts";
import type { NativeAPI } from "../../packages/cli-core/src/commands/init/ios/remote.ts";

// Actual Xcode package resolution in disposable fixtures; no real Clerk API calls.
for (const platform of ["ios", "macos"] as const)
  for (const format of ["pbxproj", "xcproj"] as const) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-package-probe-")));
    try {
      const projectRoot = join(root, "App");
      await createIOSFixture(projectRoot, { platform, clerkSDK: false, includeKey: false });
      await useStarterSources(projectRoot);
      if (format === "xcproj") await convertFixtureToXCProj(projectRoot, platform);
      await mkdir(join(root, "App.xcworkspace"));
      await writeFile(
        join(root, "App.xcworkspace/contents.xcworkspacedata"),
        '<Workspace><FileRef location="group:App/MyApp.xcodeproj"/></Workspace>',
      );
      const api: NativeAPI = {
        async fetchApplication(id) {
          return {
            application_id: id,
            instances: [
              {
                instance_id: "ins_fixture",
                environment_type: "development",
                publishable_key: `pk_test_${btoa("fixture.clerk.accounts.dev$")}`,
              },
            ],
          };
        },
        async getNativeSettings() {
          return { object: "native_settings", api_enabled: true };
        },
        async listIOSApplications() {
          return [
            {
              object: "ios_application",
              id: "ios_fixture",
              bundle_id: "com.example.MyApp",
              app_id_prefix: "TEST123456",
              created_at: 1,
              updated_at: 1,
            },
          ];
        },
        async createIOSApplication() {
          throw new Error("Fixture registration already exists");
        },
        async enableNativeApi() {
          throw new Error("Fixture Native API already enabled");
        },
      };
      const options = {
        root,
        products: "ui" as const,
        minimumVersion: "1.5.8",
        resolvePackages: true,
        signInUI: true,
        capabilities: true,
        remote: { applicationId: "app_fixture" },
        progress: (message: string) => console.log(`${format}: ${message}`),
      };
      const preview = await prepareSetup(options, { api });
      if (
        preview.discovery?.bundleSource !== "xcode" ||
        preview.discovery.prefixSource !== "clerk-registration"
      )
        throw new Error("Identity discovery did not complete");
      if (preview.starter?.actions.length !== 2) throw new Error("Starter recipe unavailable");
      const result = await applySetup(preview, { api });
      if (result.packages !== "resolved" || result.remote !== "verified")
        throw new Error(result.message ?? "Setup failed");
      const after = await inspectSelectedProject({ ...options, resolvePackages: false });
      if (result.capabilities.status !== "configured")
        throw new Error(
          `Nested project capabilities were not configured: ${preview.capabilities?.reason}`,
        );
      if (after.contexts.length !== 2) throw new Error("Post-install Xcode inspection failed");
      const lock = JSON.parse(
        await readFile(
          join(
            projectRoot,
            "MyApp.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
          ),
          "utf8",
        ),
      );
      if (!lock.pins.some((pin: { identity: string }) => pin.identity === "clerk-ios"))
        throw new Error("Clerk is not in Package.resolved");
      const developerDir = format === "xcproj" ? await compatibleXcode() : undefined;
      const buildLog = `/tmp/clerk-setup-build-${platform}-${format}.log`;
      const child = Bun.spawn(
        [
          "xcodebuild",
          "-project",
          join(projectRoot, "MyApp.xcodeproj"),
          "-scheme",
          "MyApp",
          "-configuration",
          "Debug",
          "-destination",
          platform === "ios" ? "generic/platform=iOS Simulator" : "generic/platform=macOS",
          "-derivedDataPath",
          join(root, "DerivedData"),
          "CODE_SIGNING_ALLOWED=NO",
          "build",
        ],
        {
          env: developerDir ? { ...process.env, DEVELOPER_DIR: developerDir } : process.env,
          stdout: Bun.file(buildLog),
          stderr: Bun.file(`${buildLog}.stderr`),
          timeout: 600_000,
        },
      );
      if ((await child.exited) !== 0)
        throw new Error(`App build failed: ${buildLog} and ${buildLog}.stderr`);
      console.log(
        JSON.stringify({
          format,
          platform,
          workspace: "nested project discovered automatically",
          identity: "discovered without prompts",
          packages: "resolved by Xcode; Clerk lockfile entry verified",
          postInstallSettings: "Debug and Release",
          starter: "initialization and requested UI applied; actual Debug app build passed",
          scope: "Unsigned build; no live API or actual sign-in",
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

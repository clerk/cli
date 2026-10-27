import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStarterProject } from "../../packages/cli-core/src/commands/init/ios/starter-project.ts";
import { isUnchangedStarter } from "../../packages/cli-core/src/commands/init/ios/starter.ts";
import {
  applySetup,
  prepareSetup,
} from "../../packages/cli-core/src/commands/init/ios/workflow.ts";
import { inspectSelectedProject } from "../../packages/cli-core/src/commands/init/ios/xcode.ts";
import type { NativeAPI } from "../../packages/cli-core/src/commands/init/ios/remote.ts";

// A `clerk init --starter` project through actual Xcode setup and build; no real Clerk API calls.
for (const platform of ["ios", "macos"] as const) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-starter-probe-")));
  try {
    const projectRoot = join(root, "MyApp");
    const bundleIdentifier = "com.example.MyApp";
    const teamId = "TEST123456";
    await writeStarterProject(projectRoot, { name: "MyApp", bundleIdentifier, teamId, platform });
    const registrations: Awaited<ReturnType<NativeAPI["listIOSApplications"]>> = [];
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
        return registrations;
      },
      async createIOSApplication(_app, _instance, params) {
        const created = { object: "ios_application", id: "ios_fixture", ...params };
        registrations.push(created as (typeof registrations)[number]);
        return created as (typeof registrations)[number];
      },
      async enableNativeApi() {
        throw new Error("Fixture Native API already enabled");
      },
    };
    const options = {
      root: projectRoot,
      products: "ui" as const,
      minimumVersion: "1.5.8",
      resolvePackages: true,
      signInUI: true,
      capabilities: true,
      // What `clerk init --starter` passes: the starter's team as the App ID Prefix.
      remote: { applicationId: "app_fixture", appIdPrefix: teamId },
      progress: (message: string) => console.log(`${platform}: ${message}`),
    };
    const inspection = await inspectSelectedProject({ ...options, resolvePackages: false });
    if (!(await isUnchangedStarter(inspection)))
      throw new Error("Setup doesn't recognize the generated starter");
    const preview = await prepareSetup(options, { api });
    if (
      preview.discovery?.bundleSource !== "xcode" ||
      preview.discovery.bundleIdentifier !== bundleIdentifier ||
      preview.discovery.appIdPrefix !== teamId
    )
      throw new Error(
        `Identity discovery did not complete: ${JSON.stringify({ bundleSource: preview.discovery?.bundleSource, prefixSource: preview.discovery?.prefixSource, issues: preview.discovery?.issues })}`,
      );
    if (preview.starter?.actions.length !== 2) throw new Error("Starter recipe unavailable");
    const result = await applySetup(preview, { api });
    if (result.packages !== "resolved" || result.remote !== "verified")
      throw new Error(result.message ?? "Setup failed");
    if (result.capabilities.status !== "configured")
      throw new Error(`Capabilities were not configured: ${preview.capabilities?.reason}`);
    if (registrations.length !== 1 || registrations[0]!.app_id_prefix !== teamId)
      throw new Error("The starter wasn't registered with its team as the App ID Prefix");
    const buildLog = `/tmp/clerk-starter-build-${platform}.log`;
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
        stdout: Bun.file(buildLog),
        stderr: Bun.file(`${buildLog}.stderr`),
        timeout: 600_000,
      },
    );
    if ((await child.exited) !== 0)
      throw new Error(`App build failed: ${buildLog} and ${buildLog}.stderr`);
    console.log(
      JSON.stringify({
        platform,
        starter: "generated project recognized as an unchanged starter",
        identity: "Bundle ID from Xcode, App ID Prefix from the starter's team",
        setup: "SDK, capabilities, registration, initialization, and AuthView UI applied",
        build: "actual Debug app build passed",
        scope: "Unsigned build; no live API or actual sign-in",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

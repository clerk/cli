import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIOSFixture } from "../../packages/cli-core/src/commands/init/ios/test-helpers.ts";
import { createIOSNativeRegistrationRetryStore } from "../../packages/cli-core/src/commands/init/ios/native-registration-retry.ts";
import type { IOSApplication } from "../../packages/cli-core/src/lib/plapi.ts";
import { AUTH_UI_BODY, AUTH_UI_STATE } from "../../packages/cli-core/src/commands/init/ios/plan.ts";
import type { NativeAPI } from "../../packages/cli-core/src/commands/init/ios/remote.ts";
import {
  applySetup,
  doctor,
  prepareSetup,
  type SetupOptions,
} from "../../packages/cli-core/src/commands/init/ios/workflow.ts";

// Real Xcode invocation, disposable dependency-free fixtures, simulated remote API.
// Deliberately no SDK build, package download, credentials, or authentication test.
for (const platform of ["ios", "macos"] as const) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-apple-xcode-probe-")));
  try {
    await createIOSFixture(root, { platform, clerkSDK: false, includeKey: false, xcconfig: true });
    let enabled = false;
    const applications: IOSApplication[] = [];
    const api: NativeAPI = {
      async fetchApplication(applicationId) {
        return {
          application_id: applicationId,
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
        return { object: "native_settings", api_enabled: enabled };
      },
      async listIOSApplications() {
        return applications;
      },
      async createIOSApplication(_app, _instance, params) {
        const application: IOSApplication = {
          object: "ios_application",
          id: "ios_fixture",
          bundle_id: params.bundleId,
          app_id_prefix: params.appIdPrefix,
          created_at: 1,
          updated_at: 1,
        };
        applications.push(application);
        return application;
      },
      async enableNativeApi() {
        enabled = true;
        return { object: "native_settings", api_enabled: true };
      },
    };
    const options: SetupOptions = {
      root,
      products: "ui",
      minimumVersion: "1.0.0",
      resolvePackages: false,
      remote: {
        applicationId: "app_fixture",
        bundleIdentifier: "com.example.MyApp",
        appIdPrefix: "TEST123456",
      },
    };
    const dependencies = {
      api,
      appleAPI: {
        async fetchInstanceConfig() {
          return {
            connection_oauth_apple: { enabled: false, authenticatable: true },
            config_version: "v1_1234abcd",
          };
        },
        async fetchInstanceConfigSchema() {
          return { properties: {} };
        },
        async patchInstanceConfig() {
          throw new Error("Doctor must not write");
        },
      },
      retry: createIOSNativeRegistrationRetryStore(() => join(root, "retry-state")),
    };
    const entry = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../packages/cli-core/src/cli.ts"),
        "init",
        "--dry-run",
        "--json",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    const [entryOutput, , entryCode] = await Promise.all([
      new Response(entry.stdout).text(),
      new Response(entry.stderr).text(),
      entry.exited,
    ]);
    if (entryCode !== 0 || JSON.parse(entryOutput).files.length !== 1)
      throw new Error("Public init dry run failed.");
    const preview = await prepareSetup(options, dependencies);
    const selection = preview.inspection.input.selection;
    if (selection.sdk !== (platform === "ios" ? "iphoneos" : "macosx"))
      throw new Error("Incorrect inferred platform.");
    if (preview.local.actions[0]?.type !== "modify") throw new Error("SDK edit was not planned.");
    // Real pre-install Doctor, before any Swift package dependencies are attached.
    const report = await doctor(options, dependencies);
    if (
      report.appIntegrationComplete ||
      report.checks.find((check) => check.name === "SDK project linkage")?.status !== "warn"
    )
      throw new Error("Doctor overstated the fixture's readiness.");
    const result = await applySetup(preview, dependencies);
    if (result.local !== "updated" || result.remote !== "verified" || !result.backup)
      throw new Error("Fixture setup did not complete.");
    if ((await readFile(join(root, result.backup), "utf8")) !== preview.inspection.document.source)
      throw new Error("Backup did not preserve the original project.");
    const sourcePath = join(root, "ExistingView.swift");
    // Test-only container for snippets destined for a developer's existing view.
    await writeFile(
      sourcePath,
      `import SwiftUI\nimport ClerkKit\nimport ClerkKitUI\nstruct ExistingView: View {\n${AUTH_UI_STATE}\nvar body: some View {\n${AUTH_UI_BODY}\n}\n}\n`,
    );
    const swift = Bun.spawn(["xcrun", "swiftc", "-frontend", "-parse", sourcePath], {
      cwd: root,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 30_000,
    });
    const [, code] = await Promise.all([new Response(swift.stderr).text(), swift.exited]);
    if (code !== 0) throw new Error(`Swift snippet syntax failed for ${platform}.`);
    console.log(
      JSON.stringify({
        platform,
        target: selection.targetName,
        configuration: selection.configuration,
        sdk: selection.sdk,
        selectedSettings: "real Xcode",
        entryPoint: "public init dry run passed",
        sdkEditAndBackup: result.local,
        remote: "simulated API, verified",
        doctor: "real Xcode before SDK installation",
        swiftSyntax: "passed",
        scope:
          "No package resolution, SDK typecheck, app build, post-install Xcode inspection, live API, or sign-in verification",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

import { expect } from "bun:test";
import { parse } from "@bacons/xcode/json";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createIOSFixture, IOS_FIXTURE_IDS as ids } from "./test-helpers.ts";
import { createIOSNativeRegistrationRetryStore } from "./native-registration-retry.ts";
import type { IOSNativeAppleAPI } from "./native-apple.ts";
import type { IOSApplication } from "../../../lib/plapi.ts";
import type { SetupOptions } from "./workflow.ts";
import type { NativeAPI } from "./remote.ts";
import type { CommandRunner } from "./xcode.ts";

const key = `pk_test_${btoa("fixture.clerk.accounts.dev$")}`;
export async function capabilityFixture(
  root: string,
  platform: "ios" | "macos" = "ios",
  secondTarget = false,
) {
  await createIOSFixture(root, {
    platform,
    clerkSDK: false,
    includeKey: false,
    secondTarget,
    macOSAppleEntitlement: false,
  });
  const path = join(root, "MyApp.xcodeproj/project.pbxproj");
  const state = {
    enabled: false,
    apps: [] as IOSApplication[],
    apple: {
      enabled: false,
      authenticatable: true,
      client_secret: "SYNTHETIC_PRESERVED_SECRET",
    } as Record<string, unknown>,
    version: "v1_1234abcd",
    events: [] as string[],
    failApple: false,
  };
  const api: NativeAPI = {
    async fetchApplication(id) {
      return {
        application_id: id,
        instances: [
          { instance_id: "ins_test", environment_type: "development", publishable_key: key },
        ],
      };
    },
    async getNativeSettings() {
      return { object: "native_settings", api_enabled: state.enabled };
    },
    async listIOSApplications() {
      return state.apps;
    },
    async createIOSApplication(_app, _instance, params) {
      state.events.push("register");
      const app: IOSApplication = {
        object: "ios_application",
        id: "ios_test",
        bundle_id: params.bundleId,
        app_id_prefix: params.appIdPrefix,
        created_at: 1,
        updated_at: 1,
      };
      state.apps.push(app);
      return app;
    },
    async enableNativeApi() {
      state.events.push("enable-native");
      state.enabled = true;
      state.version = "v1_2345abcd";
      return { object: "native_settings", api_enabled: true };
    },
  };
  const appleAPI: IOSNativeAppleAPI = {
    async fetchInstanceConfig() {
      return { config_version: state.version, connection_oauth_apple: { ...state.apple } };
    },
    async fetchInstanceConfigSchema() {
      return {
        properties: {
          connection_oauth_apple: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              authenticatable: { type: "boolean" },
              bundle_id: { type: "string" },
            },
          },
        },
      };
    },
    async patchInstanceConfig(_app, _instance, patch, options) {
      expect(options.ifMatch).toBe(state.version);
      expect(Object.keys(patch.connection_oauth_apple as object).sort()).toEqual([
        "authenticatable",
        "bundle_id",
        "enabled",
      ]);
      const before = { connection_oauth_apple: { ...state.apple } };
      const next = { ...state.apple, ...(patch.connection_oauth_apple as object) };
      state.events.push(options.dryRun ? "apple-dry-run" : "apple-apply");
      if (!options.dryRun) {
        if (state.failApple) throw new Error("Interrupted request");
        state.apple = next;
        state.version = "v1_3456abcd";
      }
      return {
        dry_run: options.dryRun,
        before,
        after: { connection_oauth_apple: next },
        config_version: state.version,
      };
    },
  };
  // Synthetic settings derived from this fixture's selected configuration. This is
  // test scaffolding, not a substitute implementation of Xcode's evaluator.
  const run: CommandRunner = async (command) => {
    const configuration = command[command.indexOf("-configuration") + 1];
    const objects = parse(await readFile(path, "utf8")).objects as Record<string, any>;
    const settings =
      objects[configuration === "Release" ? ids.targetRelease : ids.targetDebug].buildSettings;
    const sdk = platform === "macos" ? "macosx" : "iphoneos";
    return JSON.stringify([
      {
        target: "MyApp",
        buildSettings: {
          TARGET_NAME: "MyApp",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.MyApp",
          GENERATE_INFOPLIST_FILE: "YES",
          SRCROOT: root,
          DEVELOPER_DIR: "/Applications/Fixture Xcode.app/Contents/Developer",
          CONFIGURATION: configuration,
          PLATFORM_NAME: sdk,
          PROJECT_FILE_PATH: join(root, "MyApp.xcodeproj"),
          PRODUCT_TYPE: "com.apple.product-type.application",
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          MACOSX_DEPLOYMENT_TARGET: "14.0",
          ENABLE_APP_SANDBOX: platform === "macos" ? "YES" : "NO",
          CODE_SIGN_ENTITLEMENTS:
            settings[
              `CODE_SIGN_ENTITLEMENTS[sdk=${platform === "macos" ? "macosx*" : "iphone*"}]`
            ] ??
            settings.CODE_SIGN_ENTITLEMENTS ??
            "",
          ENABLE_OUTGOING_NETWORK_CONNECTIONS:
            settings["ENABLE_OUTGOING_NETWORK_CONNECTIONS[sdk=macosx*]"] ?? "NO",
        },
      },
    ]);
  };
  const options: SetupOptions = {
    root,
    target: "MyApp",
    products: "ui",
    minimumVersion: "1.0.0",
    resolvePackages: false,
    capabilities: true,
    signInWithApple: true,
    remote: {
      applicationId: "app_test",
      instanceId: "ins_test",
      bundleIdentifier: "com.example.MyApp",
      appIdPrefix: "TEST123456",
    },
  };
  return {
    root,
    path,
    options,
    state,
    dependencies: {
      api,
      appleAPI,
      run,
      retry: createIOSNativeRegistrationRetryStore(() => join(root, "retry")),
    },
  };
}

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IOSApplication, NativeSettings } from "../../../lib/plapi.ts";
import { ERROR_CODE } from "../../../lib/errors.ts";
import { applyXCProjValue } from "./xcproj.ts";
import { inspectIOSProject } from "./inspect.ts";
import { buildIOSNativeReadinessAudit } from "./native-readiness.ts";
import {
  applyIOSNativeRemoteSetup,
  buildIOSNativeRemotePlan,
  type IOSNativeRemoteAPI,
} from "./native-remote.ts";
import {
  createIOSFixture,
  createIOSJSONFixture,
  convertIOSFixtureToMultiplatform,
  treeDigest,
} from "./test-helpers.ts";

for (const format of ["pbx", "json"] as const) {
  for (const platform of ["ios", "macos"] as const) {
    test.each([false, true])(
      `rechecks the approved ${format} ${platform} view with the default reader (changed: %s)`,
      async (changed) => {
        const root = await mkdtemp(join(tmpdir(), "clerk-remote-platform-"));
        try {
          if (format === "pbx") {
            await createIOSFixture(root);
            await convertIOSFixtureToMultiplatform(root);
          } else {
            await createIOSJSONFixture(root);
            const path = join(root, "MyApp.xcodeproj", "project.xcproj");
            let project = await Bun.file(path).text();
            project = applyXCProjValue(project, ["build-settings", "SDKROOT"], "auto");
            project = applyXCProjValue(
              project,
              ["targets", 0, "build-settings", "SUPPORTED_PLATFORMS"],
              "iphoneos iphonesimulator macosx",
            );
            project = applyXCProjValue(
              project,
              ["targets", 0, "build-settings", "MACOSX_DEPLOYMENT_TARGET"],
              "14.0",
            );
            await Bun.write(path, project);
          }
          const { target } = buildIOSNativeReadinessAudit(
            await inspectIOSProject(root, { target: "MyApp", platform }),
          );
          if (target.status !== "selected" || target.bundleIdentifier.status !== "resolved")
            throw new Error("Expected a resolved target");
          const prefix =
            target.appIdPrefix.status === "resolved" ? target.appIdPrefix.value : "ABCDE12345";
          const settings: NativeSettings = { object: "native_settings", api_enabled: true };
          const registration: IOSApplication = {
            object: "ios_application",
            id: "iosapp_platform",
            app_id_prefix: prefix,
            bundle_id: target.bundleIdentifier.value,
            created_at: 1,
            updated_at: 1,
          };
          const plan = buildIOSNativeRemotePlan({
            root,
            target,
            applicationId: "app_platform",
            instanceId: "ins_platform",
            requestedAppIdPrefix: prefix,
            nativeSettings: settings,
            registrations: [registration],
          });
          expect(plan.status).toBe("satisfied");
          if (changed) {
            const path = join(
              root,
              "MyApp.xcodeproj",
              format === "pbx" ? "project.pbxproj" : "project.xcproj",
            );
            await Bun.write(
              path,
              (await Bun.file(path).text()).replaceAll("com.example.MyApp", "com.example.Changed"),
            );
          }
          const before = await treeDigest(root);
          const calls: string[] = [];
          const api: IOSNativeRemoteAPI = {
            getNativeSettings: async () => {
              calls.push("settings");
              return settings;
            },
            listIOSApplications: async () => {
              calls.push("registrations");
              return [registration];
            },
            enableNativeApi: async () => {
              throw new Error("No remote write expected");
            },
            createIOSApplication: async () => {
              throw new Error("No remote write expected");
            },
          };
          // Leave targetReader unset to exercise the real default inspection path.
          const apply = applyIOSNativeRemoteSetup(plan, {
            api,
            registrationRetryStore: {
              peek: async () => undefined,
              getOrCreate: async () => {
                throw new Error("No retry record expected");
              },
              clear: async () => true,
            },
          });
          if (changed) {
            await expect(apply).rejects.toMatchObject({ code: ERROR_CODE.IOS_SETUP_STALE });
            expect(calls).toEqual([]);
          } else {
            await apply;
            expect(calls).toEqual(["settings", "registrations", "settings", "registrations"]);
          }
          expect(await treeDigest(root)).toEqual(before);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
}

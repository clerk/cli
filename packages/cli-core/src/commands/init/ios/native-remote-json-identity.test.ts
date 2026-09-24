import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectIOSProject } from "./inspect.ts";
import { buildIOSNativeReadinessAudit } from "./native-readiness.ts";
import { buildIOSNativeRemotePlan } from "./native-remote.ts";
import { createIOSJSONFixture } from "./test-helpers.ts";
import { parseXCProjSource, applyXCProjValue, xcprojTargets } from "./xcproj.ts";

test.each([
  {
    name: "manual plist",
    generated: "NO",
    plist: "com.example.Actual",
    expected: "com.example.Actual",
  },
  {
    name: "generated plist precedence",
    generated: "YES",
    plist: "com.example.Actual",
    expected: "com.example.MyApp",
  },
  { name: "unresolved manual plist", generated: "NO", plist: "$(UNKNOWN)" },
  { name: "missing manual plist", generated: "NO" },
  { name: "preprocessed plist", generated: "NO", plist: "com.example.Actual", preprocess: "YES" },
  { name: "packaging context conflict", arch: true },
  { name: "uppercase user variable", uppercase: true, expected: "com.example.Actual.app" },
])("authorizes JSON registration using the effective identity: $name", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "clerk-native-effective-identity-"));
  try {
    await createIOSJSONFixture(root);
    const path = join(root, "MyApp.xcodeproj/project.xcproj");
    const source = await Bun.file(path).text();
    const project = parseXCProjSource(source).root;
    const targetSettings = xcprojTargets(project)[0]!.buildSettings;
    const settings = {
      ...targetSettings,
      CODE_SIGN_ENTITLEMENTS: "",
      ...(scenario.generated
        ? { GENERATE_INFOPLIST_FILE: scenario.generated, INFOPLIST_FILE: "MyApp/Info.plist" }
        : {}),
      ...(scenario.preprocess ? { INFOPLIST_PREPROCESS: scenario.preprocess } : {}),
      ...(scenario.arch
        ? {
            "PRODUCT_BUNDLE_IDENTIFIER[arch=*]": "com.example.Broad",
            "PRODUCT_BUNDLE_IDENTIFIER[arch=arm64]": "com.example.Narrow",
            "PRODUCT_BUNDLE_IDENTIFIER[arch=x86_64]": "com.example.Narrow",
          }
        : {}),
      ...(scenario.uppercase
        ? { INHERITED: "com.example.Actual", PRODUCT_BUNDLE_IDENTIFIER: "$(INHERITED).app" }
        : {}),
    };
    await Bun.write(path, applyXCProjValue(source, ["targets", 0, "build-settings"], settings));
    if (scenario.plist !== undefined)
      await Bun.write(
        join(root, "MyApp/Info.plist"),
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${scenario.plist}</string></dict></plist>`,
      );
    const { target } = buildIOSNativeReadinessAudit(
      await inspectIOSProject(root, { target: "MyApp" }),
    );
    const plan = buildIOSNativeRemotePlan({
      root,
      target,
      applicationId: "app_identity_test",
      instanceId: "ins_identity_test",
      requestedAppIdPrefix: "ABCDE12345",
      nativeSettings: { object: "native_settings", api_enabled: true },
      registrations: [],
    });
    if (scenario.expected) {
      expect(plan).toMatchObject({
        status: "ready",
        registration: "required",
        bundleIdentifier: scenario.expected,
        blockers: [],
      });
      expect(plan.actions).toContain(
        `Register iOS Bundle ID ${scenario.expected} with Apple App ID Prefix ABCDE12345.`,
      );
    } else {
      expect(plan).toMatchObject({ status: "blocked", registration: "blocked", actions: [] });
      expect(plan.blockers).toContainEqual(
        expect.objectContaining({ code: "bundle-identifier-unavailable" }),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

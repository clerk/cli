import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectIOSProject } from "./inspect.ts";
import { buildIOSNativeReadinessAudit } from "./native-readiness.ts";
import { buildIOSNativeRemotePlan } from "./native-remote.ts";
import { createIOSFixture } from "./test-helpers.ts";

test.each([
  {
    name: "unsupported conditions",
    xcconfig:
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp\nPRODUCT_BUNDLE_IDENTIFIER[variant=profile] = com.example.Profile\n",
    identity: "unresolved",
  },
  {
    name: "versioned SDK conditions",
    xcconfig:
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp\nPRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos26*] = com.example.Versioned\n",
    identity: "unresolved",
  },
  {
    name: "indirect conditional values",
    xcconfig:
      "APP_SUFFIX = MyApp\nAPP_SUFFIX[variant=profile] = Profile\nPRODUCT_BUNDLE_IDENTIFIER = com.example.$(APP_SUFFIX)\n",
    identity: "unresolved",
  },
  {
    name: "question-mark conditions that disagree across configurations",
    xcconfig:
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp\nPRODUCT_BUNDLE_IDENTIFIER[config=Debu?] = com.example.Debug\n",
    identity: "conflicting",
  },
  {
    name: "assignment terminators",
    xcconfig: "PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp;\n",
    identity: "resolved",
  },
  {
    name: "unrelated unsupported conditions",
    xcconfig:
      "OTHER_SETTING[variant=profile] = Unused\nPRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp\n",
    identity: "resolved",
  },
])("preserves the registration boundary for $name", async ({ xcconfig, identity }) => {
  const root = await mkdtemp(join(tmpdir(), "clerk-native-remote-xcconfig-"));
  try {
    await createIOSFixture(root, { xcconfig: true });
    await Bun.write(join(root, "Config", "Target.xcconfig"), xcconfig);

    // Use the actual inspection and readiness pipeline, not a constructed
    // target, so a falsely resolved Bundle ID can reach the planner in this test.
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const { target } = buildIOSNativeReadinessAudit(inspection);
    const plan = buildIOSNativeRemotePlan({
      root,
      applicationId: "app_xcconfig_test",
      instanceId: "ins_xcconfig_test",
      target,
      requestedAppIdPrefix: "LEGACY1234",
      nativeSettings: { object: "native_settings", api_enabled: true },
      registrations: [],
    });

    expect(target).toMatchObject({
      status: "selected",
      bundleIdentifier: { status: identity },
    });
    if (identity === "resolved") {
      expect(plan).toMatchObject({
        status: "ready",
        registration: "required",
        bundleIdentifier: "com.example.MyApp",
        blockers: [],
      });
      expect(plan.actions).toContain(
        "Register iOS Bundle ID com.example.MyApp with Apple App ID Prefix LEGACY1234.",
      );
    } else {
      expect(plan).toMatchObject({ status: "blocked", registration: "blocked" });
      expect(plan.blockers).toContainEqual(
        expect.objectContaining({ code: "bundle-identifier-unavailable" }),
      );
      expect(plan.actions).toEqual([]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

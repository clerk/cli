import { expect, test } from "bun:test";
import { build, parse } from "@bacons/xcode/json";
import type { PbxObjects } from "./pbx.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectIOSProject } from "./inspect.ts";
import { buildIOSNativeReadinessAudit } from "./native-readiness.ts";
import { buildIOSNativeRemotePlan } from "./native-remote.ts";
import { createIOSFixture, IOS_FIXTURE_IDS as IDS } from "./test-helpers.ts";

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

for (const source of ["xcconfig", "inline"] as const) {
  test.each([
    { condition: "sdk=IPHONE*", bundleIdentifier: "com.example.Shipping" },
    { condition: "sdk=iphone*", bundleIdentifier: "com.example.Conditional" },
    { condition: "arch=ARM64", bundleIdentifier: "com.example.Shipping" },
    { condition: "config=debug", bundleIdentifier: "com.example.Shipping" },
    { condition: "SDK=iphone*", bundleIdentifier: undefined },
    { condition: "ARCH=arm64", bundleIdentifier: undefined },
    { condition: "Config=Debug", bundleIdentifier: undefined },
  ])(
    `preserves registration identity for ${source} condition casing: $condition`,
    async ({ condition, bundleIdentifier }) => {
      const root = await mkdtemp(join(tmpdir(), "clerk-native-condition-case-"));
      try {
        await createIOSFixture(root, { xcconfig: source === "xcconfig" });
        const settings = {
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.Shipping",
          [`PRODUCT_BUNDLE_IDENTIFIER[${condition}]`]: "com.example.Conditional",
        };
        if (source === "xcconfig") {
          await Bun.write(
            join(root, "Config/Target.xcconfig"),
            Object.entries(settings)
              .map(([key, value]) => `${key} = ${value}`)
              .join("\n"),
          );
        } else {
          const path = join(root, "MyApp.xcodeproj/project.pbxproj");
          const project = parse(await Bun.file(path).text());
          const objects = project.objects as PbxObjects;
          for (const id of [IDS.targetDebug, IDS.targetRelease]) {
            Object.assign(objects[id]!.buildSettings as object, settings);
          }
          await Bun.write(path, build(project));
        }

        const { target } = buildIOSNativeReadinessAudit(
          await inspectIOSProject(root, { target: "MyApp" }),
        );
        const plan = buildIOSNativeRemotePlan({
          root,
          target,
          applicationId: "app_condition_case_test",
          instanceId: "ins_condition_case_test",
          requestedAppIdPrefix: "ABCDE12345",
          nativeSettings: { object: "native_settings", api_enabled: true },
          registrations: [],
        });
        if (bundleIdentifier === undefined) {
          expect(target).toMatchObject({
            status: "selected",
            bundleIdentifier: { status: "unresolved" },
          });
          expect(plan).toMatchObject({ status: "blocked", registration: "blocked", actions: [] });
          expect(plan.blockers).toContainEqual(
            expect.objectContaining({ code: "bundle-identifier-unavailable" }),
          );
        } else {
          expect(target).toMatchObject({
            status: "selected",
            bundleIdentifier: { status: "resolved", value: bundleIdentifier },
          });
          expect(plan).toMatchObject({
            status: "ready",
            registration: "required",
            bundleIdentifier,
            blockers: [],
          });
          expect(plan.actions).toContain(
            `Register iOS Bundle ID ${bundleIdentifier} with Apple App ID Prefix ABCDE12345.`,
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test.each([false, true])(
  "registration uses the synchronized-folder xcconfig identity, never the fallback (missing: %s)",
  async (missing) => {
    const root = await mkdtemp(join(tmpdir(), "clerk-native-remote-anchor-"));
    try {
      await createIOSFixture(root, { xcconfig: true });
      const path = join(root, "MyApp.xcodeproj/project.pbxproj");
      const project = parse(await Bun.file(path).text());
      const objects = project.objects as PbxObjects;
      objects.anchor = {
        isa: "PBXFileSystemSynchronizedRootGroup",
        path: "Config",
        sourceTree: "<group>",
      };
      (objects[IDS.mainGroup]!.children as string[]).push("anchor");
      for (const id of [IDS.projectDebug, IDS.projectRelease]) {
        (objects[id]!.buildSettings as Record<string, string>).PRODUCT_BUNDLE_IDENTIFIER =
          "com.example.Fallback";
      }
      for (const id of [IDS.targetDebug, IDS.targetRelease]) {
        const configuration = objects[id]!;
        delete configuration.baseConfigurationReference;
        delete (configuration.buildSettings as Record<string, string>).PRODUCT_BUNDLE_IDENTIFIER;
        (configuration.buildSettings as Record<string, string>).CODE_SIGN_ENTITLEMENTS = "";
        // Keep platform evidence independent of the unavailable base xcconfig.
        Object.assign(configuration.buildSettings as object, {
          SDKROOT: "iphoneos",
          SUPPORTS_MACCATALYST: "NO",
        });
        configuration.baseConfigurationReferenceAnchor = "anchor";
        configuration.baseConfigurationReferenceRelativePath = missing
          ? "Missing.xcconfig"
          : "Target.xcconfig";
      }
      await Bun.write(
        join(root, "Config/Target.xcconfig"),
        "PRODUCT_BUNDLE_IDENTIFIER = com.example.Actual\n",
      );
      await Bun.write(path, build(project));
      const { target } = buildIOSNativeReadinessAudit(
        await inspectIOSProject(root, { target: "MyApp" }),
      );
      const plan = buildIOSNativeRemotePlan({
        root,
        target,
        applicationId: "app_anchor_test",
        instanceId: "ins_anchor_test",
        requestedAppIdPrefix: "ABCDE12345",
        nativeSettings: { object: "native_settings", api_enabled: true },
        registrations: [],
      });
      if (missing) {
        expect(plan).toMatchObject({ status: "blocked", registration: "blocked", actions: [] });
        expect(plan.blockers).toContainEqual(
          expect.objectContaining({ code: "bundle-identifier-unavailable" }),
        );
      } else {
        expect(plan).toMatchObject({
          status: "ready",
          registration: "required",
          bundleIdentifier: "com.example.Actual",
          blockers: [],
        });
        expect(plan.actions).toContain(
          "Register iOS Bundle ID com.example.Actual with Apple App ID Prefix ABCDE12345.",
        );
      }
      expect(plan.bundleIdentifier).not.toBe("com.example.Fallback");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("unresolved source exclusions do not invalidate a separately proven registration identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "clerk-native-remote-source-filter-"));
  try {
    await createIOSFixture(root, { xcconfig: true });
    await Bun.write(
      join(root, "Config/Target.xcconfig"),
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp\nEXCLUDED_SOURCE_FILE_NAMES = $(CUSTOM_EXCLUSIONS)\n",
    );
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    expect(inspection.appTargets[0]?.swift.evidenceComplete).toBe(false);
    const { target } = buildIOSNativeReadinessAudit(inspection);
    const plan = buildIOSNativeRemotePlan({
      root,
      target,
      applicationId: "app_filter_test",
      instanceId: "ins_filter_test",
      requestedAppIdPrefix: "LEGACY1234",
      nativeSettings: { object: "native_settings", api_enabled: true },
      registrations: [],
    });
    expect(plan).toMatchObject({
      status: "ready",
      registration: "required",
      bundleIdentifier: "com.example.MyApp",
      blockers: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
])("authorizes registration using the effective identity: $name", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "clerk-native-effective-identity-"));
  try {
    await createIOSFixture(root);
    const path = join(root, "MyApp.xcodeproj/project.pbxproj");
    const project = parse(await Bun.file(path).text());
    const objects = project.objects as PbxObjects;
    for (const id of [IDS.targetDebug, IDS.targetRelease]) {
      Object.assign(objects[id]!.buildSettings as object, {
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
      });
    }
    await Bun.write(path, build(project));
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

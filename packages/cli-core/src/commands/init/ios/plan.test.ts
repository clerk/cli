import { afterEach, describe, expect, test } from "bun:test";
import { build, parse } from "@bacons/xcode/json";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIOSFixture, IOS_FIXTURE_IDS as ids, treeDigest } from "./test-helpers.ts";
import { writePlan } from "../heuristics.ts";
import { planAppleSetup, selectedSettings, settingsCommand, type SetupInput } from "./plan.ts";
import { scaffoldSDK } from "./sdk.ts";
import { sdkHealth } from "./sdk-health.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  platform: "ios" | "macos" = "ios",
  products: "core" | "ui" = "ui",
): Promise<SetupInput> {
  const root = await mkdtemp(join(tmpdir(), "clerk-apple-plan-"));
  roots.push(root);
  await createIOSFixture(root, {
    platform,
    clerkSDK: false,
    secondTarget: true,
    includeKey: false,
    conflictingBundle: true,
    xcconfig: true,
    releasePlatform: "unresolved",
  });
  const selection = {
    root,
    project: "MyApp.xcodeproj",
    targetId: ids.appTarget,
    targetName: "MyApp",
    configuration: "Debug",
    sdk: platform === "macos" ? ("macosx" as const) : ("iphoneos" as const),
  };
  return {
    selection,
    managedBy: "xcode",
    projectFormat: "pbxproj",
    products,
    minimumVersion: "1.0.0",
    projectSource: await readFile(join(root, selection.project, "project.pbxproj"), "utf8"),
    // Synthetic Xcode output for unit tests, not captured evidence of an Xcode invocation.
    settingsJSON: JSON.stringify([
      {
        target: "MyApp",
        buildSettings: {
          TARGET_NAME: "MyApp",
          CONFIGURATION: "Debug",
          PLATFORM_NAME: selection.sdk,
          PROJECT_FILE_PATH: join(root, selection.project),
          PRODUCT_TYPE: "com.apple.product-type.application",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.MyApp",
          DEVELOPMENT_TEAM: "ABCDE12345",
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          MACOSX_DEPLOYMENT_TARGET: "14.0",
          ENABLE_APP_SANDBOX: platform === "macos" ? "YES" : "NO",
          CODE_SIGN_ENTITLEMENTS: "MyApp/MyApp.entitlements",
        },
      },
    ]),
  };
}

function sdkInput(input: SetupInput) {
  return {
    path: `${input.selection.project}/project.${input.projectFormat}`,
    source: input.projectSource,
    targetId: input.selection.targetId,
    targetName: input.selection.targetName,
    products: input.products,
    minimumVersion: input.minimumVersion,
    managedBy: input.managedBy,
  };
}

function mutateGraph(input: SetupInput, edit: (objects: Record<string, any>) => void): void {
  const document = parse(input.projectSource);
  edit(document.objects!);
  input.projectSource = build(document);
}

async function installed(input: SetupInput): Promise<SetupInput> {
  await writePlan(input.selection.root, planAppleSetup(input));
  return {
    ...input,
    projectSource: await Bun.file(join(input.selection.root, sdkInput(input).path)).text(),
  };
}

describe("Apple setup plan", () => {
  for (const platform of ["ios", "macos"] as const) {
    test.each(["core", "ui"] as const)(
      `${platform}: %s linkage, preservation, and byte-stable rerun`,
      async (products) => {
        const input = await fixture(platform, products);
        const before = parse(input.projectSource);
        const beforeTree = await treeDigest(input.selection.root);
        const plan = planAppleSetup(input);
        expect(await treeDigest(input.selection.root)).toEqual(beforeTree);
        expect(plan.actions[0]?.type).toBe("modify");
        expect(plan.actions).toHaveLength(1);
        const recipe = plan.postInstructions.join("\n");
        expect(recipe).toContain(
          "https://clerk.com/docs/ios/getting-started/quickstart.md?manual=1",
        );
        expect(recipe).not.toContain("ClerkProvider");
        expect(recipe).not.toContain("ClerkAuthButton");
        const next = await installed(input);
        const after = parse(next.projectSource);
        const objects = after.objects as Record<string, any>;
        const target = objects[ids.appTarget];
        const linked = target.packageProductDependencies.map((id: string) => objects[id]);
        expect(linked.map((item: any) => item.productName)).toEqual(
          products === "ui" ? ["ClerkKit", "ClerkKitUI"] : ["ClerkKit"],
        );
        for (const productId of target.packageProductDependencies) {
          expect(
            objects[ids.frameworksPhase].files.filter(
              (id: string) => objects[id].productRef === productId,
            ),
          ).toHaveLength(1);
        }
        for (const [id, object] of Object.entries(before.objects!)) {
          if (![ids.project, ids.appTarget, ids.frameworksPhase].includes(id as any))
            expect(objects[id]).toEqual(object);
        }
        expect(objects[ids.project].hasScannedForEncodings).toBeUndefined();
        const packageId = objects[ids.project].packageReferences[0];
        expect(objects[packageId].requirement).toEqual({
          kind: "upToNextMajorVersion",
          minimumVersion: "1.0.0",
        });
        const changedPaths = new Set(
          plan.actions.filter((a) => a.type !== "skip").map((a) => a.path),
        );
        const unchangedFile = (line: string) =>
          line.startsWith("f:") && !changedPaths.has(line.split(":")[1]!);
        expect((await treeDigest(input.selection.root)).filter(unchangedFile)).toEqual(
          beforeTree.filter(unchangedFile),
        );
        const rerun = planAppleSetup(next);
        expect(rerun.actions.every((action) => action.type === "skip")).toBe(true);
        const digest = await treeDigest(input.selection.root);
        await writePlan(input.selection.root, rerun);
        expect(await treeDigest(input.selection.root)).toEqual(digest);
        expect(rerun.postInstructions.join("\n")).toContain(
          "Other configurations and platforms are not verified",
        );
        expect(rerun.postInstructions.join("\n")).toContain(
          platform === "ios" ? "Associated Domains" : "Outgoing Connections",
        );
      },
    );
  }

  test("adding UI preserves an existing pin and unrelated data", async () => {
    let input = await installed(await fixture("ios", "core"));
    mutateGraph(input, (objects) => {
      const reference = objects[ids.project].packageReferences[0];
      objects[reference].repositoryURL = "https://github.com/clerk/clerk-ios";
      objects[reference].requirement = { kind: "exactVersion", version: "1.0.0" };
      objects[ids.appTarget].opaqueData = Buffer.from([0xab, 0xcd]);
    });
    input.products = "ui";
    const plan = planAppleSetup(input);
    const sdk = plan.actions[0];
    expect(sdk?.type).toBe("modify");
    if (sdk?.type !== "modify") throw new Error("Missing package update");
    const objects = parse(sdk.content).objects as Record<string, any>;
    expect(objects[objects[ids.project].packageReferences[0]].requirement).toEqual({
      kind: "exactVersion",
      version: "1.0.0",
    });
    expect(objects[ids.appTarget].opaqueData).toEqual(Buffer.from([0xab, 0xcd]));
  });

  test.each([
    [
      "duplicate packages",
      (objects: Record<string, any>) => {
        objects.EXTRA = { ...objects[ids.clerkPackage] };
        objects[ids.project].packageReferences.push("EXTRA");
      },
    ],
    [
      "different package",
      (objects: Record<string, any>) => {
        objects[ids.clerkPackage].repositoryURL = "https://example.com/another.git";
      },
    ],
    [
      "missing framework link",
      (objects: Record<string, any>) => {
        objects[ids.frameworksPhase].files = [];
      },
    ],
    [
      "conditional framework link",
      (objects: Record<string, any>) => {
        objects[ids.clerkKitBuildFile].platformFilter = "ios";
      },
    ],
    [
      "shared framework phase",
      (objects: Record<string, any>) => {
        objects[ids.secondTarget].buildPhases.push(ids.frameworksPhase);
      },
    ],
  ] as const)("hands off %s without a package edit", async (_label, edit) => {
    const input = await fixture();
    await createIOSFixture(input.selection.root, {
      clerkSDK: true,
      secondTarget: true,
      includeKey: false,
    });
    input.projectSource = await Bun.file(join(input.selection.root, sdkInput(input).path)).text();
    mutateGraph(input, edit);
    const result = scaffoldSDK(sdkInput(input));
    expect(result.type).toBe("skip");
    if (result.type === "skip") expect(result.skipReason).not.toContain("already linked");
  });

  test("hands off a local clerk-ios checkout instead of adding a second package", async () => {
    const input = await fixture();
    mutateGraph(input, (objects) => {
      objects.LOCALCLERK = { isa: "XCLocalSwiftPackageReference", relativePath: "../clerk-ios" };
      objects[ids.project].packageReferences = ["LOCALCLERK"];
    });
    const result = scaffoldSDK(sdkInput(input));
    expect(result.type).toBe("skip");
    if (result.type === "skip") expect(result.skipReason).toContain("local or forked");
  });

  test("reuses a Clerk package referenced over SSH", async () => {
    const input = await fixture();
    mutateGraph(input, (objects) => {
      objects.SSHCLERK = {
        isa: "XCRemoteSwiftPackageReference",
        repositoryURL: "git@github.com:clerk/clerk-ios.git",
        requirement: { kind: "upToNextMajorVersion", minimumVersion: "1.0.0" },
      };
      objects[ids.project].packageReferences = ["SSHCLERK"];
    });
    const result = scaffoldSDK(sdkInput(input));
    expect(result.type).toBe("modify");
    if (result.type === "modify")
      expect(parse(result.content).objects![ids.project]).toMatchObject({
        packageReferences: ["SSHCLERK"],
      });
  });

  test.each(["xcodegen", "tuist"] as const)(
    "hands off %s project edits while generating the recipe",
    async (managedBy) => {
      const input = { ...(await fixture()), managedBy };
      const plan = planAppleSetup(input);
      expect(plan.actions[0]?.type).toBe("skip");
      expect(plan.actions.every((action) => action.type === "skip")).toBe(true);
      expect(plan.postInstructions.join("\n")).toContain(
        "https://clerk.com/docs/ios/getting-started/quickstart.md?manual=1",
      );
      expect(plan.postInstructions.join("\n")).toContain(
        `Add Clerk in the ${managedBy} specification`,
      );
    },
  );

  test("new project format and unsupported graph receive manual package instructions", async () => {
    const input = await fixture();
    expect(scaffoldSDK({ ...sdkInput(input), path: "MyApp.xcodeproj/project.xcproj" }).type).toBe(
      "skip",
    );
    mutateGraph(input, (objects) => {
      objects.UNKNOWN = { isa: "PBXFutureType" };
    });
    expect(scaffoldSDK(sdkInput(input)).type).toBe("skip");
  });

  test.each([
    ["CONFIGURATION", "Release"],
    ["PLATFORM_NAME", "watchos"],
    ["PROJECT_FILE_PATH", "/another/App.xcodeproj"],
    ["IS_MACCATALYST", "YES"],
    ["TARGET_NAME", "AnotherTarget"],
    ["PRODUCT_TYPE", "com.apple.product-type.framework"],
  ])("rejects mismatched Xcode context: %s", async (key, value) => {
    const input = await fixture();
    const output = JSON.parse(input.settingsJSON);
    output[0].buildSettings[key!] = value;
    expect(() => selectedSettings(input.selection, JSON.stringify(output))).toThrow();
  });

  test("rejects conflicting settings results, unsupported deployment, and escaping output paths", async () => {
    const input = await fixture();
    const rows = JSON.parse(input.settingsJSON);
    // Xcode can repeat a target with identical settings; only a conflicting repeat is rejected.
    expect(selectedSettings(input.selection, JSON.stringify([...rows, ...rows]))).toBeDefined();
    const conflicting = structuredClone(rows[0]);
    conflicting.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = "com.example.Other";
    expect(() =>
      selectedSettings(input.selection, JSON.stringify([...rows, conflicting])),
    ).toThrow();
    rows[0].buildSettings.IPHONEOS_DEPLOYMENT_TARGET = "16.0";
    expect(() => planAppleSetup({ ...input, settingsJSON: JSON.stringify(rows) })).toThrow(
      "iOS 17",
    );
    expect(() =>
      planAppleSetup({
        ...input,
        selection: { ...input.selection, project: "../Outside.xcodeproj" },
      }),
    ).toThrow("root-relative");
    expect(settingsCommand(input.selection)).toEqual([
      "xcodebuild",
      "-project",
      "MyApp.xcodeproj",
      "-alltargets",
      "-configuration",
      "Debug",
      "-sdk",
      "iphoneos",
      "-showBuildSettings",
      "-json",
      "-disableAutomaticPackageResolution",
    ]);
  });
});

test("pbxproj version diagnosis distinguishes incompatible, uncertain, and sufficient requirements", async () => {
  const input = await installed(await fixture());
  for (const [requirement, expected] of [
    [{ kind: "exactVersion", version: "0.9.0" }, "fail"],
    [{ kind: "versionRange", minimumVersion: "0.8.0", maximumVersion: "1.0.0" }, "fail"],
    [{ kind: "versionRange", minimumVersion: "0.9.0", maximumVersion: "2.0.0" }, "warn"],
    [{ kind: "branch", branch: "main" }, "warn"],
    [{ kind: "upToNextMinorVersion", minimumVersion: "1.1.0" }, "pass"],
  ] as const) {
    mutateGraph(input, (objects) => {
      objects[objects[ids.project].packageReferences[0]].requirement = requirement;
    });
    expect(sdkHealth(input).status).toBe(expected);
  }
});

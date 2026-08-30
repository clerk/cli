import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectIOSProject } from "./inspect.ts";
import {
  inspectIOSPlatformViews,
  iosPlatformViewsSnapshotsEqual,
  type IOSPlatformViewInspector,
} from "./platform-views.ts";
import {
  addIOSFixturePlatformFilteredSource,
  convertIOSFixtureToMultiplatform,
  convertIOSFixtureToPlatformFilteredAppRoots,
  createIOSFixture,
  IOS_FIXTURE_IDS,
} from "./test-helpers.ts";

const roots: string[] = [];

async function fixture(options: Parameters<typeof createIOSFixture>[1] = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-platform-views-"));
  roots.push(root);
  await createIOSFixture(root, { complete: true, includeKey: false, ...options });
  return root;
}

async function audit(root: string, inspector?: IOSPlatformViewInspector) {
  const primary = await inspectIOSProject(root, {
    target: "MyApp",
    exhaustiveContainerDiscovery: true,
  });
  return inspectIOSPlatformViews(primary, inspector);
}

function blockerCodes(result: Awaited<ReturnType<typeof audit>>): string[] {
  return result.status === "blocked" ? result.blockers.map((blocker) => blocker.code) : [];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Apple platform-view audit", () => {
  test("exhaustively snapshots a shared iOS/macOS root and identity without credentials", async () => {
    const root = await fixture();
    await convertIOSFixtureToMultiplatform(root);
    const inlineKey = `pk_test_${Buffer.from("platform-audit.clerk.example$").toString("base64")}`;
    const sourcePath = join(root, "MyApp", "MyAppApp.swift");
    await Bun.write(
      sourcePath,
      (await Bun.file(sourcePath).text()).replace(
        'QuickstartLocalSecrets.load().publishableKey ?? ""',
        `"${inlineKey}"`,
      ),
    );
    const calls: Array<{ platform?: string; exhaustive?: boolean; target?: string }> = [];
    const inspector: IOSPlatformViewInspector = async (input, options) => {
      calls.push({
        platform: options?.platform,
        exhaustive: options?.exhaustiveContainerDiscovery,
        target: options?.target,
      });
      return inspectIOSProject(input, options);
    };

    const result = await audit(root, inspector);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready platform views");
    expect(calls).toEqual([
      { platform: "ios", exhaustive: true, target: IOS_FIXTURE_IDS.appTarget },
      { platform: "macos", exhaustive: true, target: IOS_FIXTURE_IDS.appTarget },
    ]);
    expect(result.snapshot).toMatchObject({
      schemaVersion: 1,
      kind: "clerk-ios-platform-views",
      primaryPlatform: "ios",
      supportedPlatforms: ["ios", "macos"],
      bundleIdentifier: "com.example.myapp",
      appIdPrefix: "LEGACY1234",
      productDecision: "prebuilt",
      requiresClerkKitUI: true,
      requiresAuthViewCompatibility: true,
      sharedEntryPointPath: "MyApp/MyAppApp.swift",
      sharedAppRootPath: "MyApp/MyAppApp.swift",
    });
    expect(result.snapshot.platforms.map((view) => view.platform)).toEqual(["ios", "macos"]);
    const serialized = JSON.stringify(result.snapshot);
    expect(serialized).not.toContain(inlineKey);
    expect(JSON.parse(serialized)).toEqual(result.snapshot);
  });

  test("ignores an unrelated platform-filtered Swift file in the revalidation snapshot", async () => {
    const root = await fixture();
    await convertIOSFixtureToMultiplatform(root);
    const before = await audit(root);
    if (before.status !== "ready") throw new Error("expected initial ready platform views");

    await addIOSFixturePlatformFilteredSource(root, {
      platform: "macos",
      relativePath: "MacDecoration.swift",
      source:
        'import SwiftUI\nstruct MacDecoration: View { var body: some View { Text("Mac") } }\n',
      fileReferenceId: "636363636363636363636363",
      buildFileId: "646464646464646464646464",
    });
    const after = await audit(root);

    expect(after.status).toBe("ready");
    if (after.status !== "ready") throw new Error("expected final ready platform views");
    expect(iosPlatformViewsSnapshotsEqual(before.snapshot, after.snapshot)).toBe(true);
  });

  test("blocks separate platform application roots", async () => {
    const root = await fixture({ clerkSDK: "core-only" });
    await convertIOSFixtureToPlatformFilteredAppRoots(root, {
      iosSource: `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() { Clerk.configure(publishableKey: customKey) }
  var body: some Scene { WindowGroup { Text("iOS") } }
}
`,
      macOSSource: `import ClerkKitUI
import SwiftUI

@main
struct MyAppMac: App {
  var body: some Scene { WindowGroup { AuthView() } }
}
`,
    });

    const result = await audit(root);

    expect(result.status).toBe("blocked");
    expect(blockerCodes(result)).toContain("divergent-app-root");
  });

  test("blocks divergent Clerk setup semantics within a shared application root", async () => {
    const root = await fixture();
    await convertIOSFixtureToMultiplatform(root);
    const sourcePath = join(root, "MyApp", "MyAppApp.swift");
    await Bun.write(
      sourcePath,
      `${await Bun.file(sourcePath).text()}
#if os(macOS)
extension MyApp {
  func configureAgainForMac() {
    Clerk.configure(publishableKey: customKey)
  }
}
#endif
`,
    );

    const result = await audit(root);

    expect(result.status).toBe("blocked");
    expect(blockerCodes(result)).toContain("divergent-swift-semantics");
  });

  test("ignores platform-only callback wiring during semantic revalidation", async () => {
    const root = await fixture();
    await convertIOSFixtureToMultiplatform(root);
    const before = await audit(root);
    if (before.status !== "ready") throw new Error("expected initial ready platform views");
    const sourcePath = join(root, "MyApp", "MyAppApp.swift");
    await Bun.write(
      sourcePath,
      `${await Bun.file(sourcePath).text()}
#if os(macOS)
struct MacCallbackView: View {
  var body: some View {
    Text("Mac").onOpenURL { url in Clerk.shared.handle(url) }
  }
}
#endif
`,
    );

    const after = await audit(root);

    expect(after.status).toBe("ready");
    if (after.status !== "ready") throw new Error("expected callback-only difference to pass");
    expect(iosPlatformViewsSnapshotsEqual(before.snapshot, after.snapshot)).toBe(true);
  });

  test("accepts case-only Bundle ID differences but rejects distinct identities", async () => {
    const caseOnlyRoot = await fixture();
    await convertIOSFixtureToPlatformFilteredAppRoots(caseOnlyRoot, {
      sharedAppRoot: true,
      iosBundleIdentifier: "com.Example.MyApp",
      macOSBundleIdentifier: "COM.EXAMPLE.MYAPP",
    });

    const caseOnly = await audit(caseOnlyRoot);

    expect(caseOnly.status).toBe("ready");
    if (caseOnly.status !== "ready") throw new Error("expected case-only identity to pass");
    expect(caseOnly.snapshot.bundleIdentifier).toBe("com.example.myapp");

    const distinctRoot = await fixture();
    await convertIOSFixtureToPlatformFilteredAppRoots(distinctRoot, {
      sharedAppRoot: true,
      iosBundleIdentifier: "com.example.MyApp.ios",
      macOSBundleIdentifier: "com.example.MyApp.macos",
    });

    const distinct = await audit(distinctRoot);

    expect(distinct.status).toBe("blocked");
    expect(blockerCodes(distinct)).toContain("conflicting-bundle-identifier");
  });

  test("blocks an unresolved secondary platform view", async () => {
    const root = await fixture();
    await convertIOSFixtureToMultiplatform(root);
    const inspector: IOSPlatformViewInspector = async (input, options) => {
      const inspection = await inspectIOSProject(input, options);
      if (options?.platform === "macos") {
        const target = inspection.appTargets.find(
          (candidate) => candidate.id === IOS_FIXTURE_IDS.appTarget,
        );
        if (target) target.platformEvidenceComplete = false;
      }
      return inspection;
    };

    const result = await audit(root, inspector);

    expect(result.status).toBe("blocked");
    expect(result.status === "blocked" ? result.blockers : []).toContainEqual(
      expect.objectContaining({ code: "unresolved-platform", platform: "macos" }),
    );
  });

  test("blocks a secondary view that reports a different supported-platform set", async () => {
    const root = await fixture();
    await convertIOSFixtureToMultiplatform(root);
    const inspector: IOSPlatformViewInspector = async (input, options) => {
      const inspection = await inspectIOSProject(input, options);
      if (options?.platform === "macos") {
        const target = inspection.appTargets.find(
          (candidate) => candidate.id === IOS_FIXTURE_IDS.appTarget,
        );
        if (target) target.supportedPlatforms = ["macos"];
      }
      return inspection;
    };

    const result = await audit(root, inspector);

    expect(blockerCodes(result)).toContain("supported-platforms-changed");
  });

  test("rejects conflicting literal App ID Prefix evidence across platform entitlements", async () => {
    const root = await fixture();
    await convertIOSFixtureToPlatformFilteredAppRoots(root, {
      sharedAppRoot: true,
      iosAppIdPrefix: "LEGACY1234",
      macOSAppIdPrefix: "MODERN5678",
    });

    const result = await audit(root);

    expect(result.status).toBe("blocked");
    expect(blockerCodes(result)).toContain("conflicting-app-id-prefix");
  });
});

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIOSFixture } from "./test-helpers.ts";
import { applyXCProjValue, parseXCProjSource, xcprojTargets } from "./xcproj.ts";
import { convertFixtureToXCProj } from "./setup-test-helpers.ts";
import { applySetup, prepareSetup } from "./workflow.ts";
import { sdkHealth } from "./sdk-health.ts";
import { scaffoldSDK } from "./sdk.ts";
import type { CommandRunner } from "./xcode.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(platform: "ios" | "macos") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-xcproj-candidate-")));
  roots.push(root);
  await createIOSFixture(root, { platform, clerkSDK: false, includeKey: false });
  await convertFixtureToXCProj(root, platform);
  const path = join(root, "MyApp.xcodeproj/project.xcproj");
  // Deliberately synthetic settings; verify-capabilities.ts exercises real Xcode.
  const run: CommandRunner = async (command) =>
    JSON.stringify([
      {
        target: "MyApp",
        buildSettings: {
          TARGET_NAME: "MyApp",
          CONFIGURATION: command[command.indexOf("-configuration") + 1],
          PROJECT_FILE_PATH: join(root, "MyApp.xcodeproj"),
          PRODUCT_TYPE: "com.apple.product-type.application",
          PLATFORM_NAME: platform === "ios" ? "iphoneos" : "macosx",
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          MACOSX_DEPLOYMENT_TARGET: "14.0",
          ENABLE_APP_SANDBOX: platform === "macos" ? "YES" : "NO",
          CODE_SIGN_ENTITLEMENTS: "MyApp/MyApp.entitlements",
        },
      },
    ]);
  const options = {
    root,
    products: "ui" as const,
    minimumVersion: "1.0.0",
    resolvePackages: false,
  };
  return { root, path, options, run };
}

for (const platform of ["ios", "macos"] as const)
  test(`${platform}: .xcproj SDK linkage preserves comments, pins, other targets, and rerun bytes`, async () => {
    const f = await fixture(platform);
    let source = await readFile(f.path, "utf8");
    const original = parseXCProjSource(source).root;
    const other = structuredClone((original.targets as any[])[0]);
    other.id = "OTHER";
    other.name = "Other";
    source = applyXCProjValue(source, ["targets", 1], other).replace(
      '"default-configuration"',
      '// keep this comment\n"default-configuration"',
    );
    await writeFile(f.path, source);
    const preview = await prepareSetup({ ...f.options, target: "MyApp" }, { run: f.run });
    const result = await applySetup(preview);
    expect(result.local).toBe("updated");
    expect(result.handoff.appIntegrationComplete).toBe(false);
    const next = await readFile(f.path, "utf8");
    expect(next).toContain("// keep this comment");
    const root = parseXCProjSource(next).root;
    expect((root.targets as any[])[1]).toEqual(other);
    expect(root.files).toEqual(original.files);
    expect(
      xcprojTargets(root)[0]!.packageProductMembers.map((member) => member["product-name"]),
    ).toEqual(["ClerkKit", "ClerkKitUI"]);
    const pinned = applyXCProjValue(next, ["packages", 0, "version"], { version: "1.2.0" });
    await writeFile(f.path, pinned);
    const rerun = await prepareSetup({ ...f.options, target: "MyApp" }, { run: f.run });
    expect(rerun.sdk.type).toBe("skip");
    expect(rerun.sdkCheck.status).toBe("pass");
    expect((await applySetup(rerun)).local).toBe("unchanged");
    expect(await readFile(f.path, "utf8")).toBe(pinned);
  });

test(".xcproj version diagnosis catches obsolete pins and ranges without rewriting them", async () => {
  const f = await fixture("ios");
  const preview = await prepareSetup(f.options, { run: f.run });
  const action = preview.sdk;
  if (action.type !== "modify") throw new Error("Expected SDK plan");
  for (const [version, expected] of [
    [{ version: "0.9.0" }, "fail"],
    [{ "version-range": "0.8.0..<1.0.0" }, "fail"],
    [{ "version-range-min": "0.9.0", "version-range-max": "2.0.0" }, "warn"],
    [{ branch: "main" }, "warn"],
    [{ "up-to-next-major-version": "1.0.0" }, "pass"],
  ] as const) {
    const source = applyXCProjValue(action.content, ["packages", 0, "version"], version);
    expect(sdkHealth({ ...preview.inspection.input, projectSource: source }).status).toBe(expected);
    if (expected === "fail") {
      await writeFile(f.path, source);
      const obsolete = await prepareSetup(f.options, { run: f.run });
      expect(obsolete.sdk.type).toBe("skip");
      expect(
        (await applySetup(obsolete)).handoff.remaining.some((item) => item.id === "sdk-version"),
      ).toBe(true);
      expect(await readFile(f.path, "utf8")).toBe(source);
    }
  }
});

test(".xcproj ambiguous ownership and conditional links receive manual guidance", async () => {
  const f = await fixture("ios");
  const preview = await prepareSetup(f.options, { run: f.run });
  if (preview.sdk.type !== "modify") throw new Error("Expected SDK plan");
  const input = {
    path: "MyApp.xcodeproj/project.xcproj",
    source: preview.sdk.content,
    targetId: preview.inspection.input.selection.targetId,
    targetName: "MyApp",
    products: "ui" as const,
    minimumVersion: "1.0.0",
    resolvePackages: false,
    managedBy: "xcode" as const,
  };
  for (const source of [
    applyXCProjValue(input.source, ["packages", 0], { kind: "local", path: "../clerk-ios" }),
    applyXCProjValue(
      input.source,
      ["targets", 0, "package-product-members", 0, "build-phase", "platforms"],
      ["ios"],
    ),
    applyXCProjValue(
      input.source,
      ["targets", 0, "package-product-members", 0, "package"],
      undefined,
    ),
  ]) {
    const action = scaffoldSDK({ ...input, source });
    expect(action.type).toBe("skip");
    if (action.type === "skip") expect(action.skipReason).not.toContain("already linked");
  }
});

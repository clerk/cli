import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIOSAppleEntitlement, planIOSAppleEntitlement } from "./apple-entitlement.ts";
import { applyMacOSNetworkCapability, planMacOSNetworkCapability } from "./macos-network.ts";
import { planIOSAssociatedDomain } from "./associated-domain.ts";
import {
  createIOSFixture,
  createIOSJSONFixture,
  IOS_FIXTURE_IDS,
  treeDigest,
} from "./test-helpers.ts";
import { applyXCProjValue } from "./xcproj.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

for (const format of ["pbx", "json"] as const) {
  for (const capability of ["apple", "network"] as const) {
    test.each([
      "<array><string>webcredentials:$(CUSTOM_FAPI)</string></array>",
      "<integer>42</integer>",
    ])(
      `${format} ${capability} preserves an unrelated Associated Domains issue: %s`,
      async (domainValue) => {
        const root = await mkdtemp(join(tmpdir(), "clerk-entitlements-ownership-"));
        roots.push(root);
        if (format === "json") {
          await createIOSJSONFixture(root);
          const projectPath = join(root, "MyApp.xcodeproj", "project.xcproj");
          let project = await Bun.file(projectPath).text();
          project = applyXCProjValue(project, ["build-settings", "SDKROOT"], "macosx");
          project = applyXCProjValue(
            project,
            ["targets", 0, "build-settings", "SUPPORTED_PLATFORMS"],
            "macosx",
          );
          project = applyXCProjValue(
            project,
            ["targets", 0, "build-settings", "MACOSX_DEPLOYMENT_TARGET"],
            "14.0",
          );
          project = applyXCProjValue(
            project,
            ["targets", 0, "build-settings", "ENABLE_APP_SANDBOX"],
            "YES",
          );
          await Bun.write(projectPath, project);
        } else {
          await createIOSFixture(root, { platform: "macos", macOSAppleEntitlement: false });
        }
        const path = join(root, "MyApp", "MyApp.entitlements");
        const domain = `<key>com.apple.developer.associated-domains</key>${domainValue}`;
        await Bun.write(
          path,
          `<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/>${domain}</dict></plist>`,
        );
        const options = {
          root,
          projectPath: "MyApp.xcodeproj",
          targetId: format === "json" ? "C1E000000000000000000001" : IOS_FIXTURE_IDS.appTarget,
          platform: "macos" as const,
        };
        const before = await treeDigest(root);
        const associated = await planIOSAssociatedDomain({
          ...options,
          deferToPublishableKey: true,
        });
        expect(associated.status).toBe("blocked");
        expect(associated.blockers[0]?.message).toContain("Associated Domains");
        expect(await treeDigest(root)).toEqual(before);
        const plan =
          capability === "apple"
            ? await planIOSAppleEntitlement(options)
            : await planMacOSNetworkCapability(options);
        expect(plan.status, JSON.stringify(plan.blockers)).toBe("ready");
        const result =
          capability === "apple"
            ? await applyIOSAppleEntitlement(
                plan as Awaited<ReturnType<typeof planIOSAppleEntitlement>>,
              )
            : await applyMacOSNetworkCapability(
                plan as Awaited<ReturnType<typeof planMacOSNetworkCapability>>,
              );
        expect(result.status).toBe("applied");
        const source = await Bun.file(path).text();
        expect(source).toContain(domain);
        expect(source).toContain(
          capability === "apple"
            ? "com.apple.developer.applesignin"
            : "com.apple.security.network.client",
        );
        const applied = await treeDigest(root);
        const rerun =
          capability === "apple"
            ? await applyIOSAppleEntitlement(await planIOSAppleEntitlement(options))
            : await applyMacOSNetworkCapability(await planMacOSNetworkCapability(options));
        expect(rerun.status).toBe("satisfied");
        expect(await treeDigest(root)).toEqual(applied);
      },
    );
  }
}

for (const capability of ["apple", "network"] as const) {
  test.each(["shared", "unproven"])(
    `${capability} still refuses %s entitlement ownership with an unrelated domain issue`,
    async (ownership) => {
      const root = await mkdtemp(join(tmpdir(), "clerk-entitlements-shared-"));
      roots.push(root);
      await createIOSFixture(root, {
        platform: "macos",
        macOSAppleEntitlement: false,
        secondTarget: true,
      });
      const path = join(root, "MyApp", "MyApp.entitlements");
      await Bun.write(
        path,
        '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/><key>com.apple.developer.associated-domains</key><integer>42</integer></dict></plist>',
      );
      const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
      let project = await Bun.file(projectPath).text();
      for (const id of [IOS_FIXTURE_IDS.secondDebug, IOS_FIXTURE_IDS.secondRelease]) {
        const marker = `${id} = { isa = XCBuildConfiguration; buildSettings = { `;
        project = project.replace(
          marker,
          `${marker}CODE_SIGN_ENTITLEMENTS = ${ownership === "shared" ? "MyApp/MyApp.entitlements" : '"$(UNKNOWN_ENTITLEMENTS)"'}; `,
        );
      }
      await Bun.write(projectPath, project);
      const before = await treeDigest(root);
      const options = {
        root,
        projectPath: "MyApp.xcodeproj",
        targetId: IOS_FIXTURE_IDS.appTarget,
        platform: "macos" as const,
      };
      const result =
        capability === "apple"
          ? await applyIOSAppleEntitlement(await planIOSAppleEntitlement(options))
          : await applyMacOSNetworkCapability(await planMacOSNetworkCapability(options));
      expect(result.status).toBe("blocked");
      expect(result.plan.blockers).toContainEqual(
        expect.objectContaining({
          code: capability === "apple" ? "shared-entitlements" : "unsafe-entitlements",
          message:
            "An entitlements file may be shared with another target, or exclusive ownership could not be proven.",
        }),
      );
      expect(await treeDigest(root)).toEqual(before);
    },
  );
}

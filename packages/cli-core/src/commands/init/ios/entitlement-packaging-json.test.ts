import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectIOSProject } from "./inspect.ts";
import { createIOSJSONFixture, treeDigest } from "./test-helpers.ts";
import { applyXCProjValue, parseXCProjSource, xcprojTargets } from "./xcproj.ts";
import { planIOSAppleEntitlement, applyIOSAppleEntitlement } from "./apple-entitlement.ts";
import { planIOSAssociatedDomain, applyIOSAssociatedDomain } from "./associated-domain.ts";

test.each(["path", "value", "matching"])(
  "JSON entitlements include packaging evidence: %s",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "clerk-json-entitlement-packaging-"));
    try {
      await createIOSJSONFixture(root);
      const path = join(root, "MyApp.xcodeproj/project.xcproj");
      const source = await Bun.file(path).text();
      const target = xcprojTargets(parseXCProjSource(source).root)[0]!;
      await Bun.write(
        path,
        applyXCProjValue(source, ["targets", 0, "build-settings"], {
          ...target.buildSettings,
          CODE_SIGN_ENTITLEMENTS:
            scenario === "path" ? "MyApp/Signing.entitlements" : "MyApp/Other.entitlements",
          "CODE_SIGN_ENTITLEMENTS[arch=arm64]": "MyApp/Other.entitlements",
          "CODE_SIGN_ENTITLEMENTS[arch=x86_64]": "MyApp/Other.entitlements",
          CLERK_DOMAIN: scenario === "value" ? "other.example.test" : "clerk.example.test",
          "CLERK_DOMAIN[arch=arm64]": "clerk.example.test",
          "CLERK_DOMAIN[arch=x86_64]": "clerk.example.test",
        }),
      );
      await Bun.write(
        join(root, "MyApp/Signing.entitlements"),
        '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>',
      );
      const domain = scenario === "value" ? "$(CLERK_DOMAIN)" : "clerk.example.test";
      await Bun.write(
        join(root, "MyApp/Other.entitlements"),
        `<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.developer.applesignin</key><array><string>Default</string></array><key>com.apple.developer.associated-domains</key><array><string>webcredentials:${domain}</string></array></dict></plist>`,
      );
      const before = await treeDigest(root);
      const inspection = await inspectIOSProject(root);
      for (const config of inspection.appTargets[0]!.configurations) {
        expect(config.entitlementsPath.state).toBe(scenario === "path" ? "unresolved" : "resolved");
        if (scenario === "value")
          expect(config.entitlements?.unresolvedAssociatedDomains).toEqual([
            "webcredentials:$(CLERK_DOMAIN)",
          ]);
      }
      const options = { root, projectPath: "MyApp.xcodeproj", targetId: target.id };
      if (scenario !== "value") {
        const apple = await planIOSAppleEntitlement(options);
        expect(apple.status).toBe(scenario === "path" ? "blocked" : "satisfied");
        expect((await applyIOSAppleEntitlement(apple)).status).toBe(apple.status);
      }
      if (scenario !== "matching") {
        const domains = await planIOSAssociatedDomain({ ...options, deferToPublishableKey: true });
        expect(domains.status).toBe("blocked");
        expect((await applyIOSAssociatedDomain(domains)).status).toBe("blocked");
      }
      expect(await treeDigest(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

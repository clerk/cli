import { afterEach, expect, test } from "bun:test";
import { build, parse } from "@bacons/xcode/json";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectIOSProject } from "./inspect.ts";
import { createIOSFixture, IOS_FIXTURE_IDS as IDS, treeDigest } from "./test-helpers.ts";
import { planIOSAssociatedDomain, applyIOSAssociatedDomain } from "./associated-domain.ts";
import { planIOSAppleEntitlement, applyIOSAppleEntitlement } from "./apple-entitlement.ts";
import type { PbxObjects } from "./pbx.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(settings: Record<string, string>, source = "inline") {
  settings = { CLERK_DOMAIN: "clerk.example.test", ...settings };
  const root = await mkdtemp(join(tmpdir(), "clerk-entitlement-packaging-"));
  roots.push(root);
  await createIOSFixture(root, { clerkSDK: false });
  const path = join(root, "MyApp.xcodeproj/project.pbxproj");
  const project = parse(await Bun.file(path).text());
  const objects = project.objects as PbxObjects;
  if (source === "xcconfig") {
    await Bun.write(
      join(root, "Signing.xcconfig"),
      Object.entries(settings)
        .map(([key, value]) => `${key} = ${value}`)
        .join("\n"),
    );
    objects.signing = {
      isa: "PBXFileReference",
      path: "Signing.xcconfig",
      sourceTree: "SOURCE_ROOT",
    };
  }
  for (const id of [IDS.targetDebug, IDS.targetRelease]) {
    const config = objects[id]!;
    const inline = config.buildSettings as Record<string, string>;
    if (source === "xcconfig") {
      config.baseConfigurationReference = "signing";
      for (const key of Object.keys(settings)) delete inline[key];
    } else Object.assign(inline, settings);
  }
  await Bun.write(path, build(project));
  await Bun.write(
    join(root, "MyApp/Signing.entitlements"),
    '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>',
  );
  await Bun.write(
    join(root, "MyApp/Other.entitlements"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.developer.applesignin</key><array><string>Default</string></array><key>com.apple.developer.associated-domains</key><array><string>webcredentials:$(CLERK_DOMAIN)</string></array></dict></plist>',
  );
  return root;
}

for (const source of ["inline", "xcconfig"]) {
  test.each(["MyApp/Signing.entitlements", ""])(
    `${source}: refuses entitlement paths that differ during packaging (%s)`,
    async (packagedPath) => {
      const root = await fixture(
        {
          CODE_SIGN_ENTITLEMENTS: packagedPath,
          "CODE_SIGN_ENTITLEMENTS[arch=arm64]": "MyApp/Other.entitlements",
          "CODE_SIGN_ENTITLEMENTS[arch=x86_64]": "MyApp/Other.entitlements",
        },
        source,
      );
      const target = (await inspectIOSProject(root)).appTargets[0]!;
      for (const c of target.configurations) {
        expect(c.entitlementsPath).toMatchObject({
          state: "unresolved",
          raw: expect.stringContaining("packaging="),
        });
        expect(c.entitlements).toBeUndefined();
      }
    },
  );
  test.each([false, true])(
    `${source}: checks entitlement value expansion during packaging (matching: %s)`,
    async (matching) => {
      const root = await fixture(
        {
          CODE_SIGN_ENTITLEMENTS: "MyApp/Other.entitlements",
          CLERK_DOMAIN: matching ? "clerk.example.test" : "other.example.test",
          "CLERK_DOMAIN[arch=arm64]": "clerk.example.test",
          "CLERK_DOMAIN[arch=x86_64]": "clerk.example.test",
        },
        source,
      );
      const target = (await inspectIOSProject(root)).appTargets[0]!;
      for (const c of target.configurations) {
        expect(c.entitlementsPath).toMatchObject({
          state: "resolved",
          value: "MyApp/Other.entitlements",
        });
        expect(c.entitlements).toMatchObject({
          signInWithApple: true,
          associatedDomains: matching ? ["webcredentials:clerk.example.test"] : [],
          unresolvedAssociatedDomains: matching ? [] : ["webcredentials:$(CLERK_DOMAIN)"],
        });
      }
    },
  );
}

test.each(["path", "value"])(
  "Associated Domains refuses packaging %s conflicts without editing files",
  async (conflict) => {
    const root = await fixture(
      conflict === "path"
        ? {
            CODE_SIGN_ENTITLEMENTS: "MyApp/Signing.entitlements",
            "CODE_SIGN_ENTITLEMENTS[arch=arm64]": "MyApp/Other.entitlements",
            "CODE_SIGN_ENTITLEMENTS[arch=x86_64]": "MyApp/Other.entitlements",
          }
        : {
            CODE_SIGN_ENTITLEMENTS: "MyApp/Other.entitlements",
            CLERK_DOMAIN: "other.example.test",
            "CLERK_DOMAIN[arch=arm64]": "clerk.example.test",
            "CLERK_DOMAIN[arch=x86_64]": "clerk.example.test",
          },
    );
    const before = await treeDigest(root);
    const plan = await planIOSAssociatedDomain({
      root,
      projectPath: "MyApp.xcodeproj",
      targetId: IDS.appTarget,
      deferToPublishableKey: true,
    });
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "unresolved-entitlements" }),
    );
    expect((await applyIOSAssociatedDomain(plan)).status).toBe("blocked");
    expect(await treeDigest(root)).toEqual(before);
  },
);

test.each([false, true])(
  "Apple sign-in requires agreement with the packaging file (matching: %s)",
  async (matching) => {
    const root = await fixture({
      CODE_SIGN_ENTITLEMENTS: matching ? "MyApp/Other.entitlements" : "MyApp/Signing.entitlements",
      "CODE_SIGN_ENTITLEMENTS[arch=arm64]": "MyApp/Other.entitlements",
      "CODE_SIGN_ENTITLEMENTS[arch=x86_64]": "MyApp/Other.entitlements",
    });
    const entitlements = join(root, "MyApp/Other.entitlements");
    await Bun.write(
      entitlements,
      (await Bun.file(entitlements).text()).replace("$(CLERK_DOMAIN)", "clerk.example.test"),
    );
    const before = await treeDigest(root);
    const plan = await planIOSAppleEntitlement({
      root,
      projectPath: "MyApp.xcodeproj",
      targetId: IDS.appTarget,
    });
    expect(plan.status).toBe(matching ? "satisfied" : "blocked");
    expect((await applyIOSAppleEntitlement(plan)).status).toBe(matching ? "satisfied" : "blocked");
    expect(await treeDigest(root)).toEqual(before);
  },
);

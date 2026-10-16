/**
 * Real Xcode resolves what `clerk doctor`'s production checks read: a
 * per-configuration xcconfig key surfaced through an Info.plist entry and a
 * Release-only entitlements file. `#if DEBUG` literals, which doctor doesn't
 * evaluate, report the key as not verified. Uses a fake Clerk API and
 * disposable fixtures.
 *
 * Usage:
 *   bun scripts/apple-setup/verify-production.ts
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, parse } from "@bacons/xcode/json";
import {
  createIOSFixture,
  IOS_FIXTURE_IDS as ids,
} from "../../packages/cli-core/src/commands/init/ios/test-helpers.ts";
import { auditProduction } from "../../packages/cli-core/src/commands/init/ios/production.ts";
import {
  configuredPublishableKey,
  scanSwiftSources,
} from "../../packages/cli-core/src/commands/init/ios/publishable-key.ts";
import type { NativeAPI } from "../../packages/cli-core/src/commands/init/ios/remote.ts";
import { inspectSelectedProject } from "../../packages/cli-core/src/commands/init/ios/xcode.ts";
import { convertFixtureToXCProj } from "../../packages/cli-core/src/commands/init/ios/setup-test-helpers.ts";
import { applyXCProjValue } from "../../packages/cli-core/src/commands/init/ios/xcproj.ts";

const DEV = `pk_test_${btoa("clerk.example.test$")}`;
const LIVE = `pk_live_${btoa("clerk.example.com$")}`;
// An xcconfig line ends at `//`, so the probe's keys must not contain one.
if (DEV.includes("//") || LIVE.includes("//")) throw new Error("Choose fixture keys without //.");

const api: NativeAPI = {
  async fetchApplication(id) {
    return {
      application_id: id,
      instances: [
        { instance_id: "ins_dev", environment_type: "development", publishable_key: DEV },
        { instance_id: "ins_prod", environment_type: "production", publishable_key: LIVE },
      ],
    };
  },
  async getNativeSettings() {
    return { object: "native_settings", api_enabled: true };
  },
  async listIOSApplications() {
    return [
      {
        object: "ios_application",
        id: "ios_1",
        bundle_id: "com.example.MyApp",
        app_id_prefix: "ABCDE12345",
      },
    ];
  },
  async createIOSApplication() {
    throw new Error("The probe must not register applications.");
  },
  async enableNativeApi() {
    throw new Error("The probe must not enable Native API.");
  },
};

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
\t<key>ClerkPublishableKey</key>
\t<string>$(CLERK_PUBLISHABLE_KEY)</string>
</dict></plist>
`;

interface ProbeCase {
  name: string;
  format?: "xcproj";
  xcconfig?: string;
  /** Swift for a second app target that configures Clerk its own way. */
  secondTarget?: string;
  swift: string;
  releaseEntitlements: boolean;
  expected: { registration: string; domain: string; key: string };
  /** Whether Debug's key resolves to the development key, or is reported unresolved. */
  debugKey: "development" | "unresolved";
}

const cases: ProbeCase[] = [
  {
    name: "xcconfig key per configuration through Info.plist; Release-only entitlements with $(CLERK_FAPI_HOST)",
    xcconfig: `CLERK_PUBLISHABLE_KEY = ${DEV}\nCLERK_PUBLISHABLE_KEY[config=Release] = ${LIVE}\nCLERK_FAPI_HOST = clerk.example.test\nCLERK_FAPI_HOST[config=Release] = clerk.example.com\n`,
    swift: `import ClerkKit\nfunc start() { Clerk.configure(publishableKey: Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as! String) }\n`,
    releaseEntitlements: true,
    expected: { registration: "pass", domain: "pass", key: "pass" },
    debugKey: "development",
  },
  {
    name: "#if DEBUG literals (not verified), entitlements shared with Debug, another app target using the dev key",
    secondTarget: `import ClerkKit\nfunc start() { Clerk.configure(publishableKey: "${DEV}") }\n`,
    swift: `import ClerkKit\nfunc start() {\n#if DEBUG\n  Clerk.configure(publishableKey: "${DEV}")\n#else\n  Clerk.configure(publishableKey: "${LIVE}")\n#endif\n}\n`,
    releaseEntitlements: false,
    expected: { registration: "pass", domain: "warn", key: "warn" },
    debugKey: "unresolved",
  },
  {
    name: "Xcode 27 JSON project, #if DEBUG literals (not verified) in a target-membership folder",
    format: "xcproj",
    swift: `import ClerkKit\nfunc start() {\n#if DEBUG\n  Clerk.configure(publishableKey: "${DEV}")\n#else\n  Clerk.configure(publishableKey: "${LIVE}")\n#endif\n}\n`,
    releaseEntitlements: false,
    expected: { registration: "pass", domain: "warn", key: "warn" },
    debugKey: "unresolved",
  },
];

for (const {
  name,
  xcconfig,
  swift,
  releaseEntitlements,
  expected,
  debugKey: debugExpected,
  ...options
} of cases) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-production-probe-")));
  try {
    await createIOSFixture(root, {
      clerkSDK: false,
      includeKey: false,
      secondTarget: options.secondTarget !== undefined,
    });
    await writeFile(join(root, "MyApp/MyAppApp.swift"), swift);
    if (options.secondTarget !== undefined)
      await writeFile(join(root, "AdminApp/AdminAppApp.swift"), options.secondTarget);
    if (options.format) {
      await convertFixtureToXCProj(root, "ios");
      const path = join(root, "MyApp.xcodeproj/project.xcproj");
      await writeFile(
        path,
        applyXCProjValue(
          await readFile(path, "utf8"),
          ["targets", 0, "build-settings", "SWIFT_ACTIVE_COMPILATION_CONDITIONS[config=Debug]"],
          "DEBUG $(inherited)",
        ),
      );
    }
    const path = join(root, "MyApp.xcodeproj/project.pbxproj");
    const document = options.format ? undefined : parse(await readFile(path, "utf8"));
    const objects = (document?.objects ?? {}) as Record<string, any>;
    if (document) {
      // Xcode's own template condition: DEBUG in Debug only.
      objects[ids.targetDebug].buildSettings.SWIFT_ACTIVE_COMPILATION_CONDITIONS =
        "DEBUG $(inherited)";
      if (xcconfig) {
        await mkdir(join(root, "Config"), { recursive: true });
        await writeFile(join(root, "Config/Keys.xcconfig"), xcconfig);
        await writeFile(join(root, "MyApp/Info.plist"), INFO_PLIST);
        objects.KEYSXCCONFIG000000000000 = {
          isa: "PBXFileReference",
          lastKnownFileType: "text.xcconfig",
          path: "Config/Keys.xcconfig",
          sourceTree: "<group>",
        };
        objects[ids.mainGroup].children.push("KEYSXCCONFIG000000000000");
        for (const id of [ids.targetDebug, ids.targetRelease]) {
          objects[id].baseConfigurationReference = "KEYSXCCONFIG000000000000";
          objects[id].buildSettings.INFOPLIST_FILE = "MyApp/Info.plist";
        }
      }
      if (releaseEntitlements) {
        await writeFile(
          join(root, "MyApp/Release.entitlements"),
          `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n\t<key>com.apple.developer.associated-domains</key>\n\t<array><string>webcredentials:$(CLERK_FAPI_HOST)</string></array>\n</dict></plist>\n`,
        );
        objects[ids.targetRelease].buildSettings.CODE_SIGN_ENTITLEMENTS =
          "MyApp/Release.entitlements";
      }
      await writeFile(path, build(document));
    }

    const inspection = await inspectSelectedProject({
      root,
      target: "MyApp",
      products: "core",
      minimumVersion: "1.0.0",
      resolvePackages: false,
    });
    const scan = await scanSwiftSources(inspection);
    const debug = inspection.contexts.find(
      (context) => context.selection.configuration === "Debug",
    )!;
    const debugKey = await configuredPublishableKey(debug, scan);
    if (
      debugExpected === "development"
        ? debugKey.status !== "resolved" || debugKey.key !== DEV
        : debugKey.status !== "unresolved"
    )
      throw new Error(
        `${name}: Debug's key should be ${debugExpected}, got ${JSON.stringify(debugKey)}.`,
      );

    const checks = await auditProduction(inspection, { applicationId: "app_probe" }, api);
    const status = (prefix: string) =>
      checks.find((check) => check.name.startsWith(prefix))?.status;
    const actual = {
      registration: status("Production native registration"),
      domain: status("Production associated domain: Release"),
      key: status("Production publishable key: Release"),
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n${JSON.stringify(checks, null, 2)}`,
      );
    console.log(JSON.stringify({ case: name, ...actual }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

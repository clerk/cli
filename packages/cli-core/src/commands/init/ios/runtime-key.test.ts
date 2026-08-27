import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import plist from "@expo/plist";
import {
  applyIOSRuntimeKey,
  planIOSRuntimeKey,
  planIOSRuntimeKeyVerification,
  type IOSRuntimeKeyBlockerCode,
  verifyIOSRuntimeKey,
} from "./runtime-key.ts";
import { createIOSFixture, IOS_FIXTURE_IDS, treeDigest } from "./test-helpers.ts";

const temporaryDirectories: string[] = [];
const LOADER_FILE = "474747474747474747474747";
const LOADER_BUILD_FILE = "484848484848484848484848";
const TARGET_IGNORE_RULE = "/MyApp/LocalSecrets.plist\n";
const TEMPORARY_IGNORE_RULE = "/MyApp/.LocalSecrets.plist.clerk-*.tmp\n";

function publishableKey(host: string, live = false): string {
  return `pk_${live ? "live" : "test"}_${Buffer.from(`${host}$`).toString("base64")}`;
}

function plistSource(key?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- unrelated data must survive byte-for-byte -->
  <key>ANALYTICS_ENABLED</key>
  <true/>
${key == null ? "" : `  <key>CLERK_PUBLISHABLE_KEY</key>\n  <string>${key}</string>\n`}</dict>
</plist>
`;
}

const APP_SOURCE = `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: ClerkLocalSecrets.load().publishableKey ?? "")
  }

  var body: some Scene {
    WindowGroup { Text("Hello") }
      .environment(Clerk.shared)
  }
}
`;

const LOADER_SOURCE = `import Foundation

struct ClerkLocalSecrets {
  let publishableKey: String?

  static func load(
    bundle: Bundle = .main,
    processInfo: ProcessInfo = .processInfo
  ) -> ClerkLocalSecrets {
    let plistValues = localSecretsPlistValues(bundle: bundle)
    return .init(
      publishableKey: resolveValue(
        for: "CLERK_PUBLISHABLE_KEY",
        processInfo: processInfo,
        plistValues: plistValues
      )
    )
  }

  private static func resolveValue(
    for key: String,
    processInfo: ProcessInfo,
    plistValues: [String: Any]
  ) -> String? {
    if let environmentValue = normalized(processInfo.environment[key]) {
      return environmentValue
    }
    return normalized(plistValues[key] as? String)
  }

  private static func normalized(_ value: String?) -> String? {
    guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
      return nil
    }
    return value
  }

  private static func localSecretsPlistValues(bundle: Bundle) -> [String: Any] {
    guard
      let url = bundle.url(forResource: "LocalSecrets", withExtension: "plist"),
      let data = try? Data(contentsOf: url),
      let propertyList = try? PropertyListSerialization.propertyList(from: data, format: nil),
      let values = propertyList as? [String: Any]
    else {
      return [:]
    }
    return values
  }
}
`;

async function fixture(key?: string, secondTarget = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-runtime-key-"));
  temporaryDirectories.push(root);
  await createIOSFixture(root, {
    complete: false,
    includeKey: false,
    localSecrets: true,
    secondTarget,
  });
  await Bun.write(join(root, "MyApp", "MyAppApp.swift"), APP_SOURCE);
  await Bun.write(join(root, "MyApp", "ClerkLocalSecrets.swift"), LOADER_SOURCE);
  await Bun.write(join(root, "MyApp", "LocalSecrets.plist"), plistSource(key));

  const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
  const project = await Bun.file(projectPath).text();
  await Bun.write(
    projectPath,
    project
      .replace(
        `children = ( ${IOS_FIXTURE_IDS.appFile}, ${IOS_FIXTURE_IDS.localSecretsFile}, );`,
        `children = ( ${IOS_FIXTURE_IDS.appFile}, ${LOADER_FILE}, ${IOS_FIXTURE_IDS.localSecretsFile}, );`,
      )
      .replace(
        `${IOS_FIXTURE_IDS.appFile} = { isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = MyAppApp.swift; sourceTree = "<group>"; };`,
        `${IOS_FIXTURE_IDS.appFile} = { isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = MyAppApp.swift; sourceTree = "<group>"; };\n    ${LOADER_FILE} = { isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ClerkLocalSecrets.swift; sourceTree = "<group>"; };`,
      )
      .replace(
        `files = ( ${IOS_FIXTURE_IDS.sourceBuildFile}, );`,
        `files = ( ${IOS_FIXTURE_IDS.sourceBuildFile}, ${LOADER_BUILD_FILE}, );`,
      )
      .replace(
        `${IOS_FIXTURE_IDS.sourceBuildFile} = { isa = PBXBuildFile; fileRef = ${IOS_FIXTURE_IDS.appFile}; };`,
        `${IOS_FIXTURE_IDS.sourceBuildFile} = { isa = PBXBuildFile; fileRef = ${IOS_FIXTURE_IDS.appFile}; };\n    ${LOADER_BUILD_FILE} = { isa = PBXBuildFile; fileRef = ${LOADER_FILE}; };`,
      ),
  );
  return root;
}

async function shareLocalSecretsWithSecondTarget(root: string, productType: string): Promise<void> {
  const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
  const project = await Bun.file(projectPath).text();
  await Bun.write(
    projectPath,
    project
      .replace(
        `buildPhases = ( ${IOS_FIXTURE_IDS.secondSourcesPhase}, ${IOS_FIXTURE_IDS.secondFrameworksPhase}, );`,
        `buildPhases = ( ${IOS_FIXTURE_IDS.secondSourcesPhase}, ${IOS_FIXTURE_IDS.secondFrameworksPhase}, ${IOS_FIXTURE_IDS.resourcesPhase}, );`,
      )
      .replace(
        `productReference = ${IOS_FIXTURE_IDS.secondProduct};\n      productType = "com.apple.product-type.application";`,
        `productReference = ${IOS_FIXTURE_IDS.secondProduct};\n      productType = "${productType}";`,
      ),
  );
}

function options(root: string) {
  return {
    root,
    projectPath: "MyApp.xcodeproj",
    targetId: IOS_FIXTURE_IDS.appTarget,
  };
}

async function run(root: string, key: string) {
  const plan = await planIOSRuntimeKey(options(root));
  const result = await applyIOSRuntimeKey(plan, key);
  return { plan, result };
}

async function initGit(root: string): Promise<void> {
  const child = Bun.spawn(["git", "init", "--quiet"], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await child.exited) !== 0) {
    throw new Error(await new Response(child.stderr).text());
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("iOS runtime publishable-key transaction", () => {
  test("verifies an existing runtime key without retaining either compared value", async () => {
    const localKey = publishableKey("verify-local.clerk.example");
    const linkedKey = publishableKey("verify-linked.clerk.example");
    const root = await fixture(localKey);
    const plan = await planIOSRuntimeKeyVerification(options(root));

    const matched = await verifyIOSRuntimeKey(plan, localKey);
    const mismatched = await verifyIOSRuntimeKey(plan, linkedKey);

    expect(plan.status).toBe("ready");
    expect(matched.status).toBe("matched");
    expect(mismatched.status).toBe("mismatched");
    expect(JSON.stringify({ plan, matched, mismatched })).not.toContain(localKey);
    expect(JSON.stringify({ plan, matched, mismatched })).not.toContain(linkedKey);
  });

  test("treats the same valid key in an ignored target sink as a byte-for-byte no-op", async () => {
    const key = publishableKey("same.clerk.example");
    const root = await fixture(key);
    await Bun.write(join(root, ".gitignore"), "/MyApp/LocalSecrets.plist\n");
    const before = await treeDigest(root);

    const { plan, result } = await run(root, key);

    expect(plan.status).toBe("ready");
    expect(result.status).toBe("satisfied");
    expect(await treeDigest(root)).toEqual(before);
    expect(JSON.stringify({ plan, result })).not.toContain(key);
  });

  test("replaces an invalid placeholder while preserving unrelated XML bytes", async () => {
    const root = await fixture("pk_test_...");
    const key = publishableKey("replacement.clerk.example");
    const path = join(root, "MyApp", "LocalSecrets.plist");
    const before = await Bun.file(path).text();

    const { plan, result } = await run(root, key);
    const after = await Bun.file(path).text();

    expect(result.status).toBe("applied");
    expect(after).toBe(before.replace("pk_test_...", key));
    expect(await Bun.file(join(root, ".gitignore")).text()).toBe(
      TEMPORARY_IGNORE_RULE + TARGET_IGNORE_RULE,
    );
    expect(JSON.stringify({ plan, result })).not.toContain(key);
  });

  test("plans a gitignore change for crash-safe staging even when the target rule exists", async () => {
    const root = await fixture("pk_test_...");
    await Bun.write(join(root, ".gitignore"), TARGET_IGNORE_RULE);

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("ready");
    expect(plan.changesGitignore).toBe(true);
    expect(plan.actions.some((action) => action.includes("atomic-write staging file"))).toBe(true);
  });

  test("inserts a missing key without changing unrelated plist values", async () => {
    const root = await fixture();
    const key = publishableKey("insert.clerk.example");
    const path = join(root, "MyApp", "LocalSecrets.plist");

    const { result } = await run(root, key);
    const source = await Bun.file(path).text();
    const parsed = plist.parse(source) as Record<string, unknown>;

    expect(result.status).toBe("applied");
    expect(parsed.ANALYTICS_ENABLED).toBe(true);
    expect(parsed.CLERK_PUBLISHABLE_KEY).toBe(key);
    expect(source).toContain("<!-- unrelated data must survive byte-for-byte -->");
  });

  test("does not insert a duplicate semantic key when its XML spelling is encoded", async () => {
    const root = await fixture("pk_test_...");
    const path = join(root, "MyApp", "LocalSecrets.plist");
    await Bun.write(
      path,
      plistSource("pk_test_...").replace("CLERK_PUBLISHABLE_KEY", "CLERK_PUBLISHABLE_&#75;EY"),
    );
    const before = await treeDigest(root);
    const plan = await planIOSRuntimeKey(options(root));

    const result = await applyIOSRuntimeKey(plan, publishableKey("encoded-key.clerk.example"));

    expect(result.status).toBe("blocked");
    expect(result.plan.blockers[0]?.code).toBe("unsupported-local-secrets");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("blocks a different valid key without writing any file", async () => {
    const existingKey = publishableKey("existing.clerk.example");
    const replacementKey = publishableKey("different.clerk.example");
    const root = await fixture(existingKey);
    const before = await treeDigest(root);

    const { plan, result } = await run(root, replacementKey);

    expect(result.status).toBe("blocked");
    expect(result.plan.blockers[0]?.code).toBe("different-publishable-key");
    expect(await treeDigest(root)).toEqual(before);
    const serialized = JSON.stringify({ plan, result });
    expect(serialized).not.toContain(existingKey);
    expect(serialized).not.toContain(replacementKey);
  });

  test("blocks invalid apply input without exposing it", async () => {
    const root = await fixture("pk_test_...");
    const plan = await planIOSRuntimeKey(options(root));
    const invalid = "pk_test_not-a-real-key";

    const result = await applyIOSRuntimeKey(plan, invalid);

    expect(result.status).toBe("blocked");
    expect(result.plan.blockers[0]?.code).toBe("invalid-publishable-key");
    expect(JSON.stringify(result)).not.toContain(invalid);
  });

  test("blocks a production publishable key without exposing it", async () => {
    const root = await fixture("pk_test_...");
    const plan = await planIOSRuntimeKey(options(root));
    const productionKey = publishableKey("production.clerk.example", true);

    const result = await applyIOSRuntimeKey(plan, productionKey);

    expect(result.status).toBe("blocked");
    expect(result.plan.blockers[0]?.code).toBe("production-publishable-key");
    expect(JSON.stringify(result)).not.toContain(productionKey);
  });

  test("adds only the ignore rule when an existing valid key is not ignored", async () => {
    const key = publishableKey("ignore-only.clerk.example");
    const root = await fixture(key);
    const plistBefore = await Bun.file(join(root, "MyApp", "LocalSecrets.plist")).text();

    const { result } = await run(root, key);

    expect(result.status).toBe("applied");
    expect(await Bun.file(join(root, "MyApp", "LocalSecrets.plist")).text()).toBe(plistBefore);
    expect(await Bun.file(join(root, ".gitignore")).text()).toBe("/MyApp/LocalSecrets.plist\n");
  });

  test("normalizes surrounding whitespace in an otherwise matching key", async () => {
    const key = publishableKey("normalized.clerk.example");
    const root = await fixture(`  ${key}\n`);

    const { result } = await run(root, key);

    expect(result.status).toBe("applied");
    expect(await Bun.file(join(root, "MyApp", "LocalSecrets.plist")).text()).toContain(
      `<string>${key}</string>`,
    );
  });

  test("adds a portable exact rule even when a broader Git pattern already ignores the sink", async () => {
    const root = await fixture("pk_test_...");
    await initGit(root);
    await Bun.write(join(root, ".gitignore"), "**/LocalSecrets.plist\n");
    const key = publishableKey("broad-ignore.clerk.example");

    const { result } = await run(root, key);

    expect(result.status).toBe("applied");
    expect(await Bun.file(join(root, ".gitignore")).text()).toBe(
      `**/LocalSecrets.plist\n${TEMPORARY_IGNORE_RULE}${TARGET_IGNORE_RULE}`,
    );
  });

  test("does not treat whitespace around a rule as the exact portable rule", async () => {
    const root = await fixture("pk_test_...");
    await Bun.write(join(root, ".gitignore"), " /MyApp/LocalSecrets.plist\n");
    const key = publishableKey("whitespace-rule.clerk.example");

    const { result } = await run(root, key);

    expect(result.status).toBe("applied");
    expect(await Bun.file(join(root, ".gitignore")).text()).toBe(
      ` /MyApp/LocalSecrets.plist\n${TEMPORARY_IGNORE_RULE}${TARGET_IGNORE_RULE}`,
    );
  });

  test("appends the exact rule after a later negation before reporting satisfaction", async () => {
    for (const repository of [false, true]) {
      const key = publishableKey(`${repository ? "git" : "plain"}-negated.clerk.example`);
      const root = await fixture(key);
      if (repository) await initGit(root);
      await Bun.write(
        join(root, ".gitignore"),
        "/MyApp/LocalSecrets.plist\n!/MyApp/LocalSecrets.plist\n",
      );

      const { result } = await run(root, key);

      expect(result.status).toBe("applied");
      expect(await Bun.file(join(root, ".gitignore")).text()).toBe(
        "/MyApp/LocalSecrets.plist\n!/MyApp/LocalSecrets.plist\n/MyApp/LocalSecrets.plist\n",
      );
      if (repository) {
        const check = Bun.spawn(
          ["git", "check-ignore", "--quiet", "--no-index", "--", "MyApp/LocalSecrets.plist"],
          { cwd: root, stdout: "ignore", stderr: "ignore" },
        );
        expect(await check.exited).toBe(0);
      }
    }
  });

  test("blocks nested gitignore files that can override the root protection", async () => {
    for (const repository of [false, true]) {
      const root = await fixture("pk_test_...");
      if (repository) await initGit(root);
      await Bun.write(
        join(root, "MyApp", ".gitignore"),
        "!LocalSecrets.plist\n!.LocalSecrets.plist.clerk-*.tmp\n",
      );
      const before = await treeDigest(root);

      const plan = await planIOSRuntimeKey(options(root));

      expect(plan.status).toBe("blocked");
      expect(plan.blockers[0]?.code).toBe("unsafe-gitignore");
      expect(await treeDigest(root)).toEqual(before);
    }
  });

  test("blocks a LocalSecrets.plist already tracked by Git", async () => {
    const root = await fixture("pk_test_...");
    await initGit(root);
    const add = Bun.spawn(["git", "add", "--", "MyApp/LocalSecrets.plist"], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await add.exited).toBe(0);
    const before = await treeDigest(root);

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("tracked-local-secrets");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("blocks every enabled selected-target Run-scheme override", async () => {
    for (const schemeKey of [
      publishableKey("same-scheme.clerk.example"),
      publishableKey("other-scheme.clerk.example"),
    ]) {
      const root = await fixture("pk_test_...");
      const directory = join(root, "MyApp.xcodeproj", "xcshareddata", "xcschemes");
      await mkdir(directory, { recursive: true });
      await Bun.write(
        join(directory, "MyApp.xcscheme"),
        `<Scheme><LaunchAction><BuildableProductRunnable><BuildableReference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}" ReferencedContainer="container:MyApp.xcodeproj" /></BuildableProductRunnable><EnvironmentVariables><EnvironmentVariable key="CLERK_PUBLISHABLE_KEY" value="${schemeKey}" isEnabled="YES" /></EnvironmentVariables></LaunchAction></Scheme>`,
      );

      const plan = await planIOSRuntimeKey(options(root));

      expect(plan.status).toBe("blocked");
      expect(plan.blockers[0]?.code).toBe("scheme-override");
      expect(JSON.stringify(plan)).not.toContain(schemeKey);
    }
  });

  test("blocks malformed, binary, oversized, and symlinked sinks", async () => {
    const cases: Array<{
      expected: IOSRuntimeKeyBlockerCode;
      mutate(root: string): Promise<void>;
    }> = [
      {
        expected: "malformed-local-secrets",
        mutate: async (root) => {
          await Bun.write(join(root, "MyApp", "LocalSecrets.plist"), "<plist><dict>");
        },
      },
      {
        expected: "malformed-local-secrets",
        mutate: async (root) => {
          await Bun.write(
            join(root, "MyApp", "LocalSecrets.plist"),
            new Uint8Array([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30]),
          );
        },
      },
      {
        expected: "unreadable-local-secrets",
        mutate: async (root) => {
          await Bun.write(join(root, "MyApp", "LocalSecrets.plist"), "x".repeat(1_000_001));
        },
      },
      {
        expected: "unreadable-local-secrets",
        mutate: async (root) => {
          const path = join(root, "MyApp", "LocalSecrets.plist");
          const outside = join(root, "outside.plist");
          await Bun.write(outside, plistSource("pk_test_..."));
          await rm(path);
          await symlink(outside, path);
        },
      },
    ];

    for (const item of cases) {
      const root = await fixture("pk_test_...");
      await item.mutate(root);
      const before = await treeDigest(root);

      const plan = await planIOSRuntimeKey(options(root));

      expect(plan.status).toBe("blocked");
      expect(plan.blockers[0]?.code).toBe(item.expected);
      expect(await treeDigest(root)).toEqual(before);
    }
  });

  test("blocks a generated project and an explicitly selected non-target resource", async () => {
    const generatedRoot = await fixture("pk_test_...");
    await Bun.write(join(generatedRoot, "project.yml"), "name: MyApp\n");
    const generatedPlan = await planIOSRuntimeKey(options(generatedRoot));
    expect(generatedPlan.blockers[0]?.code).toBe("generated-project");

    const root = await fixture("pk_test_...");
    await mkdir(join(root, "NotTarget"));
    await Bun.write(join(root, "NotTarget", "LocalSecrets.plist"), plistSource("pk_test_..."));
    const plan = await planIOSRuntimeKey({
      ...options(root),
      localSecretsPath: "NotTarget/LocalSecrets.plist",
    });
    expect(plan.blockers[0]?.code).toBe("not-target-resource");
  });

  test("blocks a generator marker beside a nested selected project", async () => {
    const root = await fixture("pk_test_...");
    await mkdir(join(root, "ios"));
    await rename(join(root, "MyApp.xcodeproj"), join(root, "ios", "MyApp.xcodeproj"));
    await rename(join(root, "MyApp"), join(root, "ios", "MyApp"));
    await Bun.write(join(root, "ios", "project.yml"), "name: MyApp\n");

    const plan = await planIOSRuntimeKey({
      root,
      projectPath: "ios/MyApp.xcodeproj",
      targetId: IOS_FIXTURE_IDS.appTarget,
    });

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("generated-project");
  });

  test("blocks an invocation root above the selected project's nested Git repository", async () => {
    const root = await fixture("pk_test_...");
    const nested = join(root, "Nested");
    await mkdir(nested);
    await rename(join(root, "MyApp.xcodeproj"), join(nested, "MyApp.xcodeproj"));
    await rename(join(root, "MyApp"), join(nested, "MyApp"));
    await initGit(nested);

    const plan = await planIOSRuntimeKey({
      root,
      projectPath: "Nested/MyApp.xcodeproj",
      targetId: IOS_FIXTURE_IDS.appTarget,
    });

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("git-repository-mismatch");
    expect(await Bun.file(join(root, ".gitignore")).exists()).toBe(false);
  });

  test("requires exact entrypoint, configure, loader, and sink proof", async () => {
    const root = await fixture("pk_test_...");
    await Bun.write(join(root, "MyApp", "ClerkLocalSecrets.swift"), "import Foundation\n");

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("unproven-runtime-wiring");
  });

  test("does not treat a same-file unused configure helper as app-startup wiring", async () => {
    const root = await fixture("pk_test_...");
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      APP_SOURCE.replace(
        `  init() {
    Clerk.configure(publishableKey: ClerkLocalSecrets.load().publishableKey ?? "")
  }`,
        `  init() {}

  func unusedConfigureHelper() {
    Clerk.configure(publishableKey: ClerkLocalSecrets.load().publishableKey ?? "")
  }`,
      ),
    );

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("unproven-runtime-wiring");
  });

  test("blocks a LocalSecrets resource shared by another iOS application target", async () => {
    const root = await fixture("pk_test_...", true);
    await shareLocalSecretsWithSecondTarget(root, "com.apple.product-type.application");
    const before = await treeDigest(root);

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("shared-local-secrets");
    expect(await treeDigest(root)).toEqual(before);
  });

  test.each([
    ["app extension", "com.apple.product-type.app-extension"],
    ["unit-test bundle", "com.apple.product-type.bundle.unit-test"],
  ])("blocks a LocalSecrets resource shared by another %s target", async (_name, productType) => {
    const root = await fixture("pk_test_...", true);
    await shareLocalSecretsWithSecondTarget(root, productType);

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("shared-local-secrets");
  });

  test("blocks a LocalSecrets resource owned by a deep project with the same target ID", async () => {
    const root = await fixture("pk_test_...");
    const otherRoot = join(root, "a", "b", "c", "d");
    await createIOSFixture(otherRoot, {
      complete: false,
      includeKey: false,
      localSecrets: true,
    });
    const otherProjectPath = join(otherRoot, "MyApp.xcodeproj", "project.pbxproj");
    const otherProject = (await Bun.file(otherProjectPath).text()).replace(
      `path = LocalSecrets.plist; sourceTree = "<group>";`,
      `path = "${join(root, "MyApp", "LocalSecrets.plist")}"; sourceTree = "<absolute>";`,
    );
    await Bun.write(otherProjectPath, otherProject);

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("shared-local-secrets");
  });

  test("allows a sibling target's proven-disjoint external synchronized group", async () => {
    const root = await fixture("pk_test_...", true);
    const externalGroup = await mkdtemp(join(tmpdir(), "clerk-ios-external-group-"));
    temporaryDirectories.push(externalGroup);
    await Bun.write(join(externalGroup, "ExternalApp.swift"), "import SwiftUI\n");

    const synchronizedGroupId = "515151515151515151515151";
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const project = await Bun.file(projectPath).text();
    await Bun.write(
      projectPath,
      project
        .replace(
          `productType = "com.apple.product-type.application";\n      packageProductDependencies = ( );`,
          `productType = "com.apple.product-type.application";\n      fileSystemSynchronizedGroups = ( ${synchronizedGroupId}, );\n      packageProductDependencies = ( );`,
        )
        .replace(
          `${IOS_FIXTURE_IDS.projectConfigList} = { isa = XCConfigurationList;`,
          `${synchronizedGroupId} = { isa = PBXFileSystemSynchronizedRootGroup; path = "${externalGroup}"; sourceTree = "<absolute>"; };\n    ${IOS_FIXTURE_IDS.projectConfigList} = { isa = XCConfigurationList;`,
        ),
    );

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("ready");
    expect(plan.blockers).toEqual([]);
  });

  test("fails closed when a discovered local project is unreadable", async () => {
    const root = await fixture("pk_test_...");
    await mkdir(join(root, "Unrelated.xcodeproj"));

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("shared-local-secrets");
  });

  test("fails closed when a discovered workspace is unreadable", async () => {
    const root = await fixture("pk_test_...");
    await mkdir(join(root, "Unreadable.xcworkspace"));

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("shared-local-secrets");
  });

  test("blocks an external symlinked resource that aliases the selected sink", async () => {
    const root = await fixture("pk_test_...", true);
    const externalGroup = await mkdtemp(join(tmpdir(), "clerk-ios-external-alias-"));
    temporaryDirectories.push(externalGroup);
    const externalAlias = join(externalGroup, "LocalSecrets.plist");
    await symlink(join(root, "MyApp", "LocalSecrets.plist"), externalAlias);

    const externalReferenceId = "525252525252525252525252";
    const externalBuildFileId = "535353535353535353535353";
    const externalResourcesPhaseId = "545454545454545454545454";
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const project = await Bun.file(projectPath).text();
    await Bun.write(
      projectPath,
      project
        .replace(
          `buildPhases = ( ${IOS_FIXTURE_IDS.secondSourcesPhase}, ${IOS_FIXTURE_IDS.secondFrameworksPhase}, );`,
          `buildPhases = ( ${IOS_FIXTURE_IDS.secondSourcesPhase}, ${IOS_FIXTURE_IDS.secondFrameworksPhase}, ${externalResourcesPhaseId}, );`,
        )
        .replace(
          `${IOS_FIXTURE_IDS.projectConfigList} = { isa = XCConfigurationList;`,
          `${externalReferenceId} = { isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = "${externalAlias}"; sourceTree = "<absolute>"; };\n    ${externalBuildFileId} = { isa = PBXBuildFile; fileRef = ${externalReferenceId}; };\n    ${externalResourcesPhaseId} = { isa = PBXResourcesBuildPhase; files = ( ${externalBuildFileId}, ); };\n    ${IOS_FIXTURE_IDS.projectConfigList} = { isa = XCConfigurationList;`,
        ),
    );
    const before = await treeDigest(root);

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("shared-local-secrets");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("fails closed when selected-project resource membership is dangling", async () => {
    const root = await fixture("pk_test_...", true);
    const danglingResourcesPhaseId = "555555555555555555555555";
    const danglingBuildFileId = "565656565656565656565656";
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const project = await Bun.file(projectPath).text();
    await Bun.write(
      projectPath,
      project
        .replace(
          `buildPhases = ( ${IOS_FIXTURE_IDS.secondSourcesPhase}, ${IOS_FIXTURE_IDS.secondFrameworksPhase}, );`,
          `buildPhases = ( ${IOS_FIXTURE_IDS.secondSourcesPhase}, ${IOS_FIXTURE_IDS.secondFrameworksPhase}, ${danglingResourcesPhaseId}, );`,
        )
        .replace(
          `${IOS_FIXTURE_IDS.projectConfigList} = { isa = XCConfigurationList;`,
          `${danglingResourcesPhaseId} = { isa = PBXResourcesBuildPhase; files = ( ${danglingBuildFileId}, ); };\n    ${IOS_FIXTURE_IDS.projectConfigList} = { isa = XCConfigurationList;`,
        ),
    );
    const before = await treeDigest(root);

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("shared-local-secrets");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("rejects stale plist and gitignore plans without overwriting newer bytes", async () => {
    const plistRoot = await fixture("pk_test_...");
    const plistPlan = await planIOSRuntimeKey(options(plistRoot));
    const plistPath = join(plistRoot, "MyApp", "LocalSecrets.plist");
    await appendFile(plistPath, "\n<!-- newer plist edit -->\n");
    const newerPlist = await Bun.file(plistPath).text();

    const plistResult = await applyIOSRuntimeKey(
      plistPlan,
      publishableKey("stale-plist.clerk.example"),
    );
    expect(plistResult.status).toBe("stale");
    expect(await Bun.file(plistPath).text()).toBe(newerPlist);

    const ignoreRoot = await fixture("pk_test_...");
    await Bun.write(join(ignoreRoot, ".gitignore"), "build/\n");
    const ignorePlan = await planIOSRuntimeKey(options(ignoreRoot));
    await appendFile(join(ignoreRoot, ".gitignore"), "DerivedData/\n");
    const newerIgnore = await Bun.file(join(ignoreRoot, ".gitignore")).text();

    const ignoreResult = await applyIOSRuntimeKey(
      ignorePlan,
      publishableKey("stale-ignore.clerk.example"),
    );
    expect(ignoreResult.status).toBe("stale");
    expect(await Bun.file(join(ignoreRoot, ".gitignore")).text()).toBe(newerIgnore);
  });

  test("rolls back every committed file byte-for-byte after validation failure", async () => {
    const root = await fixture("pk_test_...");
    const before = await treeDigest(root);
    const plan = await planIOSRuntimeKey(options(root));

    const result = await applyIOSRuntimeKey(plan, publishableKey("rollback.clerk.example"), {
      forcePostWriteValidationFailure: true,
    });

    expect(result.status).toBe("rolled-back");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("rolls back when concurrent Swift edits invalidate the proven runtime wiring", async () => {
    const root = await fixture("pk_test_...");
    const plistPath = join(root, "MyApp", "LocalSecrets.plist");
    const plistBefore = await Bun.file(plistPath).text();
    const plan = await planIOSRuntimeKey(options(root));

    const result = await applyIOSRuntimeKey(
      plan,
      publishableKey("concurrent-swift.clerk.example"),
      {
        beforePostWriteValidation: async () => {
          await Bun.write(
            join(root, "MyApp", "MyAppApp.swift"),
            APP_SOURCE.replace("Clerk.configure", "Clerk.notConfigure"),
          );
        },
      },
    );

    expect(result.status).toBe("rolled-back");
    expect(await Bun.file(plistPath).text()).toBe(plistBefore);
    expect(await Bun.file(join(root, ".gitignore")).exists()).toBe(false);
  });

  test("rolls back when a nested gitignore appears before post-write validation", async () => {
    const root = await fixture("pk_test_...");
    const plistPath = join(root, "MyApp", "LocalSecrets.plist");
    const plistBefore = await Bun.file(plistPath).text();
    const plan = await planIOSRuntimeKey(options(root));

    const result = await applyIOSRuntimeKey(
      plan,
      publishableKey("concurrent-nested-ignore.clerk.example"),
      {
        beforePostWriteValidation: async () => {
          await Bun.write(
            join(root, "MyApp", ".gitignore"),
            "!LocalSecrets.plist\n!.LocalSecrets.plist.clerk-*.tmp\n",
          );
        },
      },
    );

    expect(result.status).toBe("rolled-back");
    expect(await Bun.file(plistPath).text()).toBe(plistBefore);
    expect(await Bun.file(join(root, ".gitignore")).exists()).toBe(false);
    expect(await Bun.file(join(root, "MyApp", ".gitignore")).text()).toContain(
      "!LocalSecrets.plist",
    );
  });

  test("rolls back when a sibling target concurrently begins owning the runtime sink", async () => {
    const root = await fixture("pk_test_...", true);
    const plistPath = join(root, "MyApp", "LocalSecrets.plist");
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const plistBefore = await Bun.file(plistPath).text();
    const plan = await planIOSRuntimeKey(options(root));

    const result = await applyIOSRuntimeKey(
      plan,
      publishableKey("concurrent-owner.clerk.example"),
      {
        beforePostWriteValidation: async () => {
          const project = await Bun.file(projectPath).text();
          await Bun.write(
            projectPath,
            project.replace(
              `buildPhases = ( ${IOS_FIXTURE_IDS.secondSourcesPhase}, ${IOS_FIXTURE_IDS.secondFrameworksPhase}, );`,
              `buildPhases = ( ${IOS_FIXTURE_IDS.secondSourcesPhase}, ${IOS_FIXTURE_IDS.secondFrameworksPhase}, ${IOS_FIXTURE_IDS.resourcesPhase}, );`,
            ),
          );
        },
      },
    );

    expect(result.status).toBe("rolled-back");
    expect(await Bun.file(plistPath).text()).toBe(plistBefore);
    expect(await Bun.file(join(root, ".gitignore")).exists()).toBe(false);
  });

  test("cleans every temporary file when plist staging fails after creation", async () => {
    const root = await fixture("pk_test_...");
    const before = await treeDigest(root);
    const plan = await planIOSRuntimeKey(options(root));

    const result = await applyIOSRuntimeKey(plan, publishableKey("stage-fail.clerk.example"), {
      forcePlistStageFailureAfterCreate: true,
    });

    expect(result.status).toBe("rolled-back");
    expect(await treeDigest(root)).toEqual(before);
    for (const directory of [root, join(root, "MyApp")]) {
      expect((await readdir(directory)).some((name) => name.includes(".clerk-"))).toBe(false);
    }
  });

  test("retains the ignore guard when a staged key temp cannot be cleaned before rollback", async () => {
    const root = await fixture("pk_test_...");
    const plan = await planIOSRuntimeKey(options(root));
    const key = publishableKey("stale-temp-cleanup.clerk.example");
    const plistPath = join(root, "MyApp", "LocalSecrets.plist");

    const apply = applyIOSRuntimeKey(plan, key, {
      forcePlistCleanupFailureBeforeCommit: true,
      afterPlistStage: async () => {
        await appendFile(plistPath, "\n<!-- concurrent edit -->\n");
      },
    });

    await expect(apply).rejects.toThrow("temporary runtime-key file could not be removed");
    expect(await Bun.file(join(root, ".gitignore")).text()).toBe(
      TEMPORARY_IGNORE_RULE + TARGET_IGNORE_RULE,
    );
    expect(await Bun.file(plistPath).text()).not.toContain(key);
    for (const directory of [root, join(root, "MyApp")]) {
      expect((await readdir(directory)).some((name) => name.includes(".clerk-"))).toBe(false);
    }
  });

  test("commits and verifies the temporary-file guard before writing key bytes", async () => {
    const root = await fixture("pk_test_...");
    await initGit(root);
    const plan = await planIOSRuntimeKey(options(root));
    let guardObserved = false;

    const result = await applyIOSRuntimeKey(plan, publishableKey("guard-first.clerk.example"), {
      beforePlistWrite: async (temporaryPath) => {
        expect(await Bun.file(temporaryPath).text()).toBe("");
        expect(await Bun.file(join(root, ".gitignore")).text()).toBe(
          TEMPORARY_IGNORE_RULE + TARGET_IGNORE_RULE,
        );
        const check = Bun.spawn(
          ["git", "check-ignore", "--quiet", "--no-index", "--", relative(root, temporaryPath)],
          { cwd: root, stdout: "ignore", stderr: "ignore" },
        );
        expect(await check.exited).toBe(0);
        guardObserved = true;
      },
    });

    expect(result.status).toBe("applied");
    expect(guardObserved).toBe(true);
  });

  test("never writes key bytes when the committed guard is negated before plist staging", async () => {
    const root = await fixture("pk_test_...");
    const key = publishableKey("guard-negated-before-write.clerk.example");
    const plan = await planIOSRuntimeKey(options(root));
    const result = await applyIOSRuntimeKey(plan, key, {
      beforePlistWrite: async (temporaryPath) => {
        const relativeTemporaryPath = relative(root, temporaryPath).split("\\").join("/");
        await appendFile(
          join(root, ".gitignore"),
          `!/${relativeTemporaryPath}\n!/MyApp/LocalSecrets.plist\n`,
        );
      },
    });

    expect(["stale", "rolled-back"]).toContain(result.status);
    expect(await Bun.file(join(root, "MyApp", "LocalSecrets.plist")).text()).not.toContain(key);
    for (const name of await readdir(join(root, "MyApp"))) {
      if (name.includes(".clerk-") && (await Bun.file(join(root, "MyApp", name)).exists())) {
        expect(await Bun.file(join(root, "MyApp", name)).text()).not.toContain(key);
      }
    }
  });

  test("rolls back when the committed guard is negated after plist staging", async () => {
    const root = await fixture("pk_test_...");
    const key = publishableKey("guard-negated-after-stage.clerk.example");
    const plan = await planIOSRuntimeKey(options(root));
    const result = await applyIOSRuntimeKey(plan, key, {
      afterPlistStage: async () => {
        const temporaryName = (await readdir(join(root, "MyApp"))).find((name) =>
          name.includes(".clerk-"),
        );
        expect(temporaryName).toBeDefined();
        await appendFile(
          join(root, ".gitignore"),
          `!/MyApp/${temporaryName}\n!/MyApp/LocalSecrets.plist\n`,
        );
      },
    });

    expect(["stale", "rolled-back"]).toContain(result.status);
    expect(await Bun.file(join(root, "MyApp", "LocalSecrets.plist")).text()).not.toContain(key);
    for (const name of await readdir(join(root, "MyApp"))) {
      if (name.includes(".clerk-") && (await Bun.file(join(root, "MyApp", name)).exists())) {
        expect(await Bun.file(join(root, "MyApp", name)).text()).not.toContain(key);
      }
    }
  });

  test("rolls back when the committed guard is negated after plist commit", async () => {
    const root = await fixture("pk_test_...");
    const key = publishableKey("guard-negated-after-commit.clerk.example");
    const plan = await planIOSRuntimeKey(options(root));
    const result = await applyIOSRuntimeKey(plan, key, {
      afterPlistCommit: async () => {
        await appendFile(
          join(root, ".gitignore"),
          "!/MyApp/.LocalSecrets.plist.clerk-*.tmp\n!/MyApp/LocalSecrets.plist\n",
        );
      },
    });

    expect(["stale", "rolled-back"]).toContain(result.status);
    expect(await Bun.file(join(root, "MyApp", "LocalSecrets.plist")).text()).not.toContain(key);
    for (const name of await readdir(join(root, "MyApp"))) {
      if (name.includes(".clerk-") && (await Bun.file(join(root, "MyApp", name)).exists())) {
        expect(await Bun.file(join(root, "MyApp", name)).text()).not.toContain(key);
      }
    }
  });

  test("rolls back a linked target when its staged temporary cleanup fails", async () => {
    const root = await fixture("pk_test_...");
    const before = await treeDigest(root);
    const plan = await planIOSRuntimeKey(options(root));

    const apply = applyIOSRuntimeKey(plan, publishableKey("commit-cleanup.clerk.example"), {
      forceGitignoreCommitCleanupFailure: true,
    });

    await expect(apply).rejects.toThrow("temporary runtime-key file could not be removed");
    expect(await treeDigest(root)).toEqual(before);
    for (const directory of [root, join(root, "MyApp")]) {
      expect((await readdir(directory)).some((name) => name.includes(".clerk-"))).toBe(false);
    }
  });

  test("retains the exact ignore rule when a newer key-bearing plist prevents rollback", async () => {
    const root = await fixture("pk_test_...");
    const plan = await planIOSRuntimeKey(options(root));
    const key = publishableKey("partial-rollback.clerk.example");
    const plistPath = join(root, "MyApp", "LocalSecrets.plist");

    const apply = applyIOSRuntimeKey(plan, key, {
      forcePostWriteValidationFailure: true,
      beforePostWriteValidation: async () => {
        await appendFile(plistPath, "\n<!-- concurrent user edit -->\n");
      },
    });

    await expect(apply).rejects.toThrow("Git-ignore protection was retained");
    expect(await Bun.file(join(root, ".gitignore")).text()).toBe(
      TEMPORARY_IGNORE_RULE + TARGET_IGNORE_RULE,
    );
    expect(await Bun.file(plistPath).text()).toContain("concurrent user edit");
    expect(await Bun.file(plistPath).text()).toContain(key);
  });

  test("re-establishes ignore protection when concurrent edits prevent payload rollback", async () => {
    const root = await fixture("pk_test_...");
    const plan = await planIOSRuntimeKey(options(root));
    const key = publishableKey("protected-partial-rollback.clerk.example");
    const plistPath = join(root, "MyApp", "LocalSecrets.plist");

    const apply = applyIOSRuntimeKey(plan, key, {
      afterPlistCommit: async () => {
        await appendFile(plistPath, "\n<!-- concurrent user edit -->\n");
        await appendFile(
          join(root, ".gitignore"),
          "!/MyApp/.LocalSecrets.plist.clerk-*.tmp\n!/MyApp/LocalSecrets.plist\n",
        );
      },
    });

    await expect(apply).rejects.toThrow("Git-ignore protection was retained");
    const gitignore = await Bun.file(join(root, ".gitignore")).text();
    expect(gitignore.endsWith(TEMPORARY_IGNORE_RULE + TARGET_IGNORE_RULE)).toBe(true);
    expect(gitignore.lastIndexOf("!/MyApp/LocalSecrets.plist")).toBeLessThan(
      gitignore.lastIndexOf("/MyApp/LocalSecrets.plist"),
    );
    expect(await Bun.file(plistPath).text()).toContain("concurrent user edit");
    expect(await Bun.file(plistPath).text()).toContain(key);
  });

  test("is idempotent after apply and removes every temporary file", async () => {
    const root = await fixture("pk_test_...");
    const key = publishableKey("idempotent.clerk.example");

    const first = await run(root, key);
    expect(first.result.status).toBe("applied");
    const afterFirst = await treeDigest(root);

    const second = await run(root, key);
    expect(second.result.status).toBe("satisfied");
    expect(await treeDigest(root)).toEqual(afterFirst);
    for (const directory of [root, join(root, "MyApp")]) {
      expect((await readdir(directory)).some((name) => name.includes(".clerk-"))).toBe(false);
    }
  });

  test("blocks a symlinked .gitignore without touching either target", async () => {
    const root = await fixture("pk_test_...");
    const external = join(root, "external-ignore");
    await Bun.write(external, "build/\n");
    await symlink(external, join(root, ".gitignore"));
    const before = await treeDigest(root);

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("unsafe-gitignore");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("blocks a LocalSecrets symlink after a path swap", async () => {
    const root = await fixture("pk_test_...");
    const path = join(root, "MyApp", "LocalSecrets.plist");
    const original = join(root, "MyApp", "OriginalLocalSecrets.plist");
    await rename(path, original);
    await symlink("OriginalLocalSecrets.plist", path);

    const plan = await planIOSRuntimeKey(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("unreadable-local-secrets");
  });
});

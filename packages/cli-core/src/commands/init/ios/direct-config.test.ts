import { afterEach, describe, expect, test } from "bun:test";
import { build as buildPbxProject, parse as parsePbxProject } from "@bacons/xcode/json";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  applyIOSDirectConfig,
  hasExactIOSSwiftUIAppContentRoot,
  planIOSDirectConfig,
  prepareIOSDirectConfigMutation,
  validatePreparedIOSDirectConfig,
  type IOSDirectConfigBlockerCode,
} from "./direct-config.ts";
import type { PbxObjects } from "./pbx.ts";
import { createIOSFixture, IOS_FIXTURE_IDS, treeDigest } from "./test-helpers.ts";

const DEVELOPMENT_KEY = `pk_test_${Buffer.from("direct-config.clerk.accounts.dev$").toString("base64")}`;
const OTHER_DEVELOPMENT_KEY = `pk_test_${Buffer.from("other-app.clerk.accounts.dev$").toString("base64")}`;
const PRODUCTION_KEY = `pk_live_${Buffer.from("production.example.com$").toString("base64")}`;
const SHARED_ENTRY_BUILD_FILE_ID = "454545454545454545454545";
const temporaryDirectories: string[] = [];

async function temporaryRoot(prefix = "clerk-ios-direct-config-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function fixture(options: Parameters<typeof createIOSFixture>[1] = {}): Promise<string> {
  const root = await temporaryRoot();
  await createIOSFixture(root, options);
  return root;
}

function appSourcePath(root: string): string {
  return join(root, "MyApp", "MyAppApp.swift");
}

function planOptions(root: string, targetId: string = IOS_FIXTURE_IDS.appTarget) {
  return {
    root,
    projectPath: "MyApp.xcodeproj",
    targetId,
  };
}

async function source(root: string): Promise<string> {
  return readFile(appSourcePath(root), "utf8");
}

async function replaceSource(root: string, value: string | Uint8Array): Promise<void> {
  await writeFile(appSourcePath(root), value);
}

async function expectNoTransactionArtifacts(root: string): Promise<void> {
  const names = await readdir(join(root, "MyApp"));
  expect(names.filter((name) => name.includes(".clerk-"))).toEqual([]);
}

async function updateProject(root: string, update: (objects: PbxObjects) => void): Promise<void> {
  const path = join(root, "MyApp.xcodeproj", "project.pbxproj");
  await updateProjectAt(path, update);
}

async function updateProjectAt(path: string, update: (objects: PbxObjects) => void): Promise<void> {
  const project = parsePbxProject(await readFile(path, "utf8"));
  const objects = (project as unknown as { objects: PbxObjects }).objects;
  update(objects);
  await writeFile(path, buildPbxProject(project));
}

async function addProjectReference(
  ownerProjectPath: string,
  referencedProjectPath: string,
): Promise<void> {
  await updateProjectAt(join(ownerProjectPath, "project.pbxproj"), (objects) => {
    const referenceId = "464646464646464646464646";
    objects[referenceId] = {
      isa: "PBXFileReference",
      lastKnownFileType: "wrapper.pb-project",
      path: relative(dirname(ownerProjectPath), referencedProjectPath),
      sourceTree: "SOURCE_ROOT",
    };
    objects[IOS_FIXTURE_IDS.project]!.projectReferences = [{ ProjectRef: referenceId }];
  });
}

async function shareEntrySourceWithSecondTarget(root: string): Promise<void> {
  await updateProject(root, (objects) => {
    const phase = objects[IOS_FIXTURE_IDS.secondSourcesPhase]!;
    phase.files = [...(phase.files as string[]), SHARED_ENTRY_BUILD_FILE_ID];
    objects[SHARED_ENTRY_BUILD_FILE_ID] = {
      isa: "PBXBuildFile",
      fileRef: IOS_FIXTURE_IDS.appFile,
    };
  });
}

function blockerCodes(
  plan: Awaited<ReturnType<typeof planIOSDirectConfig>>,
): IOSDirectConfigBlockerCode[] {
  return plan.blockers.map((blocker) => blocker.code);
}

async function run(...args: string[]): Promise<void> {
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${args[0]}`);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("iOS direct Clerk configuration", () => {
  test("plans a fully redacted pristine SwiftUI setup without writing", async () => {
    const root = await fixture();
    const before = await treeDigest(root);

    const plan = await planIOSDirectConfig(planOptions(root));

    expect(plan).toMatchObject({
      status: "ready",
      sourcePath: "MyApp/MyAppApp.swift",
      changes: {
        clerkKitImport: "insert",
        configuration: "insert-initializer",
        environment: "insert",
      },
      blockers: [],
    });
    expect(plan.actions).toHaveLength(3);
    expect(JSON.stringify(plan)).not.toContain("pk_test_");
    expect(JSON.stringify(plan)).not.toContain(DEVELOPMENT_KEY);
    expect(await treeDigest(root)).toEqual(before);
  });

  test("parses repeated Swift import attributes in linear time", async () => {
    const root = await fixture();
    const attributes = "@A() ".repeat(2_000);
    await replaceSource(
      root,
      `${attributes}import SwiftUI

@main
struct MyApp: App {
  var body: some Scene { WindowGroup { Text("Hello") } }
}
`,
    );

    const plan = await planIOSDirectConfig(planOptions(root));

    expect(plan.status).toBe("ready");
    expect(plan.changes?.clerkKitImport).toBe("insert");
  });

  test("refuses an attributed ClerkKit import instead of adding a duplicate", async () => {
    const root = await fixture();
    await replaceSource(
      root,
      `@_exported import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  var body: some Scene { WindowGroup { Text("Hello") } }
}
`,
    );

    expect(blockerCodes(await planIOSDirectConfig(planOptions(root)))).toContain(
      "unsupported-app-structure",
    );
  });

  test("fails closed when Swift regex syntax cannot be inspected safely", async () => {
    const malformed = await fixture();
    await replaceSource(
      malformed,
      `import SwiftUI

let matcher = /Clerk.shared.auth.signInWithApple()

@main
struct MyApp: App {
  var body: some Scene { WindowGroup { ContentView() } }
}
`,
    );

    expect((await planIOSDirectConfig(planOptions(malformed))).status).toBe("blocked");
    expect(hasExactIOSSwiftUIAppContentRoot(await source(malformed))).toBe(false);

    const interpolated = await fixture();
    await replaceSource(
      interpolated,
      `import SwiftUI

let matcher = #/prefix\\#(value)Clerk.shared.auth.signInWithApple()/#

@main
struct MyApp: App {
  var body: some Scene { WindowGroup { ContentView() } }
}
`,
    );

    expect((await planIOSDirectConfig(planOptions(interpolated))).status).toBe("blocked");
    expect(hasExactIOSSwiftUIAppContentRoot(await source(interpolated))).toBe(false);
  });

  test("configures a compact pristine app and is byte-idempotent", async () => {
    const root = await fixture();
    const firstPlan = await planIOSDirectConfig(planOptions(root));

    expect((await applyIOSDirectConfig(firstPlan, DEVELOPMENT_KEY)).status).toBe("applied");
    const configured = await source(root);
    expect(configured).toContain("import SwiftUI\nimport ClerkKit\n");
    expect(configured).toContain(`Clerk.configure(publishableKey: "${DEVELOPMENT_KEY}")`);
    expect(configured).toContain('Text("Hello").environment(Clerk.shared)');

    const secondPlan = await planIOSDirectConfig(planOptions(root));
    expect(secondPlan.changes).toEqual({
      clerkKitImport: "satisfied",
      configuration: "verify-existing",
      environment: "satisfied",
    });
    const beforeSecondApply = await readFile(appSourcePath(root));
    expect((await applyIOSDirectConfig(secondPlan, DEVELOPMENT_KEY)).status).toBe("satisfied");
    expect(await readFile(appSourcePath(root))).toEqual(beforeSecondApply);
  });

  test("inserts configuration first in one existing initializer", async () => {
    const root = await fixture();
    await replaceSource(
      root,
      `import SwiftUI

@main
struct MyApp: App {
  init() {
    // Existing startup behavior.
    bootstrap()
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
    }
  }

  private func bootstrap() {}
}
`,
    );

    const plan = await planIOSDirectConfig(planOptions(root));
    expect(plan.changes?.configuration).toBe("insert-statement");
    expect((await applyIOSDirectConfig(plan, DEVELOPMENT_KEY)).status).toBe("applied");
    const configured = await source(root);
    expect(configured.indexOf("Clerk.configure")).toBeLessThan(configured.indexOf("bootstrap()"));
    expect(configured).toContain("// Existing startup behavior.");
    expect(configured).toContain("private func bootstrap() {}");
  });

  test("treats an existing exact inline literal as verification-required", async () => {
    const root = await fixture();
    await replaceSource(
      root,
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: "${DEVELOPMENT_KEY}")
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environment(Clerk.shared)
    }
  }
}
`,
    );
    const before = await readFile(appSourcePath(root));

    const plan = await planIOSDirectConfig(planOptions(root));

    expect(plan.status).toBe("ready");
    expect(plan.changes?.configuration).toBe("verify-existing");
    expect(plan.actions.join(" ")).toContain("Verify the existing inline Clerk configuration");
    expect(JSON.stringify(plan)).not.toContain(DEVELOPMENT_KEY);
    expect((await applyIOSDirectConfig(plan, DEVELOPMENT_KEY)).status).toBe("satisfied");
    expect(await readFile(appSourcePath(root))).toEqual(before);
  });

  test("refuses indirect Clerk access before an existing inline configuration", async () => {
    const root = await fixture();
    await replaceSource(
      root,
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    bootstrap()
    Clerk.configure(publishableKey: "${DEVELOPMENT_KEY}")
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environment(Clerk.shared)
    }
  }

  private func bootstrap() { consume(Clerk.shared) }
  private func consume(_ clerk: Clerk) {}
}
`,
    );

    const plan = await planIOSDirectConfig(planOptions(root));

    expect(blockerCodes(plan)).toContain("preinitialization-clerk-access");
    expect(plan.blockers[0]?.message).toContain("first executable statement");
  });

  test("refuses stored startup state even when an explicit initializer exists", async () => {
    for (const initializer of [
      "init() { bootstrap() }",
      `init() { Clerk.configure(publishableKey: "${DEVELOPMENT_KEY}") }`,
    ]) {
      const root = await fixture();
      await replaceSource(
        root,
        `import ClerkKit
import SwiftUI

private func earlyClerk() -> Clerk { Clerk.shared }

@main
struct MyApp: App {
  let early = earlyClerk()
  ${initializer}
  var body: some Scene { WindowGroup { ContentView().environment(Clerk.shared) } }
  private func bootstrap() {}
}
`,
      );

      const plan = await planIOSDirectConfig(planOptions(root));

      expect(blockerCodes(plan)).toContain("unsupported-initializer");
      expect(plan.blockers[0]?.message).toContain("stored startup state");
    }
  });

  test("preserves a different existing inline development key", async () => {
    const root = await fixture();
    await replaceSource(
      root,
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() { Clerk.configure(publishableKey: "${OTHER_DEVELOPMENT_KEY}") }
  var body: some Scene { WindowGroup { ContentView().environment(Clerk.shared) } }
}
`,
    );
    const before = await readFile(appSourcePath(root));
    const plan = await planIOSDirectConfig(planOptions(root));

    const result = await applyIOSDirectConfig(plan, DEVELOPMENT_KEY);

    expect(result.status).toBe("blocked");
    expect(result.plan.blockers[0]?.code).toBe("different-inline-publishable-key");
    expect(JSON.stringify(result)).not.toContain(DEVELOPMENT_KEY);
    expect(JSON.stringify(result)).not.toContain(OTHER_DEVELOPMENT_KEY);
    expect(await readFile(appSourcePath(root))).toEqual(before);
  });

  test("refuses malformed, production, and indirect existing configurations", async () => {
    const cases = [
      {
        call: 'Clerk.configure(publishableKey: "pk_test_not-valid")',
        code: "invalid-inline-publishable-key",
      },
      {
        call: `Clerk.configure(publishableKey: "${PRODUCTION_KEY}")`,
        code: "production-inline-publishable-key",
      },
      {
        call: 'Clerk.configure(publishableKey: LocalSecrets.load().publishableKey ?? "")',
        code: "conflicting-configuration",
      },
    ] as const;

    for (const item of cases) {
      const root = await fixture();
      await replaceSource(
        root,
        `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() { ${item.call} }
  var body: some Scene { WindowGroup { ContentView() } }
}
`,
      );
      const plan = await planIOSDirectConfig(planOptions(root));
      expect(blockerCodes(plan)).toContain(item.code);
    }
  });

  test("refuses multiple @main declarations and complex scene roots", async () => {
    const multipleRoot = await fixture();
    await replaceSource(
      multipleRoot,
      `import SwiftUI

@main
struct MyApp: App {
  var body: some Scene { WindowGroup { ContentView() } }
}

@main
struct OtherApp: App {
  var body: some Scene { WindowGroup { Text("Other") } }
}
`,
    );
    expect((await planIOSDirectConfig(planOptions(multipleRoot))).status).toBe("blocked");

    const complexScene = await fixture();
    await replaceSource(
      complexScene,
      `import SwiftUI

@main
struct MyApp: App {
  var body: some Scene {
    WindowGroup {
      ContentView()
      Text("Second root")
    }
  }
}
`,
    );
    expect(blockerCodes(await planIOSDirectConfig(planOptions(complexScene)))).toContain(
      "unsupported-scene",
    );
  });

  test("refuses Clerk.shared access that can run before App initialization", async () => {
    const globalAccess = await fixture();
    await replaceSource(
      globalAccess,
      `import ClerkKit
import SwiftUI

let earlyClerk = Clerk.shared

@main
struct MyApp: App {
  var body: some Scene { WindowGroup { ContentView() } }
}
`,
    );
    expect(blockerCodes(await planIOSDirectConfig(planOptions(globalAccess)))).toContain(
      "preinitialization-clerk-access",
    );

    const memberAccess = await fixture();
    await replaceSource(
      memberAccess,
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  let earlyClerk = Clerk.shared
  var body: some Scene { WindowGroup { ContentView() } }
}
`,
    );
    expect(blockerCodes(await planIOSDirectConfig(planOptions(memberAccess)))).toContain(
      "unsupported-initializer",
    );

    const beforeExistingConfig = await fixture();
    await replaceSource(
      beforeExistingConfig,
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    use(Clerk.shared)
    Clerk.configure(publishableKey: "${DEVELOPMENT_KEY}")
  }
  var body: some Scene { WindowGroup { ContentView().environment(Clerk.shared) } }
}
`,
    );
    expect(blockerCodes(await planIOSDirectConfig(planOptions(beforeExistingConfig)))).toContain(
      "preinitialization-clerk-access",
    );
  });

  test("does not mistake method-body or WindowGroup environment use for early access", async () => {
    const root = await fixture();
    await replaceSource(
      root,
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: "${DEVELOPMENT_KEY}")
  }
  var body: some Scene { WindowGroup { ContentView().environment(Clerk.shared) } }
  private func later() { use(Clerk.shared) }
}
`,
    );

    expect((await planIOSDirectConfig(planOptions(root))).status).toBe("ready");
  });

  test("refuses generated projects and an unsafe external source path", async () => {
    const generated = await fixture({ generated: "xcodegen" });
    expect(blockerCodes(await planIOSDirectConfig(planOptions(generated)))).toContain(
      "generated-project",
    );

    const parentRoot = await temporaryRoot();
    const nestedRoot = join(parentRoot, "Nested");
    await createIOSFixture(nestedRoot);
    await writeFile(join(nestedRoot, "project.yml"), "name: MyApp\n");
    expect(
      blockerCodes(
        await planIOSDirectConfig({
          root: parentRoot,
          projectPath: "Nested/MyApp.xcodeproj",
          targetId: IOS_FIXTURE_IDS.appTarget,
        }),
      ),
    ).toContain("generated-project");

    const externalRoot = await fixture();
    const outside = await temporaryRoot("clerk-ios-outside-");
    await writeFile(join(outside, "Outside.swift"), await source(externalRoot));
    await rm(appSourcePath(externalRoot));
    await symlink(join(outside, "Outside.swift"), appSourcePath(externalRoot));
    expect(blockerCodes(await planIOSDirectConfig(planOptions(externalRoot)))).toContain(
      "incomplete-source-membership",
    );
  });

  test("refuses mutation when an external referenced subproject owns the entry source", async () => {
    const parentRoot = await temporaryRoot("clerk-ios-project-reference-");
    const root = join(parentRoot, "App");
    const siblingRoot = join(parentRoot, "Sibling");
    await createIOSFixture(root);
    await createIOSFixture(siblingRoot, { clerkSDK: false, includeKey: false });
    const before = await readFile(appSourcePath(root));
    await updateProjectAt(join(siblingRoot, "MyApp.xcodeproj", "project.pbxproj"), (objects) => {
      objects[IOS_FIXTURE_IDS.appTarget]!.productType = "com.apple.product-type.app-extension";
      objects[IOS_FIXTURE_IDS.appFile]!.path = relative(
        siblingRoot,
        join(root, "MyApp", "MyAppApp.swift"),
      );
      objects[IOS_FIXTURE_IDS.appFile]!.sourceTree = "SOURCE_ROOT";
    });
    await addProjectReference(join(root, "MyApp.xcodeproj"), join(siblingRoot, "MyApp.xcodeproj"));

    const plan = await planIOSDirectConfig(planOptions(root));

    expect(plan.status).toBe("blocked");
    expect(blockerCodes(plan)).toContain("incomplete-source-membership");
    expect(await readFile(appSourcePath(root))).toEqual(before);
  });

  test("edits only the explicitly selected target", async () => {
    const root = await fixture({ secondTarget: true });
    const mainBefore = await readFile(appSourcePath(root));
    const adminPath = join(root, "AdminApp", "AdminAppApp.swift");

    const plan = await planIOSDirectConfig(planOptions(root, IOS_FIXTURE_IDS.secondTarget));
    expect(plan.sourcePath).toBe("AdminApp/AdminAppApp.swift");
    expect((await applyIOSDirectConfig(plan, DEVELOPMENT_KEY)).status).toBe("applied");

    expect(await readFile(appSourcePath(root))).toEqual(mainBefore);
    expect(await readFile(adminPath, "utf8")).toContain("Clerk.configure");
  });

  test("refuses an entry source shared with another native target", async () => {
    const root = await fixture({ secondTarget: true });
    const before = await readFile(appSourcePath(root));
    await shareEntrySourceWithSecondTarget(root);

    const plan = await planIOSDirectConfig(planOptions(root));

    expect(plan.status).toBe("blocked");
    expect(blockerCodes(plan)).toContain("shared-source");
    expect(await readFile(appSourcePath(root))).toEqual(before);
  });

  test("refuses an entry source aliased into another target through a hard link", async () => {
    const root = await fixture({ secondTarget: true });
    const aliasPath = join(root, "AdminApp", "SharedApp.swift");
    await link(appSourcePath(root), aliasPath);
    await updateProject(root, (objects) => {
      objects[IOS_FIXTURE_IDS.secondAppFile]!.path = "SharedApp.swift";
    });
    const sourceInfo = await lstat(appSourcePath(root));
    const aliasInfo = await lstat(aliasPath);
    expect(aliasInfo.dev).toBe(sourceInfo.dev);
    expect(aliasInfo.ino).toBe(sourceInfo.ino);

    const plan = await planIOSDirectConfig(planOptions(root));

    expect(plan.status).toBe("blocked");
    expect(blockerCodes(plan)).toContain("shared-source");
  });

  test("refuses an entry source shared with a project below normal discovery depth", async () => {
    const root = await fixture();
    const deepRoot = join(root, "a", "b", "c", "d");
    await createIOSFixture(deepRoot, { clerkSDK: false, includeKey: false });
    await updateProject(deepRoot, (objects) => {
      objects[IOS_FIXTURE_IDS.appFile]!.path = "../../../../../MyApp/MyAppApp.swift";
    });

    const plan = await planIOSDirectConfig(planOptions(root));

    expect(plan.status).toBe("blocked");
    expect(blockerCodes(plan)).toContain("shared-source");
  });

  test("fails closed when exhaustive entry-source discovery reaches its safety bound", async () => {
    const root = await fixture();
    const beyondBound = Array.from({ length: 26 }, (_, index) => `level-${index}`).reduce(
      (directory, component) => join(directory, component),
      root,
    );
    await mkdir(beyondBound, { recursive: true });

    const plan = await planIOSDirectConfig(planOptions(root));

    expect(plan.status).toBe("blocked");
    expect(blockerCodes(plan)).toContain("incomplete-source-membership");
  });

  test("replanning refuses newly shared entry-source ownership before writing", async () => {
    const root = await fixture({ secondTarget: true });
    const before = await readFile(appSourcePath(root));
    const plan = await planIOSDirectConfig(planOptions(root));
    expect(plan.status).toBe("ready");
    await shareEntrySourceWithSecondTarget(root);

    const result = await applyIOSDirectConfig(plan, DEVELOPMENT_KEY);

    expect(result.status).toBe("blocked");
    expect(blockerCodes(result.plan)).toContain("shared-source");
    expect(await readFile(appSourcePath(root))).toEqual(before);
  });

  test("rolls back when another target takes ownership before post-write validation", async () => {
    const root = await fixture({ secondTarget: true });
    const before = await readFile(appSourcePath(root));
    const plan = await planIOSDirectConfig(planOptions(root));
    expect(plan.status).toBe("ready");

    const result = await applyIOSDirectConfig(plan, DEVELOPMENT_KEY, {
      beforePostWriteValidation: async () => shareEntrySourceWithSecondTarget(root),
    });

    expect(result.status).toBe("rolled-back");
    expect(await readFile(appSourcePath(root))).toEqual(before);
    expect(blockerCodes(await planIOSDirectConfig(planOptions(root)))).toContain("shared-source");
  });

  test("detects stale source bytes before writing", async () => {
    const root = await fixture();
    const plan = await planIOSDirectConfig(planOptions(root));
    await writeFile(appSourcePath(root), `${await source(root)}// Concurrent edit.\n`);
    const changed = await readFile(appSourcePath(root));

    const result = await applyIOSDirectConfig(plan, DEVELOPMENT_KEY);

    expect(result.status).toBe("stale");
    expect(await readFile(appSourcePath(root))).toEqual(changed);
  });

  test("detects a commit-time race without overwriting it", async () => {
    const root = await fixture();
    const plan = await planIOSDirectConfig(planOptions(root));
    let raced = Buffer.alloc(0);

    const result = await applyIOSDirectConfig(plan, DEVELOPMENT_KEY, {
      beforeCommit: async () => {
        await writeFile(appSourcePath(root), `${await source(root)}// Commit race.\n`);
        raced = await readFile(appSourcePath(root));
      },
    });

    expect(result.status).toBe("stale");
    expect(await readFile(appSourcePath(root))).toEqual(raced);
  });

  test("preserves an editor replacement that wins the commit install boundary", async () => {
    const root = await fixture();
    const plan = await planIOSDirectConfig(planOptions(root));
    const replacementPath = join(root, "MyApp", ".MyAppApp.swift.editor-replacement");
    const replacement = Buffer.from("// Newer editor source.\n");
    await writeFile(replacementPath, replacement);
    await chmod(replacementPath, 0o600);
    const replacementIdentity = await lstat(replacementPath);

    const result = await applyIOSDirectConfig(plan, DEVELOPMENT_KEY, {
      beforeCommitInstall: async () => rename(replacementPath, appSourcePath(root)),
    });

    expect(result.status).toBe("stale");
    expect(await readFile(appSourcePath(root))).toEqual(replacement);
    const installedIdentity = await lstat(appSourcePath(root));
    expect(installedIdentity.ino).toBe(replacementIdentity.ino);
    expect(installedIdentity.mode & 0o7777).toBe(0o600);
    await expectNoTransactionArtifacts(root);
  });

  test("rolls back an exact candidate after post-write validation fails", async () => {
    const root = await fixture();
    const before = await readFile(appSourcePath(root));
    const plan = await planIOSDirectConfig(planOptions(root));

    const result = await applyIOSDirectConfig(plan, DEVELOPMENT_KEY, {
      forcePostWriteValidationFailure: true,
    });

    expect(result.status).toBe("rolled-back");
    expect(await readFile(appSourcePath(root))).toEqual(before);
  });

  test("preserves CRLF, comments, file mode, and unrelated Swift bytes", async () => {
    const root = await fixture();
    const crlf = [
      "// Keep this header.",
      "import SwiftUI",
      "",
      "@main",
      "struct MyApp: App {",
      "    var body: some Scene {",
      "        WindowGroup {",
      "            ContentView() // Keep this root comment.",
      "        }",
      "    }",
      "",
      "    private func unrelated() {",
      '        print("Leave me byte-identical.")',
      "    }",
      "}",
      "",
    ].join("\r\n");
    await replaceSource(root, crlf);
    await chmod(appSourcePath(root), 0o640);

    const plan = await planIOSDirectConfig(planOptions(root));
    expect((await applyIOSDirectConfig(plan, DEVELOPMENT_KEY)).status).toBe("applied");
    const configuredBytes = await readFile(appSourcePath(root));
    const configured = configuredBytes.toString("utf8");
    expect(configured.replaceAll("\r\n", "")).not.toContain("\n");
    expect(configured).toContain("// Keep this header.");
    expect(configured).toContain(
      "ContentView().environment(Clerk.shared) // Keep this root comment.",
    );
    expect(configured).toContain(
      '    private func unrelated() {\r\n        print("Leave me byte-identical.")\r\n    }',
    );
    expect((await lstat(appSourcePath(root))).mode & 0o777).toBe(0o640);
  });

  test("blocks a dirty planned Swift source unless explicitly allowed", async () => {
    const root = await fixture();
    await run("git", "init", "-q", root);
    await run("git", "-C", root, "config", "user.email", "test@example.com");
    await run("git", "-C", root, "config", "user.name", "Test User");
    await run("git", "-C", root, "add", "MyApp/MyAppApp.swift");
    await run("git", "-C", root, "commit", "-qm", "fixture");
    await writeFile(appSourcePath(root), `${await source(root)}// Dirty.\n`);

    expect(blockerCodes(await planIOSDirectConfig(planOptions(root)))).toContain("dirty-source");
    expect(
      (
        await planIOSDirectConfig({
          ...planOptions(root),
          allowDirty: true,
        })
      ).status,
    ).toBe("ready");
  });

  test("allows dirty source when an exact inline setup only needs key verification", async () => {
    const root = await fixture();
    await replaceSource(
      root,
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() { Clerk.configure(publishableKey: "${DEVELOPMENT_KEY}") }
  var body: some Scene { WindowGroup { ContentView().environment(Clerk.shared) } }
}
`,
    );
    await run("git", "init", "-q", root);
    await run("git", "-C", root, "config", "user.email", "test@example.com");
    await run("git", "-C", root, "config", "user.name", "Test User");
    await run("git", "-C", root, "add", "MyApp/MyAppApp.swift");
    await run("git", "-C", root, "commit", "-qm", "fixture");
    await writeFile(appSourcePath(root), `${await source(root)}// Dirty but not rewritten.\n`);

    const plan = await planIOSDirectConfig(planOptions(root));
    expect(plan.status).toBe("ready");
    expect(plan.changes).toEqual({
      clerkKitImport: "satisfied",
      configuration: "verify-existing",
      environment: "satisfied",
    });
    expect((await applyIOSDirectConfig(plan, DEVELOPMENT_KEY)).status).toBe("satisfied");
  });

  test("prepares a non-enumerable in-memory mutation and validates an external commit", async () => {
    const root = await fixture();
    const plan = await planIOSDirectConfig(planOptions(root));
    const prepared = await prepareIOSDirectConfigMutation(plan, DEVELOPMENT_KEY);

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Expected a prepared mutation.");
    expect(prepared.mutation.boundary.rootPath).toBe(root);
    expect(prepared.mutation.candidateBytes.toString()).not.toBe("");
    expect(new TextDecoder().decode(prepared.mutation.candidateBytes)).toContain(DEVELOPMENT_KEY);
    expect(JSON.stringify(prepared)).not.toContain(DEVELOPMENT_KEY);
    expect(JSON.stringify(prepared.mutation)).not.toContain(DEVELOPMENT_KEY);
    expect(await source(root)).not.toContain(DEVELOPMENT_KEY);

    await writeFile(prepared.mutation.absolutePath, prepared.mutation.candidateBytes);
    await chmod(prepared.mutation.absolutePath, prepared.mutation.mode);
    expect(await validatePreparedIOSDirectConfig(prepared)).toBe(true);
  });

  test("never includes a supplied key in ordinary apply results", async () => {
    const root = await fixture();
    const plan = await planIOSDirectConfig(planOptions(root));

    const invalidResult = await applyIOSDirectConfig(plan, "pk_test_do-not-print");
    expect(invalidResult.status).toBe("blocked");
    expect(JSON.stringify(invalidResult)).not.toContain("pk_test_do-not-print");

    const productionResult = await applyIOSDirectConfig(plan, PRODUCTION_KEY);
    expect(productionResult.status).toBe("blocked");
    expect(JSON.stringify(productionResult)).not.toContain(PRODUCTION_KEY);
  });
});

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build as buildPbxProject, parse as parsePbxProject } from "@bacons/xcode/json";
import { afterEach, describe, expect, test } from "bun:test";
import type { PbxObjects } from "./pbx.ts";
import {
  applyIOSPrebuiltAuth,
  planIOSPrebuiltAuth,
  prepareIOSPrebuiltAuthMutation,
} from "./prebuilt-auth.ts";
import { createIOSFixture, IOS_FIXTURE_IDS } from "./test-helpers.ts";

const CONTENT_FILE_ID = "616161616161616161616161";
const CONTENT_BUILD_FILE_ID = "626262626262626262626262";
const SHARED_CONTENT_BUILD_FILE_ID = "636363636363636363636363";

const APP_SOURCE = `import SwiftUI

@main
struct MyApp: App {
  var body: some Scene {
    WindowGroup {
      ContentView()
    }
  }
}
`;

const CONTENT_SOURCE = `//
//  ContentView.swift
//  MyApp
//

import SwiftUI

struct ContentView: View {
  var body: some View {
    VStack {
      Image(systemName: "globe")
        .imageScale(.large)
        .foregroundStyle(.tint)
      Text("Hello, world!")
    }
    .padding()
  }
}

#Preview {
  ContentView()
}
`;

const GENERATED_CONTENT_SOURCE = `//
//  ContentView.swift
//  MyApp
//

import SwiftUI
import ClerkKit
import ClerkKitUI

struct ContentView: View {
  @State private var authIsPresented = false

  var body: some View {
    VStack {
      UserButton(signedOutContent: {
        Button("Sign up") {
          authIsPresented = true
        }
      })
    }
    .prefetchClerkImages()
    .sheet(isPresented: $authIsPresented) {
      AuthView()
    }
  }
}
`;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createFixture(options: { shared?: boolean; crlf?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-prebuilt-auth-"));
  temporaryDirectories.push(root);
  await createIOSFixture(root, {
    clerkSDK: true,
    includeKey: false,
    secondTarget: options.shared === true,
  });
  const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
  const project = parsePbxProject(await readFile(projectPath, "utf8"));
  const objects = (project as unknown as { objects: PbxObjects }).objects;
  (objects[IOS_FIXTURE_IDS.appGroup]!.children as string[]).push(CONTENT_FILE_ID);
  (objects[IOS_FIXTURE_IDS.sourcesPhase]!.files as string[]).push(CONTENT_BUILD_FILE_ID);
  objects[CONTENT_FILE_ID] = {
    isa: "PBXFileReference",
    lastKnownFileType: "sourcecode.swift",
    path: "ContentView.swift",
    sourceTree: "<group>",
  };
  objects[CONTENT_BUILD_FILE_ID] = { isa: "PBXBuildFile", fileRef: CONTENT_FILE_ID };
  if (options.shared) {
    (objects[IOS_FIXTURE_IDS.secondSourcesPhase]!.files as string[]).push(
      SHARED_CONTENT_BUILD_FILE_ID,
    );
    objects[SHARED_CONTENT_BUILD_FILE_ID] = {
      isa: "PBXBuildFile",
      fileRef: CONTENT_FILE_ID,
    };
  }
  await writeFile(projectPath, buildPbxProject(project));
  await writeFile(join(root, "MyApp", "MyAppApp.swift"), APP_SOURCE);
  const content = options.crlf ? CONTENT_SOURCE.replace(/\n/g, "\r\n") : CONTENT_SOURCE;
  await writeFile(join(root, "MyApp", "ContentView.swift"), content);
  return root;
}

function options(root: string) {
  return {
    root,
    projectPath: "MyApp.xcodeproj",
    targetId: IOS_FIXTURE_IDS.appTarget,
    allowDirty: true,
  } as const;
}

async function updateDeploymentTargets(
  root: string,
  update: (settings: Record<string, unknown>, configurationId: string) => void,
): Promise<void> {
  const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
  const project = parsePbxProject(await readFile(projectPath, "utf8"));
  const objects = (project as unknown as { objects: PbxObjects }).objects;
  for (const configurationId of [IOS_FIXTURE_IDS.targetDebug, IOS_FIXTURE_IDS.targetRelease]) {
    const settings = objects[configurationId]?.buildSettings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error(`Missing fixture build settings for ${configurationId}.`);
    }
    update(settings as Record<string, unknown>, configurationId);
  }
  await writeFile(projectPath, buildPbxProject(project));
}

describe("prebuilt AuthView source setup", () => {
  test("plans only an exact target-owned untouched SwiftUI placeholder", async () => {
    const root = await createFixture();
    const plan = await planIOSPrebuiltAuth(options(root));
    const prepared = await prepareIOSPrebuiltAuthMutation(plan);

    expect(plan).toMatchObject({
      schemaVersion: 1,
      kind: "clerk-ios-prebuilt-auth",
      status: "ready",
      appSourcePath: "MyApp/MyAppApp.swift",
      sourcePath: "MyApp/ContentView.swift",
      blockers: [],
    });
    expect(JSON.stringify(plan)).not.toContain("AuthView()");
    expect(JSON.stringify(plan)).not.toContain("Hello, world!");
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected prepared AuthView mutation");
    expect(prepared.mutation.boundary.rootPath).toBe(root);
    expect(prepared.mutation.boundary.realParentPath.endsWith("/MyApp")).toBe(true);
    expect(JSON.stringify(prepared)).not.toContain("boundary");
  });

  test.each([
    {
      name: "one selected configuration below iOS 17",
      update(settings: Record<string, unknown>, configurationId: string) {
        settings.IPHONEOS_DEPLOYMENT_TARGET =
          configurationId === IOS_FIXTURE_IDS.targetDebug ? "17.0" : "16.4";
      },
    },
    {
      name: "an unresolved deployment target",
      update(settings: Record<string, unknown>) {
        settings.IPHONEOS_DEPLOYMENT_TARGET = "$(PRIVATE_IOS_MINIMUM)";
      },
    },
    {
      name: "conflicting device and simulator deployment targets",
      update(settings: Record<string, unknown>) {
        delete settings.IPHONEOS_DEPLOYMENT_TARGET;
        settings["IPHONEOS_DEPLOYMENT_TARGET[sdk=iphoneos*]"] = "17.0";
        settings["IPHONEOS_DEPLOYMENT_TARGET[sdk=iphonesimulator*]"] = "16.0";
      },
    },
    {
      name: "a missing deployment target",
      update(settings: Record<string, unknown>) {
        delete settings.IPHONEOS_DEPLOYMENT_TARGET;
      },
    },
  ])("blocks $name with fixed guidance and no source write", async ({ update }) => {
    const root = await createFixture();
    const sourcePath = join(root, "MyApp", "ContentView.swift");
    const sourceBefore = await readFile(sourcePath);
    await updateDeploymentTargets(root, update);

    const plan = await planIOSPrebuiltAuth(options(root));
    const result = await applyIOSPrebuiltAuth(plan);

    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toEqual([
      {
        code: "incompatible-deployment-target",
        message:
          "ClerkKitUI's native components require iOS 17.0 or newer. Set IPHONEOS_DEPLOYMENT_TARGET to 17.0 or newer for every selected-target iPhone and iPad build configuration, make device and simulator values consistent, then rerun clerk init.",
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain("PRIVATE_IOS_MINIMUM");
    expect(result.status).toBe("blocked");
    expect(await readFile(sourcePath)).toEqual(sourceBefore);
  });

  test("writes the documented AuthView presentation and is byte-idempotent", async () => {
    const root = await createFixture();
    const sourcePath = join(root, "MyApp", "ContentView.swift");
    await chmod(sourcePath, 0o640);
    const plan = await planIOSPrebuiltAuth(options(root));
    const result = await applyIOSPrebuiltAuth(plan);
    const source = await readFile(sourcePath, "utf8");

    expect(result.status).toBe("applied");
    expect(source).toBe(GENERATED_CONTENT_SOURCE);
    expect(source).not.toContain("@Environment");
    expect(source).not.toContain(".onOpenURL");
    expect(source).not.toContain("clerk.auth.events");
    expect(source).not.toContain("clerk.session?.tasks");
    expect(source).not.toContain(".alert(");
    expect(source).not.toContain("#Preview");
    expect((await Bun.file(sourcePath).stat()).mode & 0o777).toBe(0o640);

    const rerun = await planIOSPrebuiltAuth(options(root));
    expect(rerun.status).toBe("satisfied");
    expect((await applyIOSPrebuiltAuth(rerun)).status).toBe("satisfied");
    expect(await readFile(sourcePath, "utf8")).toBe(source);
  });

  test("preserves CRLF and the existing Xcode header", async () => {
    const root = await createFixture({ crlf: true });
    const sourcePath = join(root, "MyApp", "ContentView.swift");
    const plan = await planIOSPrebuiltAuth(options(root));
    expect((await applyIOSPrebuiltAuth(plan)).status).toBe("applied");
    const source = await readFile(sourcePath, "utf8");

    expect(source.startsWith("//\r\n//  ContentView.swift\r\n//  MyApp\r\n//\r\n\r\n")).toBe(true);
    expect(source.includes("\r\n")).toBe(true);
    expect(/(^|[^\r])\n/.test(source)).toBe(false);
  });

  test("refuses customized UI instead of replacing it", async () => {
    const root = await createFixture();
    const sourcePath = join(root, "MyApp", "ContentView.swift");
    await writeFile(
      sourcePath,
      CONTENT_SOURCE.replace('Text("Hello, world!")', 'Text("Customer dashboard")'),
    );

    const plan = await planIOSPrebuiltAuth(options(root));
    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("missing-placeholder");
    expect(await readFile(sourcePath, "utf8")).toContain("Customer dashboard");
  });

  test("refuses source shared with another target", async () => {
    const root = await createFixture({ shared: true });
    const plan = await planIOSPrebuiltAuth(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("shared-source");
  });

  test("returns the replanned source blocker without exposing a concurrent edit", async () => {
    const root = await createFixture();
    const plan = await planIOSPrebuiltAuth(options(root));
    await writeFile(
      join(root, "MyApp", "ContentView.swift"),
      CONTENT_SOURCE.replace('Text("Hello, world!")', 'Text("Concurrent edit")'),
    );

    const prepared = await prepareIOSPrebuiltAuthMutation(plan);
    expect(prepared.status).toBe("blocked");
    expect(prepared.plan.blockers).toContainEqual(
      expect.objectContaining({ code: "missing-placeholder" }),
    );
    expect(JSON.stringify(prepared)).not.toContain("Concurrent edit");
  });

  test("returns the replanned blocker before comparing stale source identity", async () => {
    const root = await createFixture();
    const plan = await planIOSPrebuiltAuth(options(root));
    await writeFile(join(root, "Project.swift"), "import ProjectDescription\n");

    const prepared = await prepareIOSPrebuiltAuthMutation(plan);

    expect(prepared.status).toBe("blocked");
    expect(prepared.plan.blockers).toContainEqual(
      expect.objectContaining({ code: "generated-project" }),
    );
  });

  test("accepts the direct-configured app root without touching it", async () => {
    const root = await createFixture();
    const appPath = join(root, "MyApp", "MyAppApp.swift");
    const encodedHost = Buffer.from("example.clerk.accounts.dev$").toString("base64");
    await writeFile(
      appPath,
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: "pk_test_${encodedHost}")
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

    const plan = await planIOSPrebuiltAuth(options(root));
    expect(plan.status).toBe("ready");
    expect(plan.appSourcePath).toBe("MyApp/MyAppApp.swift");
  });

  test("requires the exact ContentView root to belong to the shipping SwiftUI App", async () => {
    const root = await createFixture();
    await writeFile(
      join(root, "MyApp", "MyAppApp.swift"),
      `import SwiftUI

@main
struct MyApp {
  static func main() {}
}

struct DecoyApp: App {
  var body: some Scene {
    WindowGroup {
      ContentView()
    }
  }
}
`,
    );

    const plan = await planIOSPrebuiltAuth(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("unsupported-app-structure");
  });

  test("refuses a source shared with a project below the normal discovery depth", async () => {
    const root = await createFixture();
    const deepRoot = join(root, "a", "b", "c", "d");
    await mkdir(deepRoot, { recursive: true });
    await createIOSFixture(deepRoot, {
      clerkSDK: false,
      includeKey: false,
    });

    const projectPath = join(deepRoot, "MyApp.xcodeproj", "project.pbxproj");
    const project = parsePbxProject(await readFile(projectPath, "utf8"));
    const objects = (project as unknown as { objects: PbxObjects }).objects;
    (objects[IOS_FIXTURE_IDS.appGroup]!.children as string[]).push(CONTENT_FILE_ID);
    (objects[IOS_FIXTURE_IDS.sourcesPhase]!.files as string[]).push(CONTENT_BUILD_FILE_ID);
    objects[CONTENT_FILE_ID] = {
      isa: "PBXFileReference",
      lastKnownFileType: "sourcecode.swift",
      path: "../../../../../MyApp/ContentView.swift",
      sourceTree: "<group>",
    };
    objects[CONTENT_BUILD_FILE_ID] = { isa: "PBXBuildFile", fileRef: CONTENT_FILE_ID };
    await writeFile(projectPath, buildPbxProject(project));

    const plan = await planIOSPrebuiltAuth(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("shared-source");
  });

  test("fails closed when exhaustive container discovery reaches its safety bound", async () => {
    const root = await createFixture();
    const beyondBound = Array.from({ length: 26 }, (_, index) => `level-${index}`).reduce(
      (directory, component) => join(directory, component),
      root,
    );
    await mkdir(beyondBound, { recursive: true });

    const plan = await planIOSPrebuiltAuth(options(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("incomplete-source-membership");
  });
});

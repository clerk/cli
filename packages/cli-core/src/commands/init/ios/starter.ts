import { dirname, join } from "node:path";
import { parse } from "@bacons/xcode/json";
import { parseXCProjSource, xcprojTargets } from "./xcproj.ts";
import type { FileAction } from "../frameworks/types.ts";
import { snapshotFile, type FileSnapshot } from "./files.ts";
import { AUTH_UI_BODY, AUTH_UI_STATE } from "./plan.ts";
import type { Inspection } from "./xcode.ts";

function starterPaths(inspection: Inspection): { app: string; view: string } | undefined {
  const { selection, projectFormat } = inspection.input;
  const name = selection.targetName;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  const files = [`${name}App.swift`, "ContentView.swift"];
  if (
    inspection.contexts.some(
      (context) =>
        context.settings.EXCLUDED_SOURCE_FILE_NAMES || context.settings.INCLUDED_SOURCE_FILE_NAMES,
    )
  )
    return undefined;
  if (projectFormat === "xcproj") {
    const { root } = parseXCProjSource(inspection.document.source);
    const targets = xcprojTargets(root);
    if (targets.length !== 1 || targets[0]!.id !== selection.targetId) return undefined;
    if (targets[0]!.buildPhases.some((phase) => phase.kind === "script")) return undefined;
    const folders = ((root.files as Record<string, unknown>[]) ?? []).filter(
      (file) => file.kind === "folder" && file.path === name,
    );
    if (
      folders.length !== 1 ||
      Object.keys(folders[0]!).some(
        (key) => !["kind", "path", "target-membership"].includes(key),
      ) ||
      JSON.stringify(folders[0]!["target-membership"]) !== JSON.stringify([name])
    )
      return undefined;
  } else {
    const graph = parse(inspection.document.source),
      objects = graph.objects as Record<string, any>;
    const project = objects[graph.rootObject!],
      target = objects[selection.targetId];
    const appTargets = project.targets.filter(
      (id: string) => objects[id]?.productType === "com.apple.product-type.application",
    );
    if (appTargets.length !== 1 || appTargets[0] !== selection.targetId) return undefined;
    if (target.buildPhases.some((id: string) => objects[id]?.isa === "PBXShellScriptBuildPhase"))
      return undefined;
    const main = objects[project.mainGroup];
    if (main.path || main.sourceTree !== "<group>") return undefined;
    const groups = (main.children ?? []).filter(
      (id: string) => objects[id]?.path === name && objects[id]?.sourceTree === "<group>",
    );
    if (groups.length !== 1) return undefined;
    const groupId = groups[0],
      group = objects[groupId];
    if (group.isa === "PBXFileSystemSynchronizedRootGroup") {
      if (
        group.exceptions?.length ||
        Object.keys(group.explicitFileTypes ?? {}).length ||
        !target.fileSystemSynchronizedGroups?.includes(groupId) ||
        project.targets.some(
          (id: string) =>
            id !== selection.targetId &&
            objects[id]?.fileSystemSynchronizedGroups?.includes(groupId),
        )
      )
        return undefined;
    } else {
      const phases = (target.buildPhases ?? []).filter(
        (id: string) => objects[id]?.isa === "PBXSourcesBuildPhase",
      );
      if (
        phases.length !== 1 ||
        project.targets.some(
          (id: string) =>
            id !== selection.targetId && objects[id]?.buildPhases?.includes(phases[0]),
        )
      )
        return undefined;
      for (const file of files) {
        const refs = (group.children ?? []).filter(
          (id: string) => objects[id]?.path === file && objects[id]?.sourceTree === "<group>",
        );
        const builds = Object.entries(objects).filter(
          ([, item]) => item.isa === "PBXBuildFile" && item.fileRef === refs[0],
        );
        if (
          refs.length !== 1 ||
          builds.length !== 1 ||
          !objects[phases[0]].files.includes(builds[0]![0]) ||
          builds[0]![1].platformFilter ||
          builds[0]![1].platformFilters
        )
          return undefined;
      }
    }
  }
  return {
    app: join(dirname(selection.project), name, files[0]!),
    view: join(dirname(selection.project), name, files[1]!),
  };
}

// Exact starter recipe, not Swift analysis: only a header plus these token sequences.
// Quoted string contents are preserved during whitespace normalization.
const body = (source: string) => source.replace(/^(?:\s*\/\/[^\n]*(?:\n|$))*/, "").trim();
const tokens = (source: string) =>
  body(source)
    .match(/"(?:\\.|[^"\\])*"|[^\s]/g)
    ?.join("");
export const STARTER_VIEW = `import SwiftUI

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
export const starterApp = (name: string) => `import SwiftUI

@main
struct ${name}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`;

export async function isUnchangedStarter(inspection: Inspection): Promise<boolean> {
  try {
    const paths = starterPaths(inspection);
    if (!paths) return false;
    const root = inspection.input.selection.root;
    return (
      tokens((await snapshotFile(root, paths.app)).source) ===
        tokens(starterApp(inspection.input.selection.targetName)) &&
      tokens((await snapshotFile(root, paths.view)).source) === tokens(STARTER_VIEW)
    );
  } catch {
    return false;
  }
}

export async function planStarter(
  inspection: Inspection,
  publishableKey: string | undefined,
  signInUI: boolean,
) {
  const manual = {
    actions: [] as FileAction[],
    snapshots: [] as FileSnapshot[],
    tasks: [] as string[],
    reason:
      "Use the source-integration handoff for this app; only the unchanged SwiftUI starter is automated.",
  };
  if (!publishableKey || inspection.input.managedBy !== "xcode") return manual;
  try {
    const paths = starterPaths(inspection);
    if (!paths) return manual;
    const app = await snapshotFile(inspection.input.selection.root, paths.app);
    const view = await snapshotFile(inspection.input.selection.root, paths.view);
    const preserveHeader = (snapshot: FileSnapshot, content: string) =>
      snapshot.source.slice(0, snapshot.source.indexOf("import")) + content;
    const content = starterApp(inspection.input.selection.targetName)
      .replace("import SwiftUI", "import SwiftUI\nimport ClerkKit")
      .replace(
        "    var body",
        `    init() {\n        Clerk.configure(publishableKey: ${JSON.stringify(publishableKey)})\n    }\n\n    var body`,
      )
      .replace(
        "            ContentView()",
        "            ContentView()\n                .environment(Clerk.shared)",
      );
    const viewContent = `import SwiftUI\nimport ClerkKit\nimport ClerkKitUI\n\nstruct ContentView: View {\n    ${AUTH_UI_STATE}\n\n    var body: some View {\n${AUTH_UI_BODY.trim()
      .split("\n")
      .map((line) => `        ${line}`)
      .join("\n")}\n    }\n}\n`;
    const appReady = tokens(app.source) === tokens(content);
    const viewReady = tokens(view.source) === tokens(viewContent);
    if (
      (!appReady &&
        tokens(app.source) !== tokens(starterApp(inspection.input.selection.targetName))) ||
      (!viewReady && tokens(view.source) !== tokens(STARTER_VIEW))
    )
      return manual;
    const actions: FileAction[] = [];
    if (!appReady)
      actions.push({
        type: "modify",
        path: app.path,
        content: preserveHeader(app, content),
        description: "Initialize Clerk and inject its environment in the unchanged SwiftUI starter",
      });
    const tasks = ["initialize-clerk", "swiftui-environment"];
    if (signInUI && !viewReady)
      actions.push({
        type: "modify",
        path: view.path,
        content: preserveHeader(view, viewContent),
        description: "Add the explicitly requested SDK sign-in UI to the unchanged starter view",
      });
    if (signInUI || viewReady) tasks.push("optional-sign-in-ui");
    return { actions, snapshots: [app, view], tasks, reason: undefined };
  } catch {
    return manual;
  }
}

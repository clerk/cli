import { dirname, resolve } from "node:path";
import { pathIsSafelyWithinIOSRoot } from "./discovery.ts";
import type { IOSAppTarget, IOSProjectInspectionResult } from "./types.ts";

export async function generatedProjectKind(
  root: string,
  absoluteProjectPath: string,
): Promise<"xcodegen" | "tuist" | null> {
  let directory = dirname(absoluteProjectPath);
  while (await pathIsSafelyWithinIOSRoot(root, directory)) {
    for (const [relativePath, kind] of [
      ["project.yml", "xcodegen"],
      ["Project.swift", "tuist"],
      ["Workspace.swift", "tuist"],
      ["Tuist/ProjectDescriptionHelpers", "tuist"],
    ] as const) {
      const marker = resolve(directory, relativePath);
      if ((await pathIsSafelyWithinIOSRoot(root, marker)) && (await Bun.file(marker).exists())) {
        return kind;
      }
    }
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

export function selectedIOSAppTarget(
  inspection: IOSProjectInspectionResult,
  projectPath: string,
  targetId: string,
): IOSAppTarget | undefined {
  const selection = inspection.selection;
  if (
    selection.state !== "selected" ||
    selection.projectPath !== projectPath ||
    selection.targetId !== targetId
  ) {
    return undefined;
  }
  return inspection.appTargets.find(
    (target) => target.projectPath === projectPath && target.id === targetId,
  );
}

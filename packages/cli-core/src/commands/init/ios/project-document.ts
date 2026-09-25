import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

export type XcodeProjectDocumentFormat = "pbxproj" | "xcproj";

export interface XcodeProjectDocumentRef {
  format: XcodeProjectDocumentFormat;
  /** Absolute path to the .xcodeproj wrapper. */
  projectPath: string;
  /** Absolute path to project.pbxproj or project.xcproj. */
  absolutePath: string;
  fileName: "project.pbxproj" | "project.xcproj";
}

export type XcodeProjectDocumentResolution =
  | { status: "found"; document: XcodeProjectDocumentRef }
  | { status: "missing" }
  | { status: "ambiguous" };

async function projectDocumentEntry(path: string): Promise<"regular" | "other" | "absent"> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() ? "regular" : "other";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? "absent"
      : "other";
  }
}

/**
 * Resolves the on-disk document inside an Xcode project wrapper.
 *
 * Xcode 27 supports the legacy OpenStep `project.pbxproj` representation and
 * the hierarchical JSON `project.xcproj` representation. A valid wrapper has
 * exactly one. Treating a wrapper containing both as ambiguous keeps every
 * ownership-sensitive reader and writer fail closed.
 */
export async function resolveXcodeProjectDocument(
  projectPath: string,
): Promise<XcodeProjectDocumentResolution> {
  const absoluteProjectPath = resolve(projectPath);
  const candidates = [
    {
      format: "pbxproj" as const,
      fileName: "project.pbxproj" as const,
      absolutePath: resolve(absoluteProjectPath, "project.pbxproj"),
    },
    {
      format: "xcproj" as const,
      fileName: "project.xcproj" as const,
      absolutePath: resolve(absoluteProjectPath, "project.xcproj"),
    },
  ];
  const existing = [];
  let present = 0;
  for (const candidate of candidates) {
    const entry = await projectDocumentEntry(candidate.absolutePath);
    if (entry !== "absent") present += 1;
    if (entry === "regular") existing.push(candidate);
  }
  if (present > 1) return { status: "ambiguous" };
  if (existing.length === 0) return { status: "missing" };
  if (existing.length !== 1) return { status: "ambiguous" };
  const candidate = existing[0]!;
  return {
    status: "found",
    document: {
      ...candidate,
      projectPath: absoluteProjectPath,
    },
  };
}

export async function xcodeProjectDocumentPath(projectPath: string): Promise<string | undefined> {
  const resolution = await resolveXcodeProjectDocument(projectPath);
  return resolution.status === "found" ? resolution.document.absolutePath : undefined;
}

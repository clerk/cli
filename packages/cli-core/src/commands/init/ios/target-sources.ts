import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "@bacons/xcode/json";
import { parseXCProjSource } from "./xcproj.ts";
import type { Inspection } from "./xcode.ts";

/**
 * The Swift files the selected app target compiles, read from the project the way Xcode
 * assigns them: compile-sources build files and synchronized folders (minus their membership
 * exceptions) in a `.pbxproj`, and target-membership entries in a `.xcproj`. Anything the
 * project expresses another way is reported with the reason, never guessed from the folder
 * layout, since other targets' sources often sit next to the app's.
 */

export type TargetSources = { files: string[] } | { reason: string };

const MAX_FILES = 2000;
const unknown = (what: string): TargetSources => ({
  reason: `the project ${what}, so which Swift files the target compiles couldn't be determined`,
});

/** Every `.swift` file under a synchronized folder, skipping nested bundles Xcode treats as opaque. */
async function swiftFilesUnder(folder: string, files: string[]): Promise<void> {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (/\.(?:xcodeproj|xcworkspace|bundle|app|framework|xcassets)$/.test(entry.name)) continue;
      await swiftFilesUnder(path, files);
    } else if (entry.isFile() && entry.name.endsWith(".swift")) files.push(path);
  }
}

async function pbxprojSources(inspection: Inspection, sourceRoot: string): Promise<TargetSources> {
  const objects = parse(inspection.document.source).objects as Record<string, any>;
  const target = objects[inspection.input.selection.targetId];
  if (!target) return unknown("doesn't list the selected target");
  const parents = new Map<string, string>();
  for (const [id, object] of Object.entries(objects))
    for (const child of Array.isArray(object?.children) ? object.children : [])
      parents.set(child, id);
  const location = (id: string, depth = 0): string | undefined => {
    const object = objects[id];
    if (!object || depth > 64) return undefined;
    const path = typeof object.path === "string" ? object.path : "";
    switch (object.sourceTree) {
      case "<absolute>":
        return path;
      case "SOURCE_ROOT":
        return join(sourceRoot, path);
      case "<group>": {
        const parent = parents.get(id);
        const base = parent ? location(parent, depth + 1) : sourceRoot;
        return base === undefined ? undefined : join(base, path);
      }
      default:
        return undefined;
    }
  };
  const files: string[] = [];
  for (const phaseId of target.buildPhases ?? []) {
    const phase = objects[phaseId];
    if (phase?.isa !== "PBXSourcesBuildPhase") continue;
    for (const buildFileId of phase.files ?? []) {
      const reference = objects[objects[buildFileId]?.fileRef];
      if (typeof reference?.path !== "string" || !reference.path.endsWith(".swift")) continue;
      const path = location(objects[buildFileId].fileRef);
      if (!path) return unknown("places a Swift source outside the project's ordinary paths");
      files.push(path);
    }
  }
  for (const groupId of target.fileSystemSynchronizedGroups ?? []) {
    const folder = location(groupId);
    if (!folder)
      return unknown("places a synchronized folder outside the project's ordinary paths");
    const excluded = new Set<string>();
    for (const exceptionId of objects[groupId]?.exceptions ?? []) {
      const exception = objects[exceptionId];
      if (exception?.target !== inspection.input.selection.targetId) continue;
      if (exception.isa !== "PBXFileSystemSynchronizedBuildFileExceptionSet")
        return unknown("customizes a synchronized folder's build phases for the target");
      for (const path of exception.membershipExceptions ?? []) excluded.add(join(folder, path));
    }
    const found: string[] = [];
    await swiftFilesUnder(folder, found);
    // An exception names a file or a folder relative to the synchronized folder.
    const within = (file: string) =>
      [...excluded].some((path) => !relative(path, file).startsWith(".."));
    files.push(...found.filter((file) => !within(file)));
  }
  return { files };
}

const XCPROJ_KEYS = new Set([
  "kind",
  "path",
  "name",
  "id",
  "type",
  "index",
  "children",
  "target-membership",
]);

async function xcprojSources(inspection: Inspection, sourceRoot: string): Promise<TargetSources> {
  const { root } = parseXCProjSource(inspection.document.source);
  const name = inspection.input.selection.targetName;
  const files: string[] = [];
  const visit = async (entries: unknown, base: string): Promise<TargetSources | undefined> => {
    if (!Array.isArray(entries)) return unknown("lists its files in an unexpected shape");
    for (const entry of entries as Record<string, unknown>[]) {
      const path = typeof entry.path === "string" ? entry.path : "";
      const location = isAbsolute(path) ? path : join(base, path);
      if (entry.kind === "group") {
        const nested = await visit(entry.children ?? [], location);
        if (nested) return nested;
        continue;
      }
      const relevant = entry.kind === "folder" || path.endsWith(".swift");
      if (!relevant) continue;
      if (Object.keys(entry).some((key) => !XCPROJ_KEYS.has(key)))
        return unknown("sets file options this check doesn't read");
      const members = entry["target-membership"];
      if (!Array.isArray(members) || !members.includes(name)) continue;
      if (entry.kind === "folder") await swiftFilesUnder(location, files);
      else files.push(location);
    }
    return undefined;
  };
  return (await visit(root.files ?? [], sourceRoot)) ?? { files };
}

export async function targetSwiftSources(inspection: Inspection): Promise<TargetSources> {
  const { selection, settings } = inspection.contexts[0]!;
  const sourceRoot = settings.SRCROOT ?? resolve(selection.root, dirname(selection.project));
  let sources: TargetSources;
  try {
    sources =
      inspection.input.projectFormat === "xcproj"
        ? await xcprojSources(inspection, sourceRoot)
        : await pbxprojSources(inspection, sourceRoot);
  } catch {
    return { reason: "the target's Swift sources could not be read from the project" };
  }
  if ("reason" in sources) return sources;
  const files = [...new Set(sources.files)];
  if (files.length > MAX_FILES)
    return { reason: `the target compiles more than ${MAX_FILES} Swift files` };
  for (const file of files)
    if ((await lstat(file).catch(() => undefined))?.isFile() !== true)
      return {
        reason: `a Swift source the project lists (${relative(selection.root, file)}) isn't readable`,
      };
  return { files };
}

/** An fnmatch-style pattern as Xcode applies it to source paths, where `*` also crosses `/`. */
function pattern(glob: string): RegExp {
  let source = "";
  for (const char of glob)
    source += char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${source}$`);
}

/** Whether a configuration's EXCLUDED_SOURCE_FILE_NAMES (less INCLUDED_SOURCE_FILE_NAMES) leaves a file out. */
export function excludedFromConfiguration(file: string, settings: Record<string, string>): boolean {
  const matches = (patterns: string | undefined) =>
    (patterns ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map(pattern)
      .some((regex) => regex.test(file) || regex.test(file.split("/").pop()!));
  return (
    matches(settings.EXCLUDED_SOURCE_FILE_NAMES) && !matches(settings.INCLUDED_SOURCE_FILE_NAMES)
  );
}

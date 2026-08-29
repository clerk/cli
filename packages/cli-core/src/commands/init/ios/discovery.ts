import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parsePbxProject } from "@bacons/xcode/json";
import {
  asString,
  asStringArray,
  buildPbxParentIndex,
  isRecord,
  resolvePbxFilePath,
  type PbxObjects,
} from "./pbx.ts";
import { readBoundedRegularFile } from "./bounded-file.ts";
import type { IOSWorkspaceInspection } from "./types.ts";

const MAX_DISCOVERY_DEPTH = 3;
const MAX_EXHAUSTIVE_DISCOVERY_DEPTH = 24;
const MAX_DISCOVERY_DIRECTORIES = 10_000;
const MAX_DISCOVERED_CONTAINERS = 1_000;
const MAX_PROJECT_REFERENCE_DEPTH = 24;
const MAX_PBXPROJ_BYTES = 15_000_000;
const IGNORED_DIRECTORIES = new Set([
  ".build",
  ".git",
  ".swiftpm",
  "build",
  "Carthage",
  "DerivedData",
  "node_modules",
  "Pods",
  "SourcePackages",
]);

export interface IOSContainerDiscovery {
  projectPaths: string[];
  workspacePaths: string[];
  /** False when a bounded or unreadable traversal could have hidden another container. */
  complete: boolean;
  /** False when a PBXProject project-reference closure could not be proven complete. */
  projectReferencesComplete: boolean;
}

export interface IOSProjectReferenceDiscovery {
  /** Verified project containers in the transitive closure, including valid seeds. */
  projectPaths: string[];
  complete: boolean;
}

export interface IOSContainerDiscoveryOptions {
  /**
   * Traverse deeply enough for strict cross-target source-ownership proofs.
   * Any traversal limit or read failure is returned as incomplete so callers
   * can fail closed instead of treating a partial inventory as exhaustive.
   */
  exhaustive?: boolean;
}

interface ContainerWalkState {
  complete: boolean;
  directoriesVisited: number;
  maxDepth: number;
  includeHiddenDirectories: boolean;
}

function isWithinRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function relativeIOSPath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" ? "." : rel.split(sep).join("/");
}

/**
 * Checks both the lexical path and every existing filesystem ancestor. This
 * prevents an in-root symlink from turning a supposedly local read into a read
 * somewhere else on disk. Non-existent leaf paths are allowed only when their
 * nearest existing ancestor is still within the real root.
 */
export async function pathIsSafelyWithinIOSRoot(
  rootInput: string,
  candidateInput: string,
): Promise<boolean> {
  const root = resolve(rootInput);
  const candidate = resolve(candidateInput);
  if (!isWithinRoot(root, candidate)) return false;

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return false;
  }

  let existingAncestor = candidate;
  const missingSegments: string[] = [];
  let realAncestor: string | undefined;
  while (isWithinRoot(root, existingAncestor)) {
    try {
      realAncestor = await realpath(existingAncestor);
      break;
    } catch {
      if (existingAncestor === root) break;
      missingSegments.unshift(basename(existingAncestor));
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) break;
      existingAncestor = parent;
    }
  }

  if (!realAncestor) return false;
  return isWithinRoot(realRoot, resolve(realAncestor, ...missingSegments));
}

async function walkContainers(
  directory: string,
  depth: number,
  projects: Set<string>,
  workspaces: Set<string>,
  state: ContainerWalkState,
): Promise<void> {
  if (state.directoriesVisited >= MAX_DISCOVERY_DIRECTORIES) {
    state.complete = false;
    return;
  }
  state.directoriesVisited += 1;

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    state.complete = false;
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);

    if (entry.isSymbolicLink()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (!state.includeHiddenDirectories && entry.name.startsWith(".")) continue;
      try {
        if ((await stat(absolutePath)).isDirectory()) state.complete = false;
      } catch {
        // A broken or unreadable link could have hidden a directory containing
        // another Xcode container, so exhaustive ownership cannot be proven.
        state.complete = false;
      }
      continue;
    }

    if (!entry.isDirectory()) continue;

    if (entry.name.endsWith(".xcodeproj")) {
      if (projects.size + workspaces.size >= MAX_DISCOVERED_CONTAINERS) {
        state.complete = false;
        continue;
      }
      projects.add(absolutePath);
      continue;
    }

    if (entry.name.endsWith(".xcworkspace")) {
      // Xcode creates a private workspace inside every .xcodeproj. It is an
      // implementation detail, not a user-selectable workspace.
      if (!directory.endsWith(".xcodeproj")) {
        if (projects.size + workspaces.size >= MAX_DISCOVERED_CONTAINERS) {
          state.complete = false;
          continue;
        }
        workspaces.add(absolutePath);
      }
      continue;
    }

    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    if (!state.includeHiddenDirectories && entry.name.startsWith(".")) continue;
    if (depth >= state.maxDepth) {
      state.complete = false;
      continue;
    }
    await walkContainers(absolutePath, depth + 1, projects, workspaces, state);
  }
}

function normalizePbxObjects(value: unknown): PbxObjects | undefined {
  if (!isRecord(value)) return undefined;
  const objects: PbxObjects = {};
  for (const [id, object] of Object.entries(value)) {
    if (!isRecord(object)) return undefined;
    objects[id] = object;
  }
  return objects;
}

async function referencedProjectsForProject(
  root: string,
  projectPath: string,
): Promise<{
  projectPaths: string[];
  complete: boolean;
  valid: boolean;
  canonicalProjectPath?: string;
}> {
  if (!projectPath.endsWith(".xcodeproj")) {
    return { projectPaths: [], complete: false, valid: false };
  }
  if (!(await pathIsSafelyWithinIOSRoot(root, projectPath))) {
    return { projectPaths: [], complete: false, valid: false };
  }

  let canonicalProjectPath: string;
  try {
    const projectInfo = await lstat(projectPath);
    if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) {
      return { projectPaths: [], complete: false, valid: false };
    }
    canonicalProjectPath = await realpath(projectPath);
  } catch {
    return { projectPaths: [], complete: false, valid: false };
  }

  const pbxprojPath = resolve(projectPath, "project.pbxproj");
  if (!(await pathIsSafelyWithinIOSRoot(root, pbxprojPath))) {
    return { projectPaths: [], complete: false, valid: true };
  }

  const projectFile = await readBoundedRegularFile(pbxprojPath, MAX_PBXPROJ_BYTES);
  if (projectFile.status !== "ok") {
    return { projectPaths: [], complete: false, valid: true };
  }
  const source = new TextDecoder().decode(projectFile.bytes);

  let archive: Record<string, unknown>;
  try {
    const parsed: unknown = parsePbxProject(source);
    if (!isRecord(parsed)) throw new Error("invalid project root");
    archive = parsed;
  } catch {
    return { projectPaths: [], complete: false, valid: true };
  }

  const objects = normalizePbxObjects(archive.objects);
  const rootObjectId = asString(archive.rootObject);
  const projectObject = rootObjectId && objects ? objects[rootObjectId] : undefined;
  if (!objects || projectObject?.isa !== "PBXProject") {
    return { projectPaths: [], complete: false, valid: true };
  }

  const projectReferences = projectObject.projectReferences;
  if (projectReferences == null) {
    return {
      projectPaths: [],
      complete: true,
      valid: true,
      canonicalProjectPath,
    };
  }
  if (!Array.isArray(projectReferences)) {
    return { projectPaths: [], complete: false, valid: true };
  }

  const projectDirectory = dirname(projectPath);
  const groupRootDirectory = resolve(
    projectDirectory,
    asString(projectObject.projectDirPath) ?? "",
  );
  const parents = buildPbxParentIndex(objects);
  const parentCounts = new Map<string, number>();
  for (const object of Object.values(objects)) {
    for (const childId of asStringArray(object.children)) {
      parentCounts.set(childId, (parentCounts.get(childId) ?? 0) + 1);
    }
  }
  const projectPaths = new Set<string>();
  let complete = true;
  for (const projectReference of projectReferences) {
    if (!isRecord(projectReference)) {
      complete = false;
      continue;
    }
    const fileReferenceId = asString(projectReference.ProjectRef);
    const fileReference = fileReferenceId ? objects[fileReferenceId] : undefined;
    if (!fileReferenceId || fileReference?.isa !== "PBXFileReference") {
      complete = false;
      continue;
    }
    const parentCount = parentCounts.get(fileReferenceId) ?? 0;
    const sourceTree = asString(fileReference.sourceTree) ?? "<group>";
    const rawPath = asString(fileReference.path);
    if (parentCount > 1 || (sourceTree === "<absolute>" && (!rawPath || !isAbsolute(rawPath)))) {
      complete = false;
      continue;
    }
    const referencedProjectPath = resolvePbxFilePath(
      fileReferenceId,
      objects,
      parents,
      projectDirectory,
      groupRootDirectory,
    );
    if (!referencedProjectPath || !referencedProjectPath.endsWith(".xcodeproj")) {
      complete = false;
      continue;
    }
    projectPaths.add(referencedProjectPath);
  }

  return {
    projectPaths: [...projectPaths].sort(),
    complete,
    valid: true,
    canonicalProjectPath,
  };
}

/**
 * Resolves PBXProject.projectReferences without invoking Xcode. Callers should
 * seed this after filesystem, workspace, and any required project paths have
 * been assembled so the returned closure covers every project they rely on.
 */
export async function discoverReferencedIOSProjects(
  rootInput: string,
  seedProjectPaths: Iterable<string>,
): Promise<IOSProjectReferenceDiscovery> {
  const resolvedInput = resolve(rootInput);
  const root =
    resolvedInput.endsWith(".xcodeproj") || resolvedInput.endsWith(".xcworkspace")
      ? dirname(resolvedInput)
      : resolvedInput;
  const seeds = [
    ...new Set(
      [...seedProjectPaths].map((path) => (isAbsolute(path) ? resolve(path) : resolve(root, path))),
    ),
  ].sort();
  const queue = seeds.slice(0, MAX_DISCOVERED_CONTAINERS).map((path) => ({ path, depth: 0 }));
  const scheduled = new Set(queue.map(({ path }) => path));
  const canonicalOwners = new Map<string, string>();
  const discovered = new Set<string>();
  let complete = seeds.length <= MAX_DISCOVERED_CONTAINERS;

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) break;
    const inspected = await referencedProjectsForProject(root, current.path);
    if (!inspected.valid) {
      complete = false;
      continue;
    }
    const canonicalProjectPath = inspected.canonicalProjectPath;
    if (!canonicalProjectPath) {
      complete = false;
      continue;
    }
    const canonicalOwner = canonicalOwners.get(canonicalProjectPath);
    if (canonicalOwner && canonicalOwner !== current.path) {
      complete = false;
      continue;
    }
    canonicalOwners.set(canonicalProjectPath, current.path);
    discovered.add(current.path);
    if (!inspected.complete) complete = false;

    for (const referencedProjectPath of inspected.projectPaths) {
      const absolutePath = resolve(referencedProjectPath);
      if (scheduled.has(absolutePath)) continue;
      if (current.depth >= MAX_PROJECT_REFERENCE_DEPTH) {
        complete = false;
        continue;
      }
      if (scheduled.size >= MAX_DISCOVERED_CONTAINERS) {
        complete = false;
        continue;
      }
      scheduled.add(absolutePath);
      queue.push({ path: absolutePath, depth: current.depth + 1 });
    }
  }

  return { projectPaths: [...discovered].sort(), complete };
}

export async function discoverIOSContainers(
  rootInput: string,
  options: IOSContainerDiscoveryOptions = {},
): Promise<IOSContainerDiscovery> {
  const root = resolve(rootInput);
  const projects = new Set<string>();
  const workspaces = new Set<string>();
  const exhaustive = options.exhaustive === true;
  const state: ContainerWalkState = {
    complete: true,
    directoriesVisited: 0,
    maxDepth: exhaustive ? MAX_EXHAUSTIVE_DISCOVERY_DEPTH : MAX_DISCOVERY_DEPTH,
    includeHiddenDirectories: exhaustive,
  };

  if (root.endsWith(".xcodeproj")) {
    projects.add(root);
  } else if (root.endsWith(".xcworkspace")) {
    workspaces.add(root);
  } else {
    await walkContainers(root, 0, projects, workspaces, state);
  }

  const projectReferenceRoot = root.endsWith(".xcodeproj")
    ? dirname(root)
    : root.endsWith(".xcworkspace")
      ? dirname(root)
      : root;
  const projectReferences = await discoverReferencedIOSProjects(projectReferenceRoot, projects);
  for (const projectPath of projectReferences.projectPaths) projects.add(projectPath);

  return {
    projectPaths: [...projects].sort(),
    workspacePaths: [...workspaces].sort(),
    complete: state.complete && projectReferences.complete,
    projectReferencesComplete: projectReferences.complete,
  };
}

function decodeXMLAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function xmlAttribute(source: string, name: string): string | undefined {
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    const attributeName = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(source.slice(cursor))?.[0];
    if (!attributeName) {
      cursor += 1;
      continue;
    }
    cursor += attributeName.length;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "=") continue;
    cursor += 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") continue;
    const valueStart = ++cursor;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd === -1) return undefined;
    if (attributeName === name) {
      return decodeXMLAttribute(source.slice(valueStart, valueEnd));
    }
    cursor = valueEnd + 1;
  }
  return undefined;
}

function resolveWorkspaceLocation(
  base: string,
  location: string | undefined,
  containerBase: string,
): string {
  if (!location) return base;
  const separatorIndex = location.indexOf(":");
  const scheme = separatorIndex === -1 ? "group" : location.slice(0, separatorIndex);
  const rawPath = separatorIndex === -1 ? location : location.slice(separatorIndex + 1);
  if (scheme === "absolute") return resolve(rawPath);
  if (scheme === "container") return resolve(containerBase, rawPath);
  return resolve(base, rawPath);
}

/**
 * Masks XML comments without joining the bytes on either side. Removing a
 * comment outright could synthesize markup from two otherwise inert fragments
 * (for example, `<Fi<!-- -->leRef>`).
 */
export function maskXMLComments(source: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<!--", cursor);
    if (start === -1) {
      chunks.push(source.slice(cursor));
      break;
    }
    chunks.push(source.slice(cursor, start));
    const closing = source.indexOf("-->", start + 4);
    const end = closing === -1 ? source.length : closing + 3;
    chunks.push(" ".repeat(end - start));
    cursor = end;
  }
  return chunks.join("");
}

/**
 * Returns the single target reference that the Xcode Run action actually
 * launches. References used only for MacroExpansion or other scheme metadata
 * are not runtime ownership evidence.
 */
export function xcodeSchemeRunnableReferenceAttributes(
  launchActionBody: string,
): string | undefined {
  const runnables = [
    ...launchActionBody.matchAll(
      /<BuildableProductRunnable\b[^>]*>([\s\S]*?)<\/BuildableProductRunnable>/g,
    ),
  ];
  if (runnables.length !== 1) return undefined;

  const references = [
    ...(runnables[0]?.[1] ?? "").matchAll(/<BuildableReference\b([^>]*)\/?\s*>/g),
  ];
  if (references.length !== 1) return undefined;
  return references[0]?.[1];
}

/**
 * Reads only project references from an Xcode workspace. We deliberately do
 * not use Xcode or resolve packages. Unsupported/external references remain
 * visible in the workspace inventory but are not traversed.
 */
export async function inspectWorkspace(
  rootInput: string,
  workspacePath: string,
): Promise<{ inspection: IOSWorkspaceInspection; localProjectPaths: string[] }> {
  const root = resolve(rootInput);
  const contentsPath = resolve(workspacePath, "contents.xcworkspacedata");
  let xml = "";
  try {
    if (!(await pathIsSafelyWithinIOSRoot(root, contentsPath))) {
      throw new Error("external workspace");
    }
    const file = await readBoundedRegularFile(contentsPath, 2_000_000);
    if (file.status !== "ok") throw new Error("unreadable workspace");
    xml = maskXMLComments(new TextDecoder().decode(file.bytes));
  } catch {
    return {
      inspection: { path: relativeIOSPath(root, workspacePath), projectPaths: [] },
      localProjectPaths: [],
    };
  }

  const projectPaths = new Set<string>();
  const localProjectPaths = new Set<string>();
  const workspaceDirectory = dirname(workspacePath);
  const groupBases = [workspaceDirectory];
  const elementPattern = /<(\/)?(Workspace|Group|FileRef)\b([^>]*)>/g;
  for (const match of xml.matchAll(elementPattern)) {
    const closing = match[1] === "/";
    const tag = match[2];
    const attributes = match[3] ?? "";
    if (tag === "Group") {
      if (closing) {
        if (groupBases.length > 1) groupBases.pop();
      } else {
        const base = groupBases.at(-1) ?? workspaceDirectory;
        groupBases.push(
          resolveWorkspaceLocation(base, xmlAttribute(attributes, "location"), workspaceDirectory),
        );
        if (attributes.trimEnd().endsWith("/")) groupBases.pop();
      }
      continue;
    }
    if (closing || tag !== "FileRef") continue;

    const location = xmlAttribute(attributes, "location");
    const base = groupBases.at(-1) ?? workspaceDirectory;
    const embeddedProject =
      location === "self:" && workspaceDirectory.endsWith(".xcodeproj")
        ? workspaceDirectory
        : undefined;
    if (!embeddedProject && !location?.endsWith(".xcodeproj")) continue;
    const absolutePath =
      embeddedProject ?? resolveWorkspaceLocation(base, location, workspaceDirectory);
    const safelyLocal = await pathIsSafelyWithinIOSRoot(root, absolutePath);
    projectPaths.add(safelyLocal ? relativeIOSPath(root, absolutePath) : absolutePath);
    if (safelyLocal) localProjectPaths.add(absolutePath);
  }

  return {
    inspection: {
      path: relativeIOSPath(root, workspacePath),
      projectPaths: [...projectPaths].sort(),
    },
    localProjectPaths: [...localProjectPaths].sort(),
  };
}

export function pathIsWithinIOSRoot(rootInput: string, candidate: string): boolean {
  return isWithinRoot(resolve(rootInput), resolve(candidate));
}

import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { IOSWorkspaceInspection } from "./types.ts";

const MAX_DISCOVERY_DEPTH = 3;
const MAX_EXHAUSTIVE_DISCOVERY_DEPTH = 24;
const MAX_DISCOVERY_DIRECTORIES = 10_000;
const MAX_DISCOVERED_CONTAINERS = 1_000;
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

  return {
    projectPaths: [...projects].sort(),
    workspacePaths: [...workspaces].sort(),
    complete: state.complete,
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
    const file = Bun.file(contentsPath);
    if (!(await file.exists()) || file.size > 2_000_000) throw new Error("unreadable workspace");
    xml = maskXMLComments(await file.text());
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

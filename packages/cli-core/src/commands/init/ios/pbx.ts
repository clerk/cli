import { isAbsolute, resolve } from "node:path";

export type PbxObject = Record<string, unknown> & { isa?: string };
export type PbxObjects = Record<string, PbxObject>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function asStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number") {
      result[key] = String(item);
    } else if (Array.isArray(item)) {
      result[key] = item.map(String).join(" ");
    }
  }
  return result;
}

export function buildPbxParentIndex(objects: PbxObjects): Map<string, string> {
  const parents = new Map<string, string>();
  for (const [id, object] of Object.entries(objects)) {
    for (const child of asStringArray(object.children)) {
      if (!parents.has(child)) parents.set(child, id);
    }
  }
  return parents;
}

/** Resolve a group/file reference without invoking Xcode. */
export function resolvePbxFilePath(
  objectId: string,
  objects: PbxObjects,
  parents: Map<string, string>,
  projectDirectory: string,
  groupRootDirectory: string = projectDirectory,
  seen: Set<string> = new Set(),
): string | undefined {
  if (seen.has(objectId)) return undefined;
  seen.add(objectId);

  const object = objects[objectId];
  if (!object) return undefined;

  const objectPath = asString(object.path);
  // `name` is only an Xcode navigator display label. A pathless group is a
  // logical group and contributes no filesystem component; a pathless file
  // reference cannot be resolved without guessing.
  if (objectPath == null && object.isa === "PBXFileReference") return undefined;
  const rawPath = objectPath ?? "";
  const sourceTree = asString(object.sourceTree) ?? "<group>";

  if (sourceTree === "<absolute>") {
    return rawPath ? resolve(rawPath) : undefined;
  }
  if (isAbsolute(rawPath)) {
    return resolve(rawPath);
  }
  if (sourceTree === "SOURCE_ROOT" || sourceTree === "<sourceRoot>") {
    return resolve(projectDirectory, rawPath);
  }
  if (sourceTree !== "<group>") return undefined;

  const parentId = parents.get(objectId);
  if (!parentId) return resolve(groupRootDirectory, rawPath);
  const parentPath = resolvePbxFilePath(
    parentId,
    objects,
    parents,
    projectDirectory,
    groupRootDirectory,
    seen,
  );
  return parentPath ? resolve(parentPath, rawPath) : undefined;
}

export function sanitizeRepositoryURL(repository: string): string {
  const trimmed = repository.trim();
  const scpMatch = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  const scpHost = scpMatch?.[1];
  const scpPath = scpMatch?.[2];
  if (scpHost && scpPath && !trimmed.includes("://")) {
    return `ssh://${scpHost.toLowerCase()}/${scpPath.replace(/^\/+/, "")}`
      .replace(/\.git\/?$/i, "")
      .replace(/\/$/, "");
  }

  try {
    const url = new URL(trimmed);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) {
      return `${url.protocol}//<redacted>`;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`
      .replace(/\.git\/?$/i, "")
      .replace(/\/$/, "");
  } catch {
    const sanitized = trimmed
      .replace(/[?#].*$/, "")
      .replace(/\.git\/?$/i, "")
      .replace(/\/$/, "");
    return /^[a-zA-Z0-9._/-]+$/.test(sanitized) ? sanitized : "<invalid-repository-url>";
  }
}

export function isClerkIOSRepository(repository: string): boolean {
  const canonical = sanitizeRepositoryURL(repository).toLowerCase();
  return (
    canonical === "https://github.com/clerk/clerk-ios" ||
    canonical === "ssh://github.com/clerk/clerk-ios"
  );
}

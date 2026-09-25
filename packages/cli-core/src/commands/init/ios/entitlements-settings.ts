import { generatedProjectKind } from "./project-selection.ts";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { build as buildPbxProject, parse as parsePbxProject } from "@bacons/xcode/json";
import { inspectTargetBuildConfigurations } from "./build-settings.ts";
import { inspectXCProjTargetBuildConfigurations } from "./xcproj-build-settings.ts";
import {
  discoverLocalIOSProjects,
  pathIsSafelyWithinIOSRoot,
  relativeIOSPath,
} from "./discovery.ts";
import {
  hashIOSFileBytes,
  prepareIOSFileMutationBoundary,
  type IOSExistingFileMutation,
} from "./file-transaction.ts";
import { inspectIOSProject } from "./inspect.ts";
import { resolveXcodeProjectDocument, type XcodeProjectDocumentRef } from "./project-document.ts";
import {
  asString,
  buildPbxParentIndex,
  isRecord,
  resolvePbxFilePath,
  type PbxObject,
  type PbxObjects,
} from "./pbx.ts";
import type { IOSDiagnostic, IOSNativePlatform } from "./types.ts";
import {
  applyXCProjValue,
  parseXCProjSource,
  type XCProjRecord,
  type XCProjTarget,
  xcprojArray,
  xcprojRecord,
  xcprojString,
  xcprojStringArray,
  xcprojTargets,
} from "./xcproj.ts";

const APP_PRODUCT_TYPE = "com.apple.product-type.application";
const DEVICE_SETTING = "CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]";
const SIMULATOR_SETTING = "CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]";
const MACOS_SETTING = "CODE_SIGN_ENTITLEMENTS[sdk=macosx*]";
const MAX_PBXPROJ_BYTES = 15_000_000;

export interface IOSMissingEntitlementsSettingsOptions {
  root: string;
  /** Invocation-root-relative selected .xcodeproj path. */
  projectPath: string;
  targetId: string;
  /** Defaults to iOS for existing callers. */
  platform?: IOSNativePlatform;
}

export type IOSMissingEntitlementsSettingsBlockerCode =
  | "invalid-selection"
  | "external-path"
  | "generated-project"
  | "unreadable-project"
  | "malformed-project"
  | "target-not-found"
  | "incomplete-build-configurations"
  | "missing-synchronized-root"
  | "ambiguous-synchronized-root"
  | "unsafe-synchronized-root"
  | "shared-synchronized-root"
  | "invalid-entitlements-destination"
  | "entitlements-destination-exists"
  | "ignored-entitlements-destination"
  | "unresolved-git-ignore"
  | "shared-entitlements-destination"
  | "conflicting-entitlements-settings"
  | "unsupported-project";

export interface IOSMissingEntitlementsSettingsBlocker {
  code: IOSMissingEntitlementsSettingsBlockerCode;
  message: string;
}

interface IOSMissingEntitlementsSettingsPlanBase {
  schemaVersion: 1;
  kind: "clerk-ios-missing-entitlements-settings";
  root: string;
  projectPath: string;
  targetId: string;
  platform: IOSNativePlatform;
  /** Exact target configuration IDs authorized by this plan, when inspectable. */
  configurationIds: string[];
  actions: string[];
  blockers: IOSMissingEntitlementsSettingsBlocker[];
}

interface IOSMissingEntitlementsSettingsResolvedFields {
  projectFormat: "pbxproj" | "xcproj";
  targetName: string;
  /** Invocation-root-relative destination. */
  entitlementsPath: string;
  /** Value written to CODE_SIGN_ENTITLEMENTS, relative to the .xcodeproj directory. */
  buildSettingPath: string;
  /** Invocation-root-relative synchronized target root. */
  synchronizedRootPath: string;
  synchronizedRootObjectId: string;
  expectedSynchronizedRootIdentity: { device: number; inode: number };
  expectedPbxprojHash: string;
  expectedPbxprojMode: number;
}

export type IOSMissingEntitlementsSettingsPlan =
  | (IOSMissingEntitlementsSettingsPlanBase &
      IOSMissingEntitlementsSettingsResolvedFields & { status: "ready" })
  | (IOSMissingEntitlementsSettingsPlanBase &
      IOSMissingEntitlementsSettingsResolvedFields & { status: "satisfied" })
  | (IOSMissingEntitlementsSettingsPlanBase &
      Partial<IOSMissingEntitlementsSettingsResolvedFields> & { status: "blocked" });

interface IOSMissingEntitlementsSettingsPlanSource {
  projectFormat?: "pbxproj" | "xcproj";
  targetName?: string;
  entitlementsPath?: string;
  buildSettingPath?: string;
  synchronizedRootPath?: string;
  synchronizedRootObjectId?: string;
  expectedSynchronizedRootIdentity?: { device: number; inode: number };
  expectedPbxprojHash?: string;
  expectedPbxprojMode?: number;
}

export type PreparedIOSMissingEntitlementsSettingsMutation =
  | { status: "ready"; plan: IOSMissingEntitlementsSettingsPlan; mutation: IOSExistingFileMutation }
  | { status: "satisfied"; plan: IOSMissingEntitlementsSettingsPlan }
  | { status: "blocked"; plan: IOSMissingEntitlementsSettingsPlan }
  | { status: "stale"; plan: IOSMissingEntitlementsSettingsPlan };

interface ProjectGraph {
  project: ReturnType<typeof parsePbxProject>;
  objects: PbxObjects;
  projectObjectId: string;
  projectObject: PbxObject;
  targetId: string;
  targetObject: PbxObject;
  configurationIds: string[];
}

interface ProjectSnapshot {
  absoluteProjectPath: string;
  pbxprojPath: string;
  bytes: Uint8Array;
  hash: string;
  mode: number;
  source: string;
  graph: ProjectGraph;
}

interface XCProjProjectSnapshot {
  absoluteProjectPath: string;
  documentPath: string;
  bytes: Uint8Array;
  hash: string;
  mode: number;
  source: string;
  document: XCProjRecord;
  target: XCProjTarget;
  targetIndex: number;
  configurationIds: string[];
}

interface SynchronizedRoot {
  objectId: string;
  absolutePath: string;
  relativePath: string;
  device: number;
  inode: number;
}

const XCPROJ_APP_PRODUCT_TYPES = new Set(["application", APP_PRODUCT_TYPE]);

function xcprojConfigurationIds(document: XCProjRecord): string[] | undefined {
  let values: unknown[];
  try {
    values = xcprojArray(document.configurations ?? []);
  } catch {
    return undefined;
  }
  const result: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      if (!value) return undefined;
      result.push(value);
      continue;
    }
    try {
      const configuration = xcprojRecord(value);
      const name = xcprojString(configuration.name);
      if (!name) return undefined;
      result.push(
        typeof configuration.id === "string" && configuration.id ? configuration.id : name,
      );
    } catch {
      return undefined;
    }
  }
  return result.length > 0 && new Set(result).size === result.length ? result : undefined;
}

async function readXCProjSnapshot(
  root: string,
  documentRef: XcodeProjectDocumentRef,
  targetId: string,
): Promise<XCProjProjectSnapshot | undefined> {
  if (
    documentRef.format !== "xcproj" ||
    !(await pathIsSafelyWithinIOSRoot(root, documentRef.projectPath)) ||
    !(await pathIsSafelyWithinIOSRoot(root, documentRef.absolutePath))
  ) {
    return undefined;
  }
  try {
    const [projectInfo, info] = await Promise.all([
      lstat(documentRef.projectPath),
      lstat(documentRef.absolutePath),
    ]);
    if (
      !projectInfo.isDirectory() ||
      projectInfo.isSymbolicLink() ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_PBXPROJ_BYTES
    ) {
      return undefined;
    }
    const bytes = new Uint8Array(await readFile(documentRef.absolutePath));
    const parsed = parseXCProjSource(bytes);
    const targets = xcprojTargets(parsed.root);
    if (new Set(targets.map((target) => target.name)).size !== targets.length) return undefined;
    const targetIndex = targets.findIndex((target) => target.id === targetId);
    const target = targets[targetIndex];
    const configurationIds = xcprojConfigurationIds(parsed.root);
    if (
      !target ||
      target.kind !== "native" ||
      !target.productType ||
      !XCPROJ_APP_PRODUCT_TYPES.has(target.productType) ||
      !configurationIds
    ) {
      return undefined;
    }
    return {
      absoluteProjectPath: documentRef.projectPath,
      documentPath: documentRef.absolutePath,
      bytes,
      hash: hashIOSFileBytes(bytes),
      mode: info.mode & 0o7777,
      source: parsed.source,
      document: parsed.root,
      target,
      targetIndex,
      configurationIds,
    };
  } catch {
    return undefined;
  }
}

function xcprojSnapshotFromBytes(
  snapshot: XCProjProjectSnapshot,
  bytes: Uint8Array,
): XCProjProjectSnapshot | undefined {
  try {
    const parsed = parseXCProjSource(bytes);
    const targets = xcprojTargets(parsed.root);
    if (new Set(targets.map((target) => target.name)).size !== targets.length) return undefined;
    const targetIndex = targets.findIndex((target) => target.id === snapshot.target.id);
    const target = targets[targetIndex];
    const configurationIds = xcprojConfigurationIds(parsed.root);
    if (
      !target ||
      target.kind !== "native" ||
      !target.productType ||
      !XCPROJ_APP_PRODUCT_TYPES.has(target.productType) ||
      !configurationIds
    ) {
      return undefined;
    }
    return {
      ...snapshot,
      bytes,
      source: parsed.source,
      document: parsed.root,
      target,
      targetIndex,
      configurationIds,
    };
  } catch {
    return undefined;
  }
}

function xcprojReferencePath(
  parent: string,
  path: string,
  projectDirectory = parent,
): string | undefined {
  if (!path || /^<(?:PRODUCTS|SDK|DEVELOPER)>\//.test(path)) return undefined;
  if (path.startsWith("<PROJECT>/")) {
    return resolve(projectDirectory, path.slice("<PROJECT>/".length));
  }
  if (path.startsWith("<")) return undefined;
  return resolve(parent, path);
}

async function selectedXCProjSynchronizedRoot(
  root: string,
  snapshot: XCProjProjectSnapshot,
): Promise<{ root?: SynchronizedRoot; blocker?: IOSMissingEntitlementsSettingsBlocker }> {
  const candidates: Array<{ reference: XCProjRecord; path: string; identity: string }> = [];
  const projectDirectory = dirname(snapshot.absoluteProjectPath);
  let malformed = false;
  const visit = (value: unknown, parent: string, identity: string): void => {
    let reference: XCProjRecord;
    try {
      reference = xcprojRecord(value);
    } catch {
      malformed = true;
      return;
    }
    const kind = typeof reference.kind === "string" ? reference.kind : "file-reference";
    const path = typeof reference.path === "string" ? reference.path : "";
    if (kind === "group") {
      const groupDirectory = path ? xcprojReferencePath(parent, path, projectDirectory) : parent;
      if (!groupDirectory) {
        malformed = true;
        return;
      }
      let children: unknown[];
      try {
        children = xcprojArray(reference.children ?? []);
      } catch {
        malformed = true;
        return;
      }
      children.forEach((child, index) => visit(child, groupDirectory, `${identity}.${index}`));
      return;
    }
    if (kind !== "folder") return;
    let membership: string[];
    try {
      membership = xcprojStringArray(reference["target-membership"] ?? []);
    } catch {
      malformed = true;
      return;
    }
    if (!membership.includes(snapshot.target.name)) return;
    if (membership.length !== 1 || reference["membership-exceptions"] !== undefined || !path) {
      malformed = true;
      return;
    }
    const absolutePath = xcprojReferencePath(parent, path, projectDirectory);
    if (!absolutePath) {
      malformed = true;
      return;
    }
    candidates.push({ reference, path: absolutePath, identity });
  };
  try {
    for (const [index, reference] of xcprojArray(snapshot.document.files).entries()) {
      visit(reference, projectDirectory, `${index}`);
    }
  } catch {
    malformed = true;
  }
  if (malformed) {
    return {
      blocker: blocker(
        "unsafe-synchronized-root",
        "The selected target's synchronized source root could not be modeled safely.",
      ),
    };
  }
  if (candidates.length === 0) {
    return {
      blocker: blocker(
        "missing-synchronized-root",
        "The selected target does not have a filesystem-synchronized source root.",
      ),
    };
  }
  if (candidates.length !== 1) {
    return {
      blocker: blocker(
        "ambiguous-synchronized-root",
        "The selected target has more than one filesystem-synchronized source root.",
      ),
    };
  }
  const candidate = candidates[0]!;
  if (!(await pathIsSafelyWithinIOSRoot(root, candidate.path))) {
    return {
      blocker: blocker(
        "unsafe-synchronized-root",
        "The selected target's synchronized source root resolves outside the invocation root.",
      ),
    };
  }
  try {
    const info = await lstat(candidate.path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsupported root");
    await realpath(candidate.path);
    const explicitId =
      typeof candidate.reference.id === "string" && candidate.reference.id
        ? candidate.reference.id
        : undefined;
    return {
      root: {
        objectId: explicitId ?? `xcproj-folder:${candidate.identity}`,
        absolutePath: candidate.path,
        relativePath: relativeIOSPath(root, candidate.path),
        device: info.dev,
        inode: info.ino,
      },
    };
  } catch {
    return {
      blocker: blocker(
        "unsafe-synchronized-root",
        "The selected target's synchronized source root must be a regular, non-symlink directory.",
      ),
    };
  }
}

function blocker(
  code: IOSMissingEntitlementsSettingsBlockerCode,
  message: string,
): IOSMissingEntitlementsSettingsBlocker {
  return { code, message };
}

function planBase(
  options: IOSMissingEntitlementsSettingsOptions,
): Pick<
  IOSMissingEntitlementsSettingsPlanBase,
  "schemaVersion" | "kind" | "root" | "projectPath" | "targetId" | "platform"
> {
  return {
    schemaVersion: 1,
    kind: "clerk-ios-missing-entitlements-settings",
    root: resolve(options.root),
    projectPath: options.projectPath.replaceAll("\\", "/"),
    targetId: options.targetId,
    platform: options.platform ?? "ios",
  };
}

function blockedPlan(
  options: IOSMissingEntitlementsSettingsOptions,
  detail: IOSMissingEntitlementsSettingsBlocker,
  source: IOSMissingEntitlementsSettingsPlanSource & { configurationIds?: string[] } = {},
): IOSMissingEntitlementsSettingsPlan {
  return {
    ...planBase(options),
    ...source,
    status: "blocked",
    configurationIds: source.configurationIds ?? [],
    actions: [],
    blockers: [detail],
  };
}

function blockPrepared(
  plan: IOSMissingEntitlementsSettingsPlan,
  code: IOSMissingEntitlementsSettingsBlockerCode,
  message: string,
): PreparedIOSMissingEntitlementsSettingsMutation {
  return {
    status: "blocked",
    plan: {
      ...plan,
      status: "blocked",
      actions: [],
      blockers: [blocker(code, message)],
    },
  };
}

function exactStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  const result = [...value];
  return new Set(result).size === result.length ? result : undefined;
}

function optionalExactStringArray(value: unknown): string[] | undefined {
  return value == null ? [] : exactStringArray(value);
}

function normalizedObjects(value: unknown): PbxObjects | undefined {
  if (!isRecord(value)) return undefined;
  const objects: PbxObjects = {};
  for (const [id, object] of Object.entries(value)) {
    if (!isRecord(object)) return undefined;
    objects[id] = object as PbxObject;
  }
  return objects;
}

function projectGraph(
  project: ReturnType<typeof parsePbxProject>,
  targetId: string,
): ProjectGraph | undefined {
  const archive: unknown = project;
  if (!isRecord(archive)) return undefined;
  const objects = normalizedObjects(archive.objects);
  const projectObjectId = asString(archive.rootObject);
  const projectObject = projectObjectId ? objects?.[projectObjectId] : undefined;
  const targetObject = objects?.[targetId];
  if (
    !objects ||
    !projectObjectId ||
    projectObject?.isa !== "PBXProject" ||
    targetObject?.isa !== "PBXNativeTarget" ||
    asString(targetObject.productType) !== APP_PRODUCT_TYPE
  ) {
    return undefined;
  }
  const configurationListId = asString(targetObject.buildConfigurationList);
  const configurationList = configurationListId ? objects[configurationListId] : undefined;
  if (configurationList?.isa !== "XCConfigurationList") return undefined;
  const configurationIds = exactStringArray(configurationList.buildConfigurations);
  if (
    !configurationIds ||
    configurationIds.length === 0 ||
    configurationIds.some((id) => objects[id]?.isa !== "XCBuildConfiguration")
  ) {
    return undefined;
  }
  return {
    project,
    objects,
    projectObjectId,
    projectObject,
    targetId,
    targetObject,
    configurationIds,
  };
}

function validSuppliedSelection(options: IOSMissingEntitlementsSettingsOptions): boolean {
  const projectPath = options.projectPath.replaceAll("\\", "/");
  return (
    options.targetId.trim().length > 0 &&
    projectPath.length > 0 &&
    !isAbsolute(options.projectPath) &&
    projectPath.endsWith(".xcodeproj")
  );
}

async function readProjectSnapshot(
  root: string,
  projectPath: string,
  targetId: string,
): Promise<ProjectSnapshot | undefined> {
  const absoluteProjectPath = resolve(root, projectPath);
  const pbxprojPath = resolve(absoluteProjectPath, "project.pbxproj");
  if (
    !(await pathIsSafelyWithinIOSRoot(root, absoluteProjectPath)) ||
    !(await pathIsSafelyWithinIOSRoot(root, pbxprojPath))
  ) {
    return undefined;
  }
  try {
    const [projectInfo, info] = await Promise.all([lstat(absoluteProjectPath), lstat(pbxprojPath)]);
    if (
      !projectInfo.isDirectory() ||
      projectInfo.isSymbolicLink() ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_PBXPROJ_BYTES
    ) {
      return undefined;
    }
    const bytes = new Uint8Array(await readFile(pbxprojPath));
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const project = parsePbxProject(source);
    const graph = projectGraph(project, targetId);
    if (!graph) return undefined;
    return {
      absoluteProjectPath,
      pbxprojPath,
      bytes,
      hash: hashIOSFileBytes(bytes),
      mode: info.mode & 0o7777,
      source,
      graph,
    };
  } catch {
    return undefined;
  }
}

function parentReferenceCount(objects: PbxObjects, childId: string): number {
  let count = 0;
  for (const object of Object.values(objects)) {
    const children = optionalExactStringArray(object.children);
    if (children?.includes(childId)) count += 1;
  }
  return count;
}

async function selectedSynchronizedRoot(
  root: string,
  snapshot: ProjectSnapshot,
): Promise<{ root?: SynchronizedRoot; blocker?: IOSMissingEntitlementsSettingsBlocker }> {
  const groupIds = optionalExactStringArray(
    snapshot.graph.targetObject.fileSystemSynchronizedGroups,
  );
  if (!groupIds) {
    return {
      blocker: blocker(
        "ambiguous-synchronized-root",
        "The selected target has a malformed synchronized-folder list.",
      ),
    };
  }
  if (groupIds.length === 0) {
    return {
      blocker: blocker(
        "missing-synchronized-root",
        "The selected target does not have a filesystem-synchronized source root.",
      ),
    };
  }
  if (groupIds.length !== 1) {
    return {
      blocker: blocker(
        "ambiguous-synchronized-root",
        "The selected target has more than one filesystem-synchronized source root.",
      ),
    };
  }
  const objectId = groupIds[0]!;
  const group = snapshot.graph.objects[objectId];
  if (
    group?.isa !== "PBXFileSystemSynchronizedRootGroup" ||
    !asString(group.path)?.trim() ||
    parentReferenceCount(snapshot.graph.objects, objectId) !== 1
  ) {
    return {
      blocker: blocker(
        "unsafe-synchronized-root",
        "The selected target's synchronized source root could not be resolved uniquely.",
      ),
    };
  }
  const parents = buildPbxParentIndex(snapshot.graph.objects);
  const projectDirectory = dirname(snapshot.absoluteProjectPath);
  const groupRootDirectory = resolve(
    projectDirectory,
    asString(snapshot.graph.projectObject.projectDirPath) ?? "",
  );
  const absolutePath = resolvePbxFilePath(
    objectId,
    snapshot.graph.objects,
    parents,
    projectDirectory,
    groupRootDirectory,
  );
  if (!absolutePath || !(await pathIsSafelyWithinIOSRoot(root, absolutePath))) {
    return {
      blocker: blocker(
        "unsafe-synchronized-root",
        "The selected target's synchronized source root resolves outside the invocation root.",
      ),
    };
  }
  try {
    const info = await lstat(absolutePath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsupported root");
    await realpath(absolutePath);
    return {
      root: {
        objectId,
        absolutePath,
        relativePath: relativeIOSPath(root, absolutePath),
        device: info.dev,
        inode: info.ino,
      },
    };
  } catch {
    return {
      blocker: blocker(
        "unsafe-synchronized-root",
        "The selected target's synchronized source root must be a regular, non-symlink directory.",
      ),
    };
  }
}

async function synchronizedRootIsExclusive(
  root: string,
  projectPaths: readonly string[],
  selectedProjectPath: string,
  selectedTargetId: string,
  selectedRoot: SynchronizedRoot,
  destination: string,
): Promise<boolean> {
  let selectedCanonical: string;
  let canonicalDestination: string;
  try {
    selectedCanonical = await realpath(selectedRoot.absolutePath);
    canonicalDestination = await canonicalPathWithPossibleMissingLeaf(destination);
  } catch {
    return false;
  }
  for (const absoluteProjectPath of projectPaths) {
    const pbxprojPath = resolve(absoluteProjectPath, "project.pbxproj");
    if (!(await pathIsSafelyWithinIOSRoot(root, pbxprojPath))) return false;
    let archive: unknown;
    try {
      const info = await lstat(pbxprojPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PBXPROJ_BYTES) return false;
      archive = parsePbxProject(await readFile(pbxprojPath, "utf8"));
    } catch {
      return false;
    }
    if (!isRecord(archive)) return false;
    const objects = normalizedObjects(archive.objects);
    const projectObjectId = asString(archive.rootObject);
    const projectObject = projectObjectId ? objects?.[projectObjectId] : undefined;
    if (!objects || projectObject?.isa !== "PBXProject") return false;
    const targetIds = exactStringArray(projectObject.targets);
    if (!targetIds) return false;
    const parents = buildPbxParentIndex(objects);
    const projectDirectory = dirname(absoluteProjectPath);
    const groupRootDirectory = resolve(
      projectDirectory,
      asString(projectObject.projectDirPath) ?? "",
    );
    for (const targetId of targetIds) {
      const target = objects[targetId];
      if (!target) return false;
      if (target.isa !== "PBXNativeTarget") continue;
      const groupIds = optionalExactStringArray(target.fileSystemSynchronizedGroups);
      if (!groupIds) return false;
      for (const groupId of groupIds) {
        if (
          absoluteProjectPath === selectedProjectPath &&
          targetId === selectedTargetId &&
          groupId === selectedRoot.objectId
        ) {
          continue;
        }
        const group = objects[groupId];
        if (group?.isa !== "PBXFileSystemSynchronizedRootGroup") return false;
        const groupPath = resolvePbxFilePath(
          groupId,
          objects,
          parents,
          projectDirectory,
          groupRootDirectory,
        );
        if (!groupPath || !(await pathIsSafelyWithinIOSRoot(root, groupPath))) return false;
        try {
          const info = await lstat(groupPath);
          if (!info.isDirectory() || info.isSymbolicLink()) return false;
          const canonical = await realpath(groupPath);
          if (
            canonical === selectedCanonical ||
            (info.dev === selectedRoot.device && info.ino === selectedRoot.inode) ||
            pathContains(canonical, canonicalDestination)
          ) {
            return false;
          }
        } catch (error) {
          if (!isFileSystemError(error, "ENOENT")) return false;
        }
      }
    }
  }
  return true;
}

async function canonicalPathWithPossibleMissingLeaf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
    return resolve(await realpath(dirname(path)), basename(path));
  }
}

function pathContains(directory: string, candidate: string): boolean {
  const relativePath = relative(directory, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

async function xcprojTargetEntitlementsConfigurations(
  root: string,
  snapshot: XCProjProjectSnapshot,
  target: XCProjTarget,
): Promise<Awaited<ReturnType<typeof inspectXCProjTargetBuildConfigurations>> | undefined> {
  const inspect = async (
    platform?: IOSNativePlatform,
  ): Promise<Awaited<ReturnType<typeof inspectXCProjTargetBuildConfigurations>> | undefined> => {
    const diagnostics: IOSDiagnostic[] = [];
    let configurations: Awaited<ReturnType<typeof inspectXCProjTargetBuildConfigurations>>;
    try {
      configurations = await inspectXCProjTargetBuildConfigurations({
        root,
        projectPath: snapshot.absoluteProjectPath,
        projectDocumentPath: snapshot.documentPath,
        project: snapshot.document,
        target,
        diagnostics,
        platform,
      });
    } catch {
      return undefined;
    }
    if (
      configurations.length !== snapshot.configurationIds.length ||
      configurations.length === 0 ||
      configurations.some(
        (configuration) =>
          !configuration.platformEvidenceComplete ||
          (configuration.platform === undefined && !configuration.entitlementsAssignmentAbsent) ||
          (platform !== undefined && configuration.platform !== platform) ||
          configuration.model.entitlementsPath.state === "unresolved",
      ) ||
      diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ) {
      return undefined;
    }
    return configurations;
  };

  const defaultView = await inspect();
  if (!defaultView) return undefined;
  const platforms = [
    ...new Set(defaultView.flatMap((configuration) => configuration.supportedPlatforms)),
  ];
  if (platforms.length === 0) return defaultView;

  const configurations: Awaited<ReturnType<typeof inspectXCProjTargetBuildConfigurations>> = [];
  for (const platform of platforms) {
    const platformView = await inspect(platform);
    if (!platformView) return undefined;
    configurations.push(...platformView);
  }
  return configurations;
}

async function xcprojDestinationOwnershipIsExclusive(
  root: string,
  inventoryProjectPaths: readonly string[],
  snapshot: XCProjProjectSnapshot,
  selectedPlatform: IOSNativePlatform,
  synchronizedRoot: SynchronizedRoot,
  destination: string,
): Promise<boolean> {
  if (
    inventoryProjectPaths.length !== 1 ||
    resolve(inventoryProjectPaths[0]!) !== snapshot.absoluteProjectPath
  ) {
    // Cross-project ownership is intentionally refused until every referenced
    // project format can contribute the same semantic ownership inventory.
    return false;
  }

  let canonicalDestination: string;
  let canonicalSelectedRoot: string;
  try {
    canonicalDestination = (
      await canonicalPathWithPossibleMissingLeaf(destination)
    ).toLocaleLowerCase("en-US");
    canonicalSelectedRoot = (await realpath(synchronizedRoot.absolutePath)).toLocaleLowerCase(
      "en-US",
    );
  } catch {
    return false;
  }

  for (const target of xcprojTargets(snapshot.document)) {
    const configurations = await xcprojTargetEntitlementsConfigurations(root, snapshot, target);
    if (!configurations) return false;
    for (const configuration of configurations) {
      if (target.id === snapshot.target.id && configuration.platform === selectedPlatform) continue;
      const entitlementsPath = configuration.model.entitlementsPath;
      if (entitlementsPath.state === "missing") continue;
      if (entitlementsPath.state !== "resolved") return false;
      const value = entitlementsPath.value.trim();
      if (!value) continue;
      const targetPath = resolve(dirname(snapshot.absoluteProjectPath), value);
      if (!(await pathIsSafelyWithinIOSRoot(root, targetPath))) return false;
      try {
        if (
          (await canonicalPathWithPossibleMissingLeaf(targetPath)).toLocaleLowerCase("en-US") ===
          canonicalDestination
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }
  }

  let complete = true;
  const projectDirectory = dirname(snapshot.absoluteProjectPath);
  const visit = async (value: unknown, parent: string): Promise<void> => {
    let reference: XCProjRecord;
    try {
      reference = xcprojRecord(value);
    } catch {
      complete = false;
      return;
    }
    const kind = typeof reference.kind === "string" ? reference.kind : "file";
    const path = typeof reference.path === "string" ? reference.path : "";
    if (kind === "group") {
      const groupDirectory = path ? xcprojReferencePath(parent, path, projectDirectory) : parent;
      if (!groupDirectory) {
        complete = false;
        return;
      }
      let children: unknown[];
      try {
        children = xcprojArray(reference.children ?? []);
      } catch {
        complete = false;
        return;
      }
      for (const child of children) await visit(child, groupDirectory);
      return;
    }
    if (kind === "folder") {
      const folderPath = xcprojReferencePath(parent, path, projectDirectory);
      if (!folderPath || !(await pathIsSafelyWithinIOSRoot(root, folderPath))) {
        complete = false;
        return;
      }
      let memberships: string[];
      try {
        memberships = xcprojStringArray(reference["target-membership"] ?? []);
      } catch {
        complete = false;
        return;
      }
      if (reference["membership-exceptions"] !== undefined) {
        complete = false;
        return;
      }
      if (memberships.some((name) => name !== snapshot.target.name)) {
        try {
          const canonicalFolder = (await realpath(folderPath)).toLocaleLowerCase("en-US");
          if (
            canonicalFolder === canonicalSelectedRoot ||
            pathContains(canonicalFolder, canonicalDestination)
          ) {
            complete = false;
          }
        } catch {
          complete = false;
        }
      }
      return;
    }
    if (kind === "variant-group" || kind === "version-group") return;
    if (kind !== "file" && kind !== "file-reference") {
      complete = false;
      return;
    }
    if (!path || /^<(?:PRODUCTS|SDK|DEVELOPER)>\//.test(path)) return;
    const referencedPath = xcprojReferencePath(parent, path, projectDirectory);
    if (!referencedPath || !(await pathIsSafelyWithinIOSRoot(root, referencedPath))) {
      complete = false;
      return;
    }
    try {
      if (
        (await canonicalPathWithPossibleMissingLeaf(referencedPath)).toLocaleLowerCase("en-US") ===
        canonicalDestination
      ) {
        complete = false;
      }
    } catch {
      complete = false;
    }
  };
  try {
    for (const reference of xcprojArray(snapshot.document.files)) {
      await visit(reference, projectDirectory);
    }
  } catch {
    return false;
  }
  return complete;
}

type GitIgnoreState = "not-repository" | "included" | "ignored" | "error";

async function findGitMarker(
  start: string,
): Promise<{ state: "found"; directory: string } | { state: "none" | "error" }> {
  let directory = resolve(start);
  while (true) {
    try {
      await lstat(resolve(directory, ".git"));
      return { state: "found", directory };
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) return { state: "error" };
    }
    const parent = dirname(directory);
    if (parent === directory) return { state: "none" };
    directory = parent;
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string } | undefined> {
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).arrayBuffer();
    const [exitCode, output] = await Promise.all([child.exited, stdout, stderr]).then(
      ([code, text]) => [code, text] as const,
    );
    return { exitCode, stdout: output };
  } catch {
    return undefined;
  }
}

async function gitIgnoreState(destination: string): Promise<GitIgnoreState> {
  const marker = await findGitMarker(dirname(destination));
  if (marker.state === "none") return "not-repository";
  if (marker.state === "error") return "error";

  const repository = await runGit(dirname(destination), ["rev-parse", "--show-toplevel"]);
  if (!repository || repository.exitCode !== 0) return "error";
  const lines = repository.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1 || !isAbsolute(lines[0]!)) return "error";

  try {
    const canonicalRepository = await realpath(lines[0]!);
    const canonicalDestination = await canonicalPathWithPossibleMissingLeaf(destination);
    if (!pathContains(canonicalRepository, canonicalDestination)) return "error";
    const repositoryRelativePath = relative(canonicalRepository, canonicalDestination)
      .split(sep)
      .join("/");
    if (
      !repositoryRelativePath ||
      repositoryRelativePath === ".." ||
      repositoryRelativePath.startsWith("../") ||
      isAbsolute(repositoryRelativePath)
    ) {
      return "error";
    }
    const checked = await runGit(canonicalRepository, [
      "check-ignore",
      "--quiet",
      "--no-index",
      "--",
      repositoryRelativePath,
    ]);
    if (!checked) return "error";
    if (checked.exitCode === 0) return "ignored";
    if (checked.exitCode === 1) return "included";
    return "error";
  } catch {
    return "error";
  }
}

async function classicDestinationIsUnreferenced(
  root: string,
  projectPaths: readonly string[],
  destination: string,
): Promise<boolean> {
  const normalizedDestination = resolve(destination).toLocaleLowerCase("en-US");
  let canonicalDestination: string;
  try {
    canonicalDestination = (
      await canonicalPathWithPossibleMissingLeaf(destination)
    ).toLocaleLowerCase("en-US");
  } catch {
    return false;
  }
  for (const absoluteProjectPath of projectPaths) {
    const pbxprojPath = resolve(absoluteProjectPath, "project.pbxproj");
    if (!(await pathIsSafelyWithinIOSRoot(root, pbxprojPath))) return false;
    let archive: unknown;
    try {
      const info = await lstat(pbxprojPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PBXPROJ_BYTES) return false;
      archive = parsePbxProject(await readFile(pbxprojPath, "utf8"));
    } catch {
      return false;
    }
    if (!isRecord(archive)) return false;
    const objects = normalizedObjects(archive.objects);
    const projectObjectId = asString(archive.rootObject);
    const projectObject = projectObjectId ? objects?.[projectObjectId] : undefined;
    if (!objects || projectObject?.isa !== "PBXProject") return false;
    const parents = buildPbxParentIndex(objects);
    const projectDirectory = dirname(absoluteProjectPath);
    const groupRootDirectory = resolve(
      projectDirectory,
      asString(projectObject.projectDirPath) ?? "",
    );
    for (const [objectId, object] of Object.entries(objects)) {
      if (object.isa !== "PBXFileReference") continue;
      const referencedPath = resolvePbxFilePath(
        objectId,
        objects,
        parents,
        projectDirectory,
        groupRootDirectory,
      );
      if (!referencedPath) continue;
      if (referencedPath.toLocaleLowerCase("en-US") === normalizedDestination) return false;
      try {
        if (
          (await canonicalPathWithPossibleMissingLeaf(referencedPath)).toLocaleLowerCase(
            "en-US",
          ) === canonicalDestination
        ) {
          return false;
        }
      } catch {
        // An unrelated unresolved reference cannot alias the existing parent
        // of this exact destination without first becoming inspectable.
      }
    }
  }
  return true;
}

async function entitlementsDestinationIsExclusive(
  root: string,
  projectPaths: readonly string[],
  selectedProjectPath: string,
  selectedTargetId: string,
  selectedPlatform: IOSNativePlatform,
  destination: string,
): Promise<boolean> {
  const normalizedDestination = resolve(destination).toLocaleLowerCase("en-US");
  let canonicalDestination: string;
  try {
    canonicalDestination = (
      await canonicalPathWithPossibleMissingLeaf(destination)
    ).toLocaleLowerCase("en-US");
  } catch {
    return false;
  }
  for (const absoluteProjectPath of projectPaths) {
    const pbxprojPath = resolve(absoluteProjectPath, "project.pbxproj");
    if (!(await pathIsSafelyWithinIOSRoot(root, pbxprojPath))) return false;
    let archive: unknown;
    try {
      const info = await lstat(pbxprojPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PBXPROJ_BYTES) return false;
      archive = parsePbxProject(await readFile(pbxprojPath, "utf8"));
    } catch {
      return false;
    }
    if (!isRecord(archive)) return false;
    const objects = normalizedObjects(archive.objects);
    const projectObjectId = asString(archive.rootObject);
    const projectObject = projectObjectId ? objects?.[projectObjectId] : undefined;
    if (!objects || projectObject?.isa !== "PBXProject") return false;
    const targetIds = exactStringArray(projectObject.targets);
    if (!targetIds) return false;
    const parents = buildPbxParentIndex(objects);
    const groupRootDirectory = resolve(
      dirname(absoluteProjectPath),
      asString(projectObject.projectDirPath) ?? "",
    );
    for (const targetId of targetIds) {
      const targetObject = objects[targetId];
      if (!targetObject) return false;
      if (targetObject.isa !== "PBXNativeTarget") continue;
      const primaryDiagnostics: IOSDiagnostic[] = [];
      const primaryConfigurations = await inspectTargetBuildConfigurations({
        root,
        projectPath: absoluteProjectPath,
        groupRootDirectory,
        projectObject,
        targetId,
        targetObject,
        objects,
        parents,
        diagnostics: primaryDiagnostics,
      });
      // A sibling with no entitlement assignment cannot share this file.
      // Do not infer absence from modeled platform values alone.
      if (
        !(absoluteProjectPath === selectedProjectPath && targetId === selectedTargetId) &&
        primaryConfigurations.length > 0 &&
        !primaryDiagnostics.some((diagnostic) => diagnostic.severity === "error") &&
        primaryConfigurations.every((configuration) => configuration.entitlementsAssignmentAbsent)
      ) {
        continue;
      }
      if (
        primaryConfigurations.length === 0 ||
        primaryConfigurations.some(
          (configuration) =>
            !configuration.platformEvidenceComplete || configuration.platform === undefined,
        ) ||
        primaryDiagnostics.some((diagnostic) => diagnostic.severity === "error")
      ) {
        return false;
      }
      const primaryPlatforms = new Set(
        primaryConfigurations
          .map((configuration) => configuration.platform)
          .filter((platform): platform is IOSNativePlatform => platform !== undefined),
      );
      if (primaryPlatforms.size > 1) return false;
      const primaryPlatform = [...primaryPlatforms][0];
      const supportedPlatforms = new Set(
        primaryConfigurations.flatMap((configuration) => configuration.supportedPlatforms),
      );
      const views: Array<{
        platform?: IOSNativePlatform;
        configurations: typeof primaryConfigurations;
      }> = [{ platform: primaryPlatform, configurations: primaryConfigurations }];
      for (const platform of supportedPlatforms) {
        if (platform === primaryPlatform) continue;
        const diagnostics: IOSDiagnostic[] = [];
        const configurations = await inspectTargetBuildConfigurations({
          root,
          projectPath: absoluteProjectPath,
          groupRootDirectory,
          projectObject,
          targetId,
          targetObject,
          objects,
          parents,
          diagnostics,
          platform,
        });
        if (
          configurations.length !== primaryConfigurations.length ||
          configurations.length === 0 ||
          configurations.some(
            (configuration) =>
              !configuration.platformEvidenceComplete || configuration.platform !== platform,
          ) ||
          diagnostics.some((diagnostic) => diagnostic.severity === "error")
        ) {
          return false;
        }
        views.push({ platform, configurations });
      }
      for (const view of views) {
        if (
          absoluteProjectPath === selectedProjectPath &&
          targetId === selectedTargetId &&
          view.platform === selectedPlatform
        ) {
          continue;
        }
        for (const configuration of view.configurations) {
          const resolution = configuration.model.entitlementsPath;
          if (resolution.state === "unresolved") return false;
          if (resolution.state !== "resolved") continue;
          const siblingPath = resolve(dirname(absoluteProjectPath), resolution.value);
          if (!(await pathIsSafelyWithinIOSRoot(root, siblingPath))) return false;
          if (siblingPath.toLocaleLowerCase("en-US") === normalizedDestination) return false;
          try {
            if (
              (await canonicalPathWithPossibleMissingLeaf(siblingPath)).toLocaleLowerCase(
                "en-US",
              ) === canonicalDestination
            ) {
              return false;
            }
          } catch {
            return false;
          }
        }
      }
    }
  }
  return true;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function destinationForRoot(
  root: string,
  absoluteProjectPath: string,
  synchronizedRoot: SynchronizedRoot,
  platform: IOSNativePlatform,
  platformSpecific: boolean,
):
  | { absolutePath: string; relativePath: string; buildSettingPath: string }
  | { blocker: IOSMissingEntitlementsSettingsBlocker } {
  const rootName = basename(synchronizedRoot.absolutePath);
  if (
    !rootName ||
    rootName === "." ||
    rootName === ".." ||
    rootName.includes("\0") ||
    rootName.length > 200
  ) {
    return {
      blocker: blocker(
        "invalid-entitlements-destination",
        "A deterministic entitlements filename could not be derived from the synchronized root.",
      ),
    };
  }
  const suffix = platform === "macos" && platformSpecific ? ".mac.entitlements" : ".entitlements";
  const absolutePath = resolve(synchronizedRoot.absolutePath, `${rootName}${suffix}`);
  const projectDirectory = dirname(absoluteProjectPath);
  const buildSettingPath = relative(projectDirectory, absolutePath).split(sep).join("/");
  if (
    dirname(absolutePath) !== synchronizedRoot.absolutePath ||
    !buildSettingPath ||
    buildSettingPath === ".." ||
    buildSettingPath.startsWith("../") ||
    isAbsolute(buildSettingPath)
  ) {
    return {
      blocker: blocker(
        "invalid-entitlements-destination",
        "The derived entitlements destination is not safely inside the synchronized root.",
      ),
    };
  }
  return {
    absolutePath,
    relativePath: relativeIOSPath(root, absolutePath),
    buildSettingPath,
  };
}

async function destinationState(
  synchronizedRoot: SynchronizedRoot,
  absolutePath: string,
): Promise<"absent" | "regular" | "unsupported" | "case-collision"> {
  try {
    const info = await lstat(absolutePath);
    return info.isFile() && !info.isSymbolicLink() ? "regular" : "unsupported";
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) return "unsupported";
  }
  try {
    const expectedName = basename(absolutePath).toLocaleLowerCase("en-US");
    const entries = await readdir(synchronizedRoot.absolutePath);
    if (entries.some((entry) => entry.toLocaleLowerCase("en-US") === expectedName)) {
      return "case-collision";
    }
    return "absent";
  } catch {
    return "unsupported";
  }
}

function settingsDictionary(
  graph: ProjectGraph,
  configurationId: string,
): Record<string, unknown> | undefined {
  const settings = graph.objects[configurationId]?.buildSettings;
  return isRecord(settings) ? settings : undefined;
}

function entitlementsSettingKeys(platform: IOSNativePlatform): readonly string[] {
  return platform === "macos" ? [MACOS_SETTING] : [DEVICE_SETTING, SIMULATOR_SETTING];
}

function rawSettingsAreExact(
  graph: ProjectGraph,
  buildSettingPath: string,
  platform: IOSNativePlatform,
): boolean {
  const keys = entitlementsSettingKeys(platform);
  return graph.configurationIds.every((id) => {
    const settings = settingsDictionary(graph, id);
    return keys.every((key) => settings?.[key] === buildSettingPath);
  });
}

async function buildSettingState(
  root: string,
  snapshot: ProjectSnapshot,
  buildSettingPath: string,
  platform: IOSNativePlatform,
): Promise<"missing" | "exact" | "conflicting" | "incomplete"> {
  const diagnostics: IOSDiagnostic[] = [];
  const parents = buildPbxParentIndex(snapshot.graph.objects);
  const groupRootDirectory = resolve(
    dirname(snapshot.absoluteProjectPath),
    asString(snapshot.graph.projectObject.projectDirPath) ?? "",
  );
  const inspected = await inspectTargetBuildConfigurations({
    root,
    projectPath: snapshot.absoluteProjectPath,
    groupRootDirectory,
    projectObject: snapshot.graph.projectObject,
    targetId: snapshot.graph.targetId,
    targetObject: snapshot.graph.targetObject,
    objects: snapshot.graph.objects,
    parents,
    diagnostics,
    platform,
  });
  if (
    inspected.length !== snapshot.graph.configurationIds.length ||
    inspected.length === 0 ||
    inspected.some((configuration) => !configuration.platformEvidenceComplete) ||
    !inspected.every((configuration) => configuration.platform === platform) ||
    diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    return "incomplete";
  }
  if (
    inspected.every((configuration) => configuration.model.entitlementsPath.state === "missing")
  ) {
    return "missing";
  }
  if (
    rawSettingsAreExact(snapshot.graph, buildSettingPath, platform) &&
    inspected.every(
      (configuration) =>
        configuration.model.entitlementsPath.state === "resolved" &&
        configuration.model.entitlementsPath.value === buildSettingPath,
    )
  ) {
    return "exact";
  }
  return "conflicting";
}

function xcprojRawSettingsAreExact(
  target: XCProjTarget,
  buildSettingPath: string,
  platform: IOSNativePlatform,
): boolean {
  if (target.buildSettings.CODE_SIGN_ENTITLEMENTS === buildSettingPath) return true;
  if (target.buildSettings.CODE_SIGN_ENTITLEMENTS !== undefined) return false;
  return entitlementsSettingKeys(platform).every(
    (key) => target.buildSettings[key] === buildSettingPath,
  );
}

async function xcprojBuildSettingState(
  root: string,
  snapshot: XCProjProjectSnapshot,
  buildSettingPath: string,
  platform: IOSNativePlatform,
): Promise<"missing" | "exact" | "conflicting" | "incomplete"> {
  const diagnostics: IOSDiagnostic[] = [];
  let inspected;
  try {
    inspected = await inspectXCProjTargetBuildConfigurations({
      root,
      projectPath: snapshot.absoluteProjectPath,
      projectDocumentPath: snapshot.documentPath,
      project: snapshot.document,
      target: snapshot.target,
      diagnostics,
      platform,
    });
  } catch {
    return "incomplete";
  }
  if (
    inspected.length !== snapshot.configurationIds.length ||
    inspected.length === 0 ||
    inspected.some((configuration) => !configuration.platformEvidenceComplete) ||
    !inspected.every((configuration) => configuration.platform === platform) ||
    diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    return "incomplete";
  }
  if (
    inspected.every((configuration) => configuration.model.entitlementsPath.state === "missing")
  ) {
    return "missing";
  }
  if (
    xcprojRawSettingsAreExact(snapshot.target, buildSettingPath, platform) &&
    inspected.every(
      (configuration) =>
        configuration.model.entitlementsPath.state === "resolved" &&
        configuration.model.entitlementsPath.value === buildSettingPath,
    )
  ) {
    return "exact";
  }
  return "conflicting";
}

async function inspectSelectedTarget(
  root: string,
  projectPath: string,
  targetId: string,
  platform: IOSNativePlatform,
): Promise<
  | {
      name: string;
      platform: IOSNativePlatform;
      supportedPlatforms: IOSNativePlatform[];
      platformEvidenceComplete: boolean;
    }
  | undefined
> {
  const inspection = await inspectIOSProject(root, {
    target: targetId,
    exhaustiveContainerDiscovery: true,
    platform,
  });
  if (
    inspection.selection.state !== "selected" ||
    inspection.selection.targetId !== targetId ||
    inspection.selection.projectPath !== projectPath
  ) {
    return undefined;
  }
  const target = inspection.appTargets.find(
    (target) => target.id === targetId && target.projectPath === projectPath,
  );
  return target
    ? {
        name: target.name,
        platform: target.platform,
        supportedPlatforms: target.supportedPlatforms,
        platformEvidenceComplete: target.platformEvidenceComplete,
      }
    : undefined;
}

async function planXCProjMissingEntitlementsSettings(
  options: IOSMissingEntitlementsSettingsOptions & { platform: IOSNativePlatform },
  documentRef: XcodeProjectDocumentRef,
): Promise<IOSMissingEntitlementsSettingsPlan> {
  const snapshot = await readXCProjSnapshot(options.root, documentRef, options.targetId);
  if (!snapshot) {
    return blockedPlan(
      options,
      blocker(
        "unreadable-project",
        "The selected project.xcproj is missing, malformed, symlinked, too large, or unreadable.",
      ),
    );
  }
  const selectedTarget = await inspectSelectedTarget(
    options.root,
    options.projectPath,
    options.targetId,
    options.platform,
  );
  const snapshotFields = {
    projectFormat: "xcproj" as const,
    expectedPbxprojHash: snapshot.hash,
    expectedPbxprojMode: snapshot.mode,
    configurationIds: snapshot.configurationIds,
  };
  if (
    !selectedTarget ||
    selectedTarget.platform !== options.platform ||
    !selectedTarget.supportedPlatforms.includes(options.platform)
  ) {
    return blockedPlan(
      options,
      blocker(
        "target-not-found",
        `The selected object is not the exact inspected native ${options.platform === "macos" ? "macOS" : "iOS"} application target.`,
      ),
      snapshotFields,
    );
  }
  if (!selectedTarget.platformEvidenceComplete) {
    return blockedPlan(
      options,
      blocker(
        "incomplete-build-configurations",
        `Every selected-target build configuration must prove ${options.platform === "macos" ? "macOS" : "iOS"} support before adding entitlements settings.`,
      ),
      { ...snapshotFields, targetName: selectedTarget.name },
    );
  }

  const synchronized = await selectedXCProjSynchronizedRoot(options.root, snapshot);
  if (!synchronized.root) {
    return blockedPlan(options, synchronized.blocker!, {
      ...snapshotFields,
      targetName: selectedTarget.name,
    });
  }
  const destination = destinationForRoot(
    options.root,
    snapshot.absoluteProjectPath,
    synchronized.root,
    options.platform,
    options.platform === "macos" && selectedTarget.supportedPlatforms.includes("ios"),
  );
  if ("blocker" in destination) {
    return blockedPlan(options, destination.blocker, {
      ...snapshotFields,
      targetName: selectedTarget.name,
      synchronizedRootPath: synchronized.root.relativePath,
      synchronizedRootObjectId: synchronized.root.objectId,
      expectedSynchronizedRootIdentity: {
        device: synchronized.root.device,
        inode: synchronized.root.inode,
      },
    });
  }

  const inventory = await discoverLocalIOSProjects(options.root, [snapshot.absoluteProjectPath]);
  if (
    !inventory.complete ||
    !(await xcprojDestinationOwnershipIsExclusive(
      options.root,
      inventory.projectPaths,
      snapshot,
      options.platform,
      synchronized.root,
      destination.absolutePath,
    ))
  ) {
    return blockedPlan(
      options,
      blocker(
        "shared-synchronized-root",
        "The synchronized source root or entitlements destination is shared with another target, or exclusive ownership could not be proven.",
      ),
      {
        ...snapshotFields,
        targetName: selectedTarget.name,
        synchronizedRootPath: synchronized.root.relativePath,
        synchronizedRootObjectId: synchronized.root.objectId,
        expectedSynchronizedRootIdentity: {
          device: synchronized.root.device,
          inode: synchronized.root.inode,
        },
      },
    );
  }
  if (!(await pathIsSafelyWithinIOSRoot(options.root, destination.absolutePath))) {
    return blockedPlan(
      options,
      blocker(
        "invalid-entitlements-destination",
        "The entitlements destination resolves outside the invocation root.",
      ),
      { ...snapshotFields, targetName: selectedTarget.name },
    );
  }
  const ignoreState = await gitIgnoreState(destination.absolutePath);
  if (ignoreState === "ignored" || ignoreState === "error") {
    return blockedPlan(
      options,
      blocker(
        ignoreState === "ignored" ? "ignored-entitlements-destination" : "unresolved-git-ignore",
        ignoreState === "ignored"
          ? `${destination.relativePath} is ignored by Git. Add a targeted .gitignore negation before automatic setup.`
          : `Git ignore status for ${destination.relativePath} could not be verified safely.`,
      ),
      { ...snapshotFields, targetName: selectedTarget.name },
    );
  }

  const settingState = await xcprojBuildSettingState(
    options.root,
    snapshot,
    destination.buildSettingPath,
    options.platform,
  );
  const sharedPlanFields: IOSMissingEntitlementsSettingsResolvedFields & {
    configurationIds: string[];
  } = {
    ...snapshotFields,
    targetName: selectedTarget.name,
    entitlementsPath: destination.relativePath,
    buildSettingPath: destination.buildSettingPath,
    synchronizedRootPath: synchronized.root.relativePath,
    synchronizedRootObjectId: synchronized.root.objectId,
    expectedSynchronizedRootIdentity: {
      device: synchronized.root.device,
      inode: synchronized.root.inode,
    },
  };
  if (settingState === "incomplete" || settingState === "conflicting") {
    return blockedPlan(
      options,
      blocker(
        settingState === "incomplete"
          ? "incomplete-build-configurations"
          : "conflicting-entitlements-settings",
        settingState === "incomplete"
          ? `Every selected-target build configuration and ${options.platform === "macos" ? "macOS" : "iOS"} build context must be inspectable before adding entitlements settings.`
          : `The selected target already has partial, inherited, unresolved, or conflicting ${options.platform === "macos" ? "macOS" : "iOS"} entitlements settings.`,
      ),
      sharedPlanFields,
    );
  }
  const pathState = await destinationState(synchronized.root, destination.absolutePath);
  if (settingState === "missing") {
    if (pathState !== "absent") {
      return blockedPlan(
        options,
        blocker(
          "entitlements-destination-exists",
          "The intended entitlements destination already exists; it will not be adopted or overwritten.",
        ),
        sharedPlanFields,
      );
    }
    const generator = await generatedProjectKind(options.root, snapshot.absoluteProjectPath);
    if (generator) {
      return blockedPlan(
        options,
        blocker(
          "generated-project",
          `This is a ${generator === "xcodegen" ? "XcodeGen" : "Tuist"} project; update its source manifest instead of generated project.xcproj output.`,
        ),
        sharedPlanFields,
      );
    }
  } else if (pathState === "unsupported" || pathState === "case-collision") {
    return blockedPlan(
      options,
      blocker(
        "invalid-entitlements-destination",
        "The configured entitlements destination is a symlink, directory, case-colliding path, or unreadable entry.",
      ),
      sharedPlanFields,
    );
  }
  return {
    ...planBase(options),
    ...sharedPlanFields,
    status: settingState === "exact" ? "satisfied" : "ready",
    actions:
      settingState === "exact"
        ? []
        : [
            options.platform === "macos"
              ? `Add a macOS CODE_SIGN_ENTITLEMENTS setting for ${destination.relativePath} to the selected target.`
              : `Add iOS device and simulator CODE_SIGN_ENTITLEMENTS settings for ${destination.relativePath} to the selected target.`,
          ],
    blockers: [],
  };
}

export async function planIOSMissingEntitlementsSettings(
  options: IOSMissingEntitlementsSettingsOptions,
): Promise<IOSMissingEntitlementsSettingsPlan> {
  const root = resolve(options.root);
  const normalizedProjectPath = options.projectPath.replaceAll("\\", "/");
  const normalizedOptions = {
    ...options,
    root,
    projectPath: normalizedProjectPath,
    platform: options.platform ?? "ios",
  };
  if (!validSuppliedSelection(normalizedOptions)) {
    return blockedPlan(
      normalizedOptions,
      blocker(
        "invalid-selection",
        "A selected root-relative .xcodeproj and target object ID are required.",
      ),
    );
  }
  const absoluteProjectPath = resolve(root, normalizedProjectPath);
  const documentResolution = await resolveXcodeProjectDocument(absoluteProjectPath);
  if (!(await pathIsSafelyWithinIOSRoot(root, absoluteProjectPath))) {
    return blockedPlan(
      normalizedOptions,
      blocker("external-path", "The selected Xcode project resolves outside the invocation root."),
    );
  }
  if (documentResolution.status !== "found") {
    return blockedPlan(
      normalizedOptions,
      blocker(
        "unreadable-project",
        documentResolution.status === "ambiguous"
          ? "The selected Xcode project contains both project.pbxproj and project.xcproj. Keep only the intended project document before automatic setup."
          : "The selected Xcode project has no readable regular project.pbxproj or project.xcproj document.",
      ),
    );
  }
  if (!(await pathIsSafelyWithinIOSRoot(root, documentResolution.document.absolutePath))) {
    return blockedPlan(
      normalizedOptions,
      blocker("external-path", "The selected Xcode project resolves outside the invocation root."),
    );
  }
  if (documentResolution.document.format === "xcproj") {
    return planXCProjMissingEntitlementsSettings(normalizedOptions, documentResolution.document);
  }
  const snapshot = await readProjectSnapshot(root, normalizedProjectPath, options.targetId);
  if (!snapshot) {
    return blockedPlan(
      normalizedOptions,
      blocker(
        "unreadable-project",
        "The selected project.pbxproj is missing, malformed, symlinked, too large, or unreadable.",
      ),
    );
  }
  const selectedTarget = await inspectSelectedTarget(
    root,
    normalizedProjectPath,
    options.targetId,
    normalizedOptions.platform,
  );
  if (
    !selectedTarget ||
    selectedTarget.platform !== normalizedOptions.platform ||
    !selectedTarget.supportedPlatforms.includes(normalizedOptions.platform)
  ) {
    return blockedPlan(
      normalizedOptions,
      blocker(
        "target-not-found",
        `The selected object is not the exact inspected native ${normalizedOptions.platform === "macos" ? "macOS" : "iOS"} application target.`,
      ),
      {
        expectedPbxprojHash: snapshot.hash,
        expectedPbxprojMode: snapshot.mode,
        configurationIds: snapshot.graph.configurationIds,
      },
    );
  }
  if (!selectedTarget.platformEvidenceComplete) {
    return blockedPlan(
      normalizedOptions,
      blocker(
        "incomplete-build-configurations",
        `Every selected-target build configuration must prove ${normalizedOptions.platform === "macos" ? "macOS" : "iOS"} support before adding entitlements settings.`,
      ),
      {
        targetName: selectedTarget.name,
        expectedPbxprojHash: snapshot.hash,
        expectedPbxprojMode: snapshot.mode,
        configurationIds: snapshot.graph.configurationIds,
      },
    );
  }
  const targetName = selectedTarget.name;
  const synchronized = await selectedSynchronizedRoot(root, snapshot);
  if (!synchronized.root) {
    return blockedPlan(normalizedOptions, synchronized.blocker!, {
      targetName,
      expectedPbxprojHash: snapshot.hash,
      expectedPbxprojMode: snapshot.mode,
      configurationIds: snapshot.graph.configurationIds,
    });
  }
  const destination = destinationForRoot(
    root,
    snapshot.absoluteProjectPath,
    synchronized.root,
    normalizedOptions.platform,
    normalizedOptions.platform === "macos" && selectedTarget.supportedPlatforms.includes("ios"),
  );
  if ("blocker" in destination) {
    return blockedPlan(normalizedOptions, destination.blocker, {
      targetName,
      synchronizedRootPath: synchronized.root.relativePath,
      synchronizedRootObjectId: synchronized.root.objectId,
      expectedSynchronizedRootIdentity: {
        device: synchronized.root.device,
        inode: synchronized.root.inode,
      },
      expectedPbxprojHash: snapshot.hash,
      expectedPbxprojMode: snapshot.mode,
      configurationIds: snapshot.graph.configurationIds,
    });
  }
  const inventory = await discoverLocalIOSProjects(root, [snapshot.absoluteProjectPath]);
  if (
    !inventory.complete ||
    !(await synchronizedRootIsExclusive(
      root,
      inventory.projectPaths,
      snapshot.absoluteProjectPath,
      options.targetId,
      synchronized.root,
      destination.absolutePath,
    ))
  ) {
    return blockedPlan(
      normalizedOptions,
      blocker(
        "shared-synchronized-root",
        "The synchronized source root is shared with another target, or exclusive ownership could not be proven.",
      ),
      {
        targetName,
        synchronizedRootPath: synchronized.root.relativePath,
        synchronizedRootObjectId: synchronized.root.objectId,
        expectedSynchronizedRootIdentity: {
          device: synchronized.root.device,
          inode: synchronized.root.inode,
        },
        expectedPbxprojHash: snapshot.hash,
        expectedPbxprojMode: snapshot.mode,
        configurationIds: snapshot.graph.configurationIds,
      },
    );
  }
  if (!(await pathIsSafelyWithinIOSRoot(root, destination.absolutePath))) {
    return blockedPlan(
      normalizedOptions,
      blocker(
        "invalid-entitlements-destination",
        "The entitlements destination resolves outside the invocation root.",
      ),
      { targetName, configurationIds: snapshot.graph.configurationIds },
    );
  }
  const ignoreState = await gitIgnoreState(destination.absolutePath);
  if (ignoreState === "ignored" || ignoreState === "error") {
    return blockedPlan(
      normalizedOptions,
      blocker(
        ignoreState === "ignored" ? "ignored-entitlements-destination" : "unresolved-git-ignore",
        ignoreState === "ignored"
          ? `${destination.relativePath} is ignored by Git. Add a targeted .gitignore negation before automatic setup.`
          : `Git ignore status for ${destination.relativePath} could not be verified safely.`,
      ),
      {
        targetName,
        entitlementsPath: destination.relativePath,
        buildSettingPath: destination.buildSettingPath,
        synchronizedRootPath: synchronized.root.relativePath,
        synchronizedRootObjectId: synchronized.root.objectId,
        expectedSynchronizedRootIdentity: {
          device: synchronized.root.device,
          inode: synchronized.root.inode,
        },
        expectedPbxprojHash: snapshot.hash,
        expectedPbxprojMode: snapshot.mode,
        configurationIds: snapshot.graph.configurationIds,
      },
    );
  }
  if (
    !(await classicDestinationIsUnreferenced(
      root,
      inventory.projectPaths,
      destination.absolutePath,
    ))
  ) {
    return blockedPlan(
      normalizedOptions,
      blocker(
        "entitlements-destination-exists",
        "The intended entitlements destination is already represented by an Xcode file reference; it will not be adopted or overwritten.",
      ),
      {
        targetName,
        entitlementsPath: destination.relativePath,
        buildSettingPath: destination.buildSettingPath,
        synchronizedRootPath: synchronized.root.relativePath,
        synchronizedRootObjectId: synchronized.root.objectId,
        expectedSynchronizedRootIdentity: {
          device: synchronized.root.device,
          inode: synchronized.root.inode,
        },
        expectedPbxprojHash: snapshot.hash,
        expectedPbxprojMode: snapshot.mode,
        configurationIds: snapshot.graph.configurationIds,
      },
    );
  }
  if (
    !(await entitlementsDestinationIsExclusive(
      root,
      inventory.projectPaths,
      snapshot.absoluteProjectPath,
      options.targetId,
      normalizedOptions.platform,
      destination.absolutePath,
    ))
  ) {
    return blockedPlan(
      normalizedOptions,
      blocker(
        "shared-entitlements-destination",
        "The intended entitlements destination is referenced by another target, or exclusive use could not be proven.",
      ),
      {
        targetName,
        entitlementsPath: destination.relativePath,
        buildSettingPath: destination.buildSettingPath,
        synchronizedRootPath: synchronized.root.relativePath,
        synchronizedRootObjectId: synchronized.root.objectId,
        expectedSynchronizedRootIdentity: {
          device: synchronized.root.device,
          inode: synchronized.root.inode,
        },
        expectedPbxprojHash: snapshot.hash,
        expectedPbxprojMode: snapshot.mode,
        configurationIds: snapshot.graph.configurationIds,
      },
    );
  }
  const settingState = await buildSettingState(
    root,
    snapshot,
    destination.buildSettingPath,
    normalizedOptions.platform,
  );
  const sharedPlanFields: IOSMissingEntitlementsSettingsResolvedFields & {
    configurationIds: string[];
  } = {
    projectFormat: "pbxproj",
    targetName,
    entitlementsPath: destination.relativePath,
    buildSettingPath: destination.buildSettingPath,
    synchronizedRootPath: synchronized.root.relativePath,
    synchronizedRootObjectId: synchronized.root.objectId,
    expectedSynchronizedRootIdentity: {
      device: synchronized.root.device,
      inode: synchronized.root.inode,
    },
    expectedPbxprojHash: snapshot.hash,
    expectedPbxprojMode: snapshot.mode,
    configurationIds: snapshot.graph.configurationIds,
  };
  if (settingState === "incomplete") {
    return blockedPlan(
      normalizedOptions,
      blocker(
        "incomplete-build-configurations",
        `Every selected-target build configuration and ${normalizedOptions.platform === "macos" ? "macOS" : "iOS"} build context must be inspectable before adding entitlements settings.`,
      ),
      sharedPlanFields,
    );
  }
  if (settingState === "conflicting") {
    return blockedPlan(
      normalizedOptions,
      blocker(
        "conflicting-entitlements-settings",
        `The selected target already has partial, inherited, unresolved, or conflicting ${normalizedOptions.platform === "macos" ? "macOS" : "iOS"} entitlements settings.`,
      ),
      sharedPlanFields,
    );
  }
  const pathState = await destinationState(synchronized.root, destination.absolutePath);
  if (settingState === "missing") {
    if (pathState !== "absent") {
      return blockedPlan(
        normalizedOptions,
        blocker(
          "entitlements-destination-exists",
          "The intended entitlements destination already exists or is represented by an incompatible Xcode file reference; it will not be adopted or overwritten.",
        ),
        sharedPlanFields,
      );
    }
    const generator = await generatedProjectKind(root, snapshot.absoluteProjectPath);
    if (generator) {
      return blockedPlan(
        normalizedOptions,
        blocker(
          "generated-project",
          `This is a ${generator === "xcodegen" ? "XcodeGen" : "Tuist"} project; update its source manifest instead of generated project.pbxproj output.`,
        ),
        sharedPlanFields,
      );
    }
  } else if (pathState === "unsupported" || pathState === "case-collision") {
    return blockedPlan(
      normalizedOptions,
      blocker(
        "invalid-entitlements-destination",
        "The configured entitlements destination is a symlink, directory, case-colliding path, or unreadable entry.",
      ),
      sharedPlanFields,
    );
  }

  return {
    ...planBase(normalizedOptions),
    ...sharedPlanFields,
    status: settingState === "exact" ? "satisfied" : "ready",
    configurationIds: snapshot.graph.configurationIds,
    actions:
      settingState === "exact"
        ? []
        : [
            normalizedOptions.platform === "macos"
              ? `Add a macOS CODE_SIGN_ENTITLEMENTS setting for ${destination.relativePath} to every selected-target build configuration.`
              : `Add iOS device and simulator CODE_SIGN_ENTITLEMENTS settings for ${destination.relativePath} to every selected-target build configuration.`,
          ],
    blockers: [],
  };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameResolvedPlanIdentity(
  left: Extract<IOSMissingEntitlementsSettingsPlan, { status: "ready" | "satisfied" }>,
  right: Extract<IOSMissingEntitlementsSettingsPlan, { status: "ready" | "satisfied" }>,
): boolean {
  return (
    left.root === right.root &&
    left.projectPath === right.projectPath &&
    left.projectFormat === right.projectFormat &&
    left.targetId === right.targetId &&
    left.platform === right.platform &&
    left.entitlementsPath === right.entitlementsPath &&
    left.buildSettingPath === right.buildSettingPath &&
    left.synchronizedRootPath === right.synchronizedRootPath &&
    left.synchronizedRootObjectId === right.synchronizedRootObjectId &&
    left.expectedSynchronizedRootIdentity.device ===
      right.expectedSynchronizedRootIdentity.device &&
    left.expectedSynchronizedRootIdentity.inode === right.expectedSynchronizedRootIdentity.inode &&
    left.expectedPbxprojHash === right.expectedPbxprojHash &&
    left.expectedPbxprojMode === right.expectedPbxprojMode &&
    sameStringArray(left.configurationIds, right.configurationIds)
  );
}

function synchronizedRootPathForGraph(
  graph: ProjectGraph,
  absoluteProjectPath: string,
  synchronizedRootObjectId: string,
): string | undefined {
  const group = graph.objects[synchronizedRootObjectId];
  if (group?.isa !== "PBXFileSystemSynchronizedRootGroup") return undefined;
  const projectDirectory = dirname(absoluteProjectPath);
  return resolvePbxFilePath(
    synchronizedRootObjectId,
    graph.objects,
    buildPbxParentIndex(graph.objects),
    projectDirectory,
    resolve(projectDirectory, asString(graph.projectObject.projectDirPath) ?? ""),
  );
}

function preparedWithHiddenMutation(
  plan: IOSMissingEntitlementsSettingsPlan,
  mutation: IOSExistingFileMutation,
): Extract<PreparedIOSMissingEntitlementsSettingsMutation, { status: "ready" }> {
  const result = { status: "ready" as const, plan } as Extract<
    PreparedIOSMissingEntitlementsSettingsMutation,
    { status: "ready" }
  >;
  Object.defineProperty(result, "mutation", {
    value: mutation,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

function baseMutationIsValid(mutation: IOSExistingFileMutation): boolean {
  return (
    hashIOSFileBytes(mutation.originalBytes) === mutation.originalHash &&
    hashIOSFileBytes(mutation.candidateBytes) === mutation.candidateHash &&
    Number.isInteger(mutation.mode) &&
    mutation.mode >= 0 &&
    mutation.mode <= 0o7777
  );
}

async function prepareXCProjMissingEntitlementsSettingsMutation(
  plan: Extract<IOSMissingEntitlementsSettingsPlan, { status: "ready" }>,
  baseMutation?: IOSExistingFileMutation,
): Promise<PreparedIOSMissingEntitlementsSettingsMutation> {
  const documentResolution = await resolveXcodeProjectDocument(
    resolve(plan.root, plan.projectPath),
  );
  if (
    documentResolution.status !== "found" ||
    documentResolution.document.format !== "xcproj" ||
    !(await pathIsSafelyWithinIOSRoot(plan.root, documentResolution.document.absolutePath))
  ) {
    return { status: "stale", plan };
  }
  const snapshot = await readXCProjSnapshot(plan.root, documentResolution.document, plan.targetId);
  if (!snapshot) return { status: "stale", plan };
  const entitlementsPath = resolve(plan.root, plan.entitlementsPath);
  const synchronizedRootPath = resolve(plan.root, plan.synchronizedRootPath);
  if (
    snapshot.hash !== plan.expectedPbxprojHash ||
    snapshot.mode !== plan.expectedPbxprojMode ||
    !sameStringArray(snapshot.configurationIds, plan.configurationIds) ||
    !(await pathIsSafelyWithinIOSRoot(plan.root, entitlementsPath)) ||
    !(await pathIsSafelyWithinIOSRoot(plan.root, synchronizedRootPath))
  ) {
    return { status: "stale", plan };
  }
  try {
    const rootInfo = await lstat(synchronizedRootPath);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      rootInfo.dev !== plan.expectedSynchronizedRootIdentity.device ||
      rootInfo.ino !== plan.expectedSynchronizedRootIdentity.inode
    ) {
      return { status: "stale", plan };
    }
  } catch {
    return { status: "stale", plan };
  }
  try {
    await lstat(entitlementsPath);
    return { status: "stale", plan };
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) return { status: "stale", plan };
  }
  const boundary = await prepareIOSFileMutationBoundary(plan.root, snapshot.documentPath);
  if (!boundary) return { status: "stale", plan };

  const replanned = await planIOSMissingEntitlementsSettings({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    platform: plan.platform,
  });
  if (replanned.status === "blocked") return { status: "blocked", plan: replanned };
  if (replanned.status !== "ready" || !sameResolvedPlanIdentity(plan, replanned)) {
    return { status: "stale", plan };
  }

  if (baseMutation) {
    if (
      resolve(baseMutation.path) !== snapshot.documentPath ||
      baseMutation.originalHash !== plan.expectedPbxprojHash ||
      baseMutation.mode !== plan.expectedPbxprojMode ||
      !isDeepStrictEqual(baseMutation.boundary, boundary)
    ) {
      return { status: "stale", plan };
    }
    if (!baseMutationIsValid(baseMutation)) {
      return blockPrepared(
        plan,
        "unsupported-project",
        "The prepared base Xcode mutation is invalid.",
      );
    }
  }

  const sourceBytes = baseMutation?.candidateBytes ?? snapshot.bytes;
  const candidateSnapshot = xcprojSnapshotFromBytes(snapshot, sourceBytes);
  if (
    !candidateSnapshot ||
    !sameStringArray(candidateSnapshot.configurationIds, plan.configurationIds)
  ) {
    return blockPrepared(
      plan,
      "unsupported-project",
      "The prepared Xcode JSON candidate changed the selected target structure.",
    );
  }
  const candidateRoot = await selectedXCProjSynchronizedRoot(plan.root, candidateSnapshot);
  if (
    !candidateRoot.root ||
    candidateRoot.root.objectId !== plan.synchronizedRootObjectId ||
    candidateRoot.root.absolutePath !== synchronizedRootPath
  ) {
    return blockPrepared(
      plan,
      "unsupported-project",
      "The prepared Xcode JSON candidate changed the selected synchronized source root.",
    );
  }
  const beforeState = await xcprojBuildSettingState(
    plan.root,
    candidateSnapshot,
    plan.buildSettingPath,
    plan.platform,
  );
  if (beforeState !== "missing" && beforeState !== "exact") {
    return blockPrepared(
      plan,
      beforeState === "incomplete"
        ? "incomplete-build-configurations"
        : "conflicting-entitlements-settings",
      "The prepared Xcode JSON candidate has unresolved or conflicting entitlements settings.",
    );
  }

  let candidate = candidateSnapshot.source;
  try {
    for (const key of entitlementsSettingKeys(plan.platform)) {
      candidate = applyXCProjValue(
        candidate,
        ["targets", candidateSnapshot.targetIndex, "build-settings", key],
        plan.buildSettingPath,
      );
    }
  } catch {
    return blockPrepared(
      plan,
      "unsupported-project",
      "The proposed Xcode JSON project could not be edited and reparsed safely.",
    );
  }
  const candidateBytes = new TextEncoder().encode(candidate);
  const reparsed = xcprojSnapshotFromBytes(snapshot, candidateBytes);
  if (
    !reparsed ||
    !sameStringArray(reparsed.configurationIds, plan.configurationIds) ||
    !xcprojRawSettingsAreExact(reparsed.target, plan.buildSettingPath, plan.platform) ||
    (await xcprojBuildSettingState(plan.root, reparsed, plan.buildSettingPath, plan.platform)) !==
      "exact"
  ) {
    return blockPrepared(
      plan,
      "unsupported-project",
      "The proposed Xcode JSON project did not retain every required entitlements setting.",
    );
  }
  return preparedWithHiddenMutation(plan, {
    path: snapshot.documentPath,
    boundary: baseMutation?.boundary ?? boundary,
    originalBytes: baseMutation?.originalBytes ?? snapshot.bytes,
    originalHash: baseMutation?.originalHash ?? plan.expectedPbxprojHash,
    candidateBytes,
    candidateHash: hashIOSFileBytes(candidateBytes),
    mode: baseMutation?.mode ?? plan.expectedPbxprojMode,
  });
}

export async function prepareIOSMissingEntitlementsSettingsMutation(
  plan: IOSMissingEntitlementsSettingsPlan,
  baseMutation?: IOSExistingFileMutation,
): Promise<PreparedIOSMissingEntitlementsSettingsMutation> {
  if (plan.status === "blocked") return { status: "blocked", plan };
  if (plan.platform !== "ios" && plan.platform !== "macos") {
    return blockPrepared(
      plan,
      "unsupported-project",
      "The serialized entitlements-settings plan has no supported target platform.",
    );
  }
  if (plan.status === "satisfied") {
    const current = await planIOSMissingEntitlementsSettings({
      root: plan.root,
      projectPath: plan.projectPath,
      targetId: plan.targetId,
      platform: plan.platform,
    });
    if (current.status === "blocked") return { status: "blocked", plan: current };
    return current.status === "satisfied" && sameResolvedPlanIdentity(plan, current)
      ? { status: "satisfied", plan: current }
      : { status: "stale", plan };
  }
  if (
    !plan.projectFormat ||
    !plan.expectedPbxprojHash ||
    plan.expectedPbxprojMode == null ||
    !plan.entitlementsPath ||
    !plan.buildSettingPath ||
    !plan.synchronizedRootPath ||
    !plan.synchronizedRootObjectId ||
    !plan.expectedSynchronizedRootIdentity ||
    plan.configurationIds.length === 0
  ) {
    return blockPrepared(
      plan,
      "unsupported-project",
      "The serialized entitlements-settings plan is incomplete.",
    );
  }
  if (plan.projectFormat === "xcproj") {
    return prepareXCProjMissingEntitlementsSettingsMutation(plan, baseMutation);
  }
  const pbxprojPath = resolve(plan.root, plan.projectPath, "project.pbxproj");
  const entitlementsPath = resolve(plan.root, plan.entitlementsPath);
  const synchronizedRootPath = resolve(plan.root, plan.synchronizedRootPath);
  if (
    !(await pathIsSafelyWithinIOSRoot(plan.root, pbxprojPath)) ||
    !(await pathIsSafelyWithinIOSRoot(plan.root, entitlementsPath)) ||
    !(await pathIsSafelyWithinIOSRoot(plan.root, synchronizedRootPath))
  ) {
    return blockPrepared(
      plan,
      "external-path",
      "A planned Xcode or entitlements path no longer resolves safely inside the invocation root.",
    );
  }
  let currentBytes: Uint8Array;
  try {
    const [projectInfo, rootInfo] = await Promise.all([
      lstat(pbxprojPath),
      lstat(synchronizedRootPath),
    ]);
    currentBytes = new Uint8Array(await readFile(pbxprojPath));
    if (
      !projectInfo.isFile() ||
      projectInfo.isSymbolicLink() ||
      (projectInfo.mode & 0o7777) !== plan.expectedPbxprojMode ||
      hashIOSFileBytes(currentBytes) !== plan.expectedPbxprojHash ||
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      rootInfo.dev !== plan.expectedSynchronizedRootIdentity.device ||
      rootInfo.ino !== plan.expectedSynchronizedRootIdentity.inode
    ) {
      return { status: "stale", plan };
    }
  } catch {
    return { status: "stale", plan };
  }
  const boundary = await prepareIOSFileMutationBoundary(plan.root, pbxprojPath);
  if (!boundary) return { status: "stale", plan };
  try {
    await lstat(entitlementsPath);
    return { status: "stale", plan };
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) return { status: "stale", plan };
  }

  const replanned = await planIOSMissingEntitlementsSettings({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    platform: plan.platform,
  });
  if (replanned.status === "blocked") return { status: "blocked", plan: replanned };
  if (
    replanned.status !== "ready" ||
    replanned.expectedPbxprojHash !== plan.expectedPbxprojHash ||
    replanned.entitlementsPath !== plan.entitlementsPath ||
    replanned.buildSettingPath !== plan.buildSettingPath ||
    replanned.synchronizedRootPath !== plan.synchronizedRootPath ||
    replanned.synchronizedRootObjectId !== plan.synchronizedRootObjectId ||
    !sameStringArray(replanned.configurationIds, plan.configurationIds)
  ) {
    return { status: "stale", plan };
  }

  if (baseMutation) {
    if (
      resolve(baseMutation.path) !== pbxprojPath ||
      baseMutation.originalHash !== plan.expectedPbxprojHash ||
      baseMutation.mode !== plan.expectedPbxprojMode ||
      !isDeepStrictEqual(baseMutation.boundary, boundary)
    ) {
      return { status: "stale", plan };
    }
    if (!baseMutationIsValid(baseMutation)) {
      return blockPrepared(
        plan,
        "unsupported-project",
        "The prepared base Xcode mutation is invalid.",
      );
    }
  }

  const sourceBytes = baseMutation?.candidateBytes ?? currentBytes;
  let model: ReturnType<typeof parsePbxProject>;
  let graph: ProjectGraph;
  try {
    model = parsePbxProject(new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes));
    const parsedGraph = projectGraph(model, plan.targetId);
    if (!parsedGraph) throw new Error("missing target graph");
    graph = parsedGraph;
  } catch {
    return blockPrepared(
      plan,
      "unsupported-project",
      "The prepared Xcode candidate could not be parsed safely.",
    );
  }
  const groupIds = optionalExactStringArray(graph.targetObject.fileSystemSynchronizedGroups);
  if (
    !groupIds ||
    groupIds.length !== 1 ||
    groupIds[0] !== plan.synchronizedRootObjectId ||
    !sameStringArray(graph.configurationIds, plan.configurationIds) ||
    synchronizedRootPathForGraph(
      graph,
      resolve(plan.root, plan.projectPath),
      plan.synchronizedRootObjectId,
    ) !== synchronizedRootPath
  ) {
    return blockPrepared(
      plan,
      "unsupported-project",
      "The prepared Xcode candidate changed the selected target structure.",
    );
  }
  for (const configurationId of graph.configurationIds) {
    const settings = settingsDictionary(graph, configurationId);
    if (!settings) {
      return blockPrepared(
        plan,
        "malformed-project",
        "A selected-target build configuration has no mutable build-settings dictionary.",
      );
    }
    const settingKeys = entitlementsSettingKeys(plan.platform);
    const values = settingKeys.map((key) => settings[key]);
    const absent = values.every((value) => value == null);
    const exact = values.every((value) => value === plan.buildSettingPath);
    if (!absent && !exact) {
      return blockPrepared(
        plan,
        "conflicting-entitlements-settings",
        `The prepared Xcode candidate introduced partial or conflicting ${plan.platform === "macos" ? "macOS" : "iOS"} entitlements settings.`,
      );
    }
    for (const key of settingKeys) settings[key] = plan.buildSettingPath;
  }

  let candidate: string;
  let reparsed: ReturnType<typeof parsePbxProject>;
  try {
    candidate = buildPbxProject(model);
    reparsed = parsePbxProject(candidate);
  } catch {
    return blockPrepared(
      plan,
      "unsupported-project",
      "The proposed Xcode project could not be serialized and reparsed safely.",
    );
  }
  if (!isDeepStrictEqual(reparsed, model)) {
    return blockPrepared(
      plan,
      "unsupported-project",
      "Serializing the proposed Xcode project would change unsupported object-graph data.",
    );
  }
  const candidateGraph = projectGraph(reparsed, plan.targetId);
  if (
    !candidateGraph ||
    !sameStringArray(candidateGraph.configurationIds, plan.configurationIds) ||
    !rawSettingsAreExact(candidateGraph, plan.buildSettingPath, plan.platform)
  ) {
    return blockPrepared(
      plan,
      "unsupported-project",
      `The proposed Xcode project did not retain every required ${plan.platform === "macos" ? "macOS" : "iOS"} entitlements setting.`,
    );
  }
  const candidateBytes = new TextEncoder().encode(candidate);
  return preparedWithHiddenMutation(plan, {
    path: pbxprojPath,
    boundary: baseMutation?.boundary ?? boundary,
    originalBytes: baseMutation?.originalBytes ?? currentBytes,
    originalHash: baseMutation?.originalHash ?? plan.expectedPbxprojHash,
    candidateBytes,
    candidateHash: hashIOSFileBytes(candidateBytes),
    mode: baseMutation?.mode ?? plan.expectedPbxprojMode,
  });
}

export async function validateIOSMissingEntitlementsSettingsPostcondition(
  plan: IOSMissingEntitlementsSettingsPlan,
): Promise<boolean> {
  if (plan.status === "blocked") return false;
  const current = await planIOSMissingEntitlementsSettings({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    platform: plan.platform,
  });
  return (
    current.status === "satisfied" &&
    current.entitlementsPath === plan.entitlementsPath &&
    current.buildSettingPath === plan.buildSettingPath &&
    current.synchronizedRootPath === plan.synchronizedRootPath &&
    current.synchronizedRootObjectId === plan.synchronizedRootObjectId &&
    current.expectedSynchronizedRootIdentity.device ===
      plan.expectedSynchronizedRootIdentity.device &&
    current.expectedSynchronizedRootIdentity.inode ===
      plan.expectedSynchronizedRootIdentity.inode &&
    sameStringArray(current.configurationIds, plan.configurationIds)
  );
}

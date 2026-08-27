import { lstat, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parsePbxProject } from "@bacons/xcode/json";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import { inspectIOSProject } from "./inspect.ts";
import {
  discoverLocalIOSProjects,
  pathIsSafelyWithinIOSRoot,
  relativeIOSPath,
} from "./discovery.ts";
import type { IOSAppTarget } from "./types.ts";
import {
  asString,
  asStringArray,
  buildPbxParentIndex,
  isRecord,
  resolvePbxFilePath,
  type PbxObject,
  type PbxObjects,
} from "./pbx.ts";
import { parseIOSPlist } from "./plist.ts";
import {
  IOSFileTransactionOwnershipError as RuntimeKeyFileOwnershipError,
  fileMatchesIdentityAndHash,
  identitiesMatch,
  linkOwnedSourceWithoutClobber,
  readPathIdentity,
  readRegularFileIdentity,
  readRegularFileIdentityAndHash,
  removeClaimedPath,
  restoreClaimWithoutClobber,
  sameFile,
  type ClaimedDestination as ClaimedFile,
  type FileIdentity,
} from "./file-transaction.ts";

const APP_PRODUCT_TYPE = "com.apple.product-type.application";
const MAX_PBXPROJ_BYTES = 15_000_000;
const MAX_LOCAL_SECRETS_BYTES = 1_000_000;
const MAX_GITIGNORE_BYTES = 1_000_000;
const MAX_DISCOVERY_DEPTH = 24;
const MAX_DISCOVERED_SECRETS = 20;
const MAX_OWNERSHIP_SCAN_ENTRIES = 20_000;
const SECRET_KEY = "CLERK_PUBLISHABLE_KEY";
const DISCOVERY_IGNORES = new Set([
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

export interface IOSRuntimeKeyPlanOptions {
  root: string;
  /** Project-root-relative path selected by the iOS inspector. */
  projectPath: string;
  targetId: string;
  /** Optional project-root-relative disambiguation when the target owns more than one sink. */
  localSecretsPath?: string;
}

export type IOSRuntimeKeyBlockerCode =
  | "invalid-selection"
  | "external-path"
  | "unreadable-project"
  | "malformed-project"
  | "target-not-found"
  | "generated-project"
  | "missing-local-secrets"
  | "ambiguous-local-secrets"
  | "not-target-resource"
  | "shared-local-secrets"
  | "unreadable-local-secrets"
  | "malformed-local-secrets"
  | "unsupported-local-secrets"
  | "unproven-runtime-wiring"
  | "tracked-local-secrets"
  | "git-state-unknown"
  | "git-repository-mismatch"
  | "unsafe-gitignore"
  | "invalid-publishable-key"
  | "production-publishable-key"
  | "different-publishable-key";

export interface IOSRuntimeKeyBlocker {
  code: IOSRuntimeKeyBlockerCode;
  message: string;
}

/**
 * A structural, serializable plan. It intentionally contains neither the
 * publishable key nor candidate plist bytes. The raw key is accepted only by
 * applyIOSRuntimeKey.
 */
export interface IOSRuntimeKeyPlan {
  schemaVersion: 1;
  kind: "clerk-ios-runtime-key";
  status: "ready" | "blocked";
  root: string;
  projectPath: string;
  targetId: string;
  localSecretsPath?: string;
  gitignorePath?: string;
  gitignoreRule?: string;
  /** SHA-256 of the exact existing sink bytes inspected by this plan. */
  expectedLocalSecretsHash?: string;
  /** Null means the .gitignore did not exist when the plan was created. */
  expectedGitignoreHash?: string | null;
  /** True when apply may update .gitignore, including its crash-safe staging guard. */
  changesGitignore: boolean;
  actions: string[];
  blockers: IOSRuntimeKeyBlocker[];
}

export interface IOSRuntimeKeyApplyResult {
  status: "applied" | "satisfied" | "blocked" | "stale" | "rolled-back";
  plan: IOSRuntimeKeyPlan;
  message?: string;
}

/**
 * A read-only, serializable proof of which runtime sink should be compared
 * after Clerk application linking. It never contains the locally stored key.
 */
export interface IOSRuntimeKeyVerificationPlan {
  schemaVersion: 1;
  kind: "clerk-ios-runtime-key-verification";
  status: "ready" | "blocked";
  root: string;
  projectPath: string;
  targetId: string;
  localSecretsPath?: string;
  expectedLocalSecretsHash?: string;
  blockers: IOSRuntimeKeyBlocker[];
}

export interface IOSRuntimeKeyVerificationResult {
  status: "matched" | "mismatched" | "stale" | "blocked";
  plan: IOSRuntimeKeyVerificationPlan;
}

/** @internal Test-only fault injection used to prove rollback. */
export interface IOSRuntimeKeyApplyOptions {
  forcePostWriteValidationFailure?: boolean;
  forcePlistStageFailureAfterCreate?: boolean;
  forcePlistCleanupFailureBeforeCommit?: boolean;
  forceGitignoreCommitCleanupFailure?: boolean;
  beforePlistWrite?: (temporaryPath: string) => void | Promise<void>;
  afterPlistStage?: () => void | Promise<void>;
  afterPlistCommit?: () => void | Promise<void>;
  beforePostWriteValidation?: () => void | Promise<void>;
  beforeStagedCommitInstall?: (targetPath: string, claimPath: string) => void | Promise<void>;
  beforeStagedRollbackInstall?: (
    targetPath: string,
    originalSourcePath: string,
    candidateClaimPath: string,
  ) => void | Promise<void>;
}

type GitContext =
  | { state: "repository"; root: string }
  | { state: "not-repository" }
  | { state: "unknown" }
  | { state: "mismatch" };

interface FileSnapshot {
  path: string;
  exists: boolean;
  hash?: string;
  mode: number;
  bytes?: Uint8Array;
  identity?: FileIdentity;
}

interface PreparedRuntimeKeyPlan {
  plan: IOSRuntimeKeyPlan;
  plist?: Record<string, unknown>;
  localSecretsSnapshot?: FileSnapshot;
  gitignoreSnapshot?: FileSnapshot;
  gitContext?: GitContext;
  gitignoreNeeded?: boolean;
}

interface PreparedRuntimeKeyVerification {
  plan: IOSRuntimeKeyVerificationPlan;
  localSecretsSnapshot?: FileSnapshot;
  /** Kept only inside the verification call and never copied into a public result. */
  existingPublishableKey?: string;
}

interface StagedFile {
  targetPath: string;
  temporaryPath: string;
  candidateHash: string;
  original: FileSnapshot;
  committed: boolean;
  cleanupFailuresRemaining: number;
  keyBearing: boolean;
  temporaryPresent: boolean;
  stagedIdentity: FileIdentity;
  committedIdentity?: FileIdentity;
  claimedOriginal?: ClaimedFile;
  recoveryClaims: ClaimedFile[];
  claimPathIsSafe?: (path: string) => boolean | Promise<boolean>;
  rollbackClaimPathIsSafe?: (path: string) => boolean | Promise<boolean>;
}

interface RollbackDependency {
  root: string;
  /** The key-bearing file that must be made safe before its protection can be removed. */
  payloadPath: string;
  /** The ignore file whose committed candidate protects the payload. */
  protectionPath: string;
  /** Rules that protect both the final payload and its crash-safe staging file. */
  protectionRules: string[];
  options: IOSRuntimeKeyApplyOptions;
}

class RuntimeKeyTemporaryFileCleanupError extends Error {
  constructor(
    message: string,
    readonly keyBearing: boolean,
  ) {
    super(message);
  }
}

class RuntimeKeyClaimProtectionError extends RuntimeKeyFileOwnershipError {
  constructor(readonly claimPath: string) {
    super("a runtime-key recovery path was not protected by the committed ignore rule");
  }
}

interface StageFileOptions {
  forceFailureAfterCreate?: boolean;
  cleanupFailures?: number;
  keyBearing?: boolean;
  beforeWrite?: (temporaryPath: string) => boolean | Promise<boolean>;
  claimPathIsSafe?: (path: string) => boolean | Promise<boolean>;
  rollbackClaimPathIsSafe?: (path: string) => boolean | Promise<boolean>;
}

function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function makePlan(
  options: IOSRuntimeKeyPlanOptions,
  root: string,
  projectPath: string,
  status: IOSRuntimeKeyPlan["status"],
  details: Partial<
    Pick<
      IOSRuntimeKeyPlan,
      | "localSecretsPath"
      | "gitignorePath"
      | "gitignoreRule"
      | "expectedLocalSecretsHash"
      | "expectedGitignoreHash"
      | "changesGitignore"
      | "actions"
      | "blockers"
    >
  > = {},
): IOSRuntimeKeyPlan {
  return {
    schemaVersion: 1,
    kind: "clerk-ios-runtime-key",
    status,
    root,
    projectPath,
    targetId: options.targetId,
    localSecretsPath: details.localSecretsPath,
    gitignorePath: details.gitignorePath,
    gitignoreRule: details.gitignoreRule,
    expectedLocalSecretsHash: details.expectedLocalSecretsHash,
    expectedGitignoreHash: details.expectedGitignoreHash,
    changesGitignore: details.changesGitignore ?? false,
    actions: details.actions ?? [],
    blockers: details.blockers ?? [],
  };
}

function blocked(
  options: IOSRuntimeKeyPlanOptions,
  root: string,
  projectPath: string,
  code: IOSRuntimeKeyBlockerCode,
  message: string,
  source: Partial<PreparedRuntimeKeyPlan> = {},
): PreparedRuntimeKeyPlan {
  return {
    ...source,
    plan: makePlan(options, root, projectPath, "blocked", {
      localSecretsPath: source.plan?.localSecretsPath,
      gitignorePath: source.plan?.gitignorePath,
      gitignoreRule: source.plan?.gitignoreRule,
      expectedLocalSecretsHash: source.plan?.expectedLocalSecretsHash,
      expectedGitignoreHash: source.plan?.expectedGitignoreHash,
      changesGitignore: source.plan?.changesGitignore,
      blockers: [{ code, message }],
    }),
  };
}

function makeVerificationPlan(
  options: IOSRuntimeKeyPlanOptions,
  root: string,
  projectPath: string,
  status: IOSRuntimeKeyVerificationPlan["status"],
  details: Partial<
    Pick<
      IOSRuntimeKeyVerificationPlan,
      "localSecretsPath" | "expectedLocalSecretsHash" | "blockers"
    >
  > = {},
): IOSRuntimeKeyVerificationPlan {
  return {
    schemaVersion: 1,
    kind: "clerk-ios-runtime-key-verification",
    status,
    root,
    projectPath,
    targetId: options.targetId,
    localSecretsPath: details.localSecretsPath,
    expectedLocalSecretsHash: details.expectedLocalSecretsHash,
    blockers: details.blockers ?? [],
  };
}

function verificationBlocked(
  options: IOSRuntimeKeyPlanOptions,
  root: string,
  projectPath: string,
  code: IOSRuntimeKeyBlockerCode,
  message: string,
  source: Partial<PreparedRuntimeKeyVerification> = {},
): PreparedRuntimeKeyVerification {
  return {
    plan: makeVerificationPlan(options, root, projectPath, "blocked", {
      localSecretsPath: source.plan?.localSecretsPath,
      expectedLocalSecretsHash: source.plan?.expectedLocalSecretsHash,
      blockers: [{ code, message }],
    }),
  };
}

function normalizedObjects(value: unknown): PbxObjects | undefined {
  if (!isRecord(value)) return undefined;
  const objects: PbxObjects = {};
  for (const [id, object] of Object.entries(value)) {
    if (!isRecord(object)) return undefined;
    objects[id] = object;
  }
  return objects;
}

function buildFileIOSApplicability(object: PbxObject): {
  applies: boolean;
  recognized: boolean;
} {
  const platformFilter = asString(object.platformFilter);
  const filters = [
    ...asStringArray(object.platformFilters),
    ...(platformFilter ? [platformFilter] : []),
  ];
  if (filters.length === 0) return { applies: true, recognized: true };
  if (filters.some((filter) => /(?:^|[^a-z])(?:ios|iphone)/i.test(filter))) {
    return { applies: true, recognized: true };
  }
  const recognized = filters.every((filter) =>
    /(?:maccatalyst|macos|tvos|watchos|xros|visionos|driverkit)/i.test(filter),
  );
  return { applies: false, recognized };
}

function normalizeSynchronizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function synchronizedExclusions(
  group: PbxObject,
  targetId: string,
  resourcePhaseIds: Set<string>,
  objects: PbxObjects,
): Set<string> {
  const excluded = new Set<string>();
  for (const exceptionId of asStringArray(group.exceptions)) {
    const exception = objects[exceptionId];
    const appliesToTarget =
      exception?.isa === "PBXFileSystemSynchronizedBuildFileExceptionSet" &&
      asString(exception.target) === targetId;
    const appliesToPhase =
      exception?.isa === "PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet" &&
      resourcePhaseIds.has(asString(exception.buildPhase) ?? "");
    if (!appliesToTarget && !appliesToPhase) continue;

    for (const path of asStringArray(exception.membershipExceptions)) {
      excluded.add(normalizeSynchronizedPath(path));
    }
    if (!isRecord(exception.platformFiltersByRelativePath)) continue;
    for (const [path, filters] of Object.entries(exception.platformFiltersByRelativePath)) {
      const platformFilters = stringArray(filters);
      if (
        platformFilters.length > 0 &&
        !platformFilters.some((filter) => /(?:^|[^a-z])(?:ios|iphone)/i.test(filter))
      ) {
        excluded.add(normalizeSynchronizedPath(path));
      }
    }
  }
  return excluded;
}

function synchronizedPathIsExcluded(path: string, excluded: Set<string>): boolean {
  return [...excluded].some(
    (excludedPath) => path === excludedPath || path.startsWith(`${excludedPath}/`),
  );
}

async function collectLocalSecrets(
  root: string,
  directory: string,
  output: string[],
  depth = 0,
): Promise<void> {
  if (depth > MAX_DISCOVERY_DEPTH || output.length >= MAX_DISCOVERED_SECRETS) return;
  if (!(await pathIsSafelyWithinIOSRoot(root, directory))) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (output.length >= MAX_DISCOVERED_SECRETS) return;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !DISCOVERY_IGNORES.has(entry.name)) {
        await collectLocalSecrets(root, path, output, depth + 1);
      }
    } else if (entry.isFile() && entry.name === "LocalSecrets.plist") {
      output.push(path);
    }
  }
}

async function generatedProjectKind(
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

async function targetLocalSecretsPaths(
  root: string,
  absoluteProjectPath: string,
  targetId: string,
): Promise<{ paths?: string[]; blocker?: IOSRuntimeKeyBlocker }> {
  const pbxprojPath = resolve(absoluteProjectPath, "project.pbxproj");
  if (!(await pathIsSafelyWithinIOSRoot(root, pbxprojPath))) {
    return {
      blocker: {
        code: "external-path",
        message: "The selected Xcode project resolves outside the project root.",
      },
    };
  }

  let info;
  let archive: unknown;
  try {
    info = await lstat(pbxprojPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PBXPROJ_BYTES) {
      throw new Error("unsupported project file");
    }
    archive = parsePbxProject(await readFile(pbxprojPath, "utf8"));
  } catch {
    return {
      blocker: {
        code: "unreadable-project",
        message: "The selected Xcode project is missing, too large, symlinked, or unreadable.",
      },
    };
  }
  if (!isRecord(archive)) {
    return {
      blocker: {
        code: "malformed-project",
        message: "The selected Xcode project has no readable object graph.",
      },
    };
  }
  const objects = normalizedObjects(archive.objects);
  const projectObjectId = asString(archive.rootObject);
  const projectObject = projectObjectId ? objects?.[projectObjectId] : undefined;
  const targetObject = objects?.[targetId];
  if (!objects || projectObject?.isa !== "PBXProject") {
    return {
      blocker: {
        code: "malformed-project",
        message: "The selected Xcode project has no readable PBXProject root.",
      },
    };
  }
  if (
    targetObject?.isa !== "PBXNativeTarget" ||
    asString(targetObject.productType) !== APP_PRODUCT_TYPE
  ) {
    return {
      blocker: {
        code: "target-not-found",
        message: "The selected object is not an iOS application target.",
      },
    };
  }

  const parents = buildPbxParentIndex(objects);
  const projectDirectory = dirname(absoluteProjectPath);
  const groupRootDirectory = resolve(
    projectDirectory,
    asString(projectObject.projectDirPath) ?? "",
  );
  const resourcePhaseIds = new Set(
    asStringArray(targetObject.buildPhases).filter(
      (phaseId) => objects[phaseId]?.isa === "PBXResourcesBuildPhase",
    ),
  );
  const paths = new Set<string>();

  for (const phaseId of resourcePhaseIds) {
    const phase = objects[phaseId];
    if (phase?.isa !== "PBXResourcesBuildPhase") continue;
    for (const buildFileId of asStringArray(phase.files)) {
      const buildFile = objects[buildFileId];
      if (!buildFile || !buildFileIOSApplicability(buildFile).applies) continue;
      const fileReferenceId = asString(buildFile.fileRef);
      if (!fileReferenceId) continue;
      const path = resolvePbxFilePath(
        fileReferenceId,
        objects,
        parents,
        projectDirectory,
        groupRootDirectory,
      );
      if (
        path?.endsWith(`${sep}LocalSecrets.plist`) &&
        (await pathIsSafelyWithinIOSRoot(root, path))
      ) {
        paths.add(path);
      }
    }
  }

  for (const groupId of asStringArray(targetObject.fileSystemSynchronizedGroups)) {
    const group = objects[groupId];
    if (group?.isa !== "PBXFileSystemSynchronizedRootGroup") continue;
    const groupPath = resolvePbxFilePath(
      groupId,
      objects,
      parents,
      projectDirectory,
      groupRootDirectory,
    );
    if (!groupPath || !(await pathIsSafelyWithinIOSRoot(root, groupPath))) continue;
    const discovered: string[] = [];
    await collectLocalSecrets(root, groupPath, discovered);
    const excluded = synchronizedExclusions(group, targetId, resourcePhaseIds, objects);
    for (const path of discovered) {
      const pathFromGroup = relative(groupPath, path).split(sep).join("/");
      if (!synchronizedPathIsExcluded(pathFromGroup, excluded)) paths.add(path);
    }
  }

  return { paths: [...paths].sort() };
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function snapshotExistingFile(
  path: string,
  maximumBytes: number,
): Promise<FileSnapshot | undefined> {
  try {
    const beforeRead = await readRegularFileIdentity(path);
    const info = await lstat(path);
    if (!beforeRead || !info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) {
      return undefined;
    }
    const bytes = new Uint8Array(await readFile(path));
    const afterRead = await readRegularFileIdentity(path);
    if (!afterRead || !identitiesMatch(beforeRead, afterRead)) return undefined;
    return {
      path,
      exists: true,
      hash: sha256(bytes),
      mode: afterRead.mode,
      bytes,
      identity: afterRead,
    };
  } catch {
    return undefined;
  }
}

async function snapshotOptionalFile(
  root: string,
  path: string,
  maximumBytes: number,
  missingMode: number,
): Promise<FileSnapshot | undefined> {
  if (!(await pathIsSafelyWithinIOSRoot(root, path))) return undefined;
  try {
    const beforeRead = await readRegularFileIdentity(path);
    const info = await lstat(path);
    if (!beforeRead || !info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) {
      return undefined;
    }
    const bytes = new Uint8Array(await readFile(path));
    const afterRead = await readRegularFileIdentity(path);
    if (!afterRead || !identitiesMatch(beforeRead, afterRead)) return undefined;
    return {
      path,
      exists: true,
      hash: sha256(bytes),
      mode: afterRead.mode,
      bytes,
      identity: afterRead,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { path, exists: false, mode: missingMode };
    }
    return undefined;
  }
}

function decodeUTF8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parseXMLPlist(bytes: Uint8Array): Record<string, unknown> | undefined {
  if (new TextDecoder().decode(bytes.slice(0, 8)).startsWith("bplist")) return undefined;
  const source = decodeUTF8(bytes);
  if (!source) return undefined;
  try {
    const parsed = parseIOSPlist(source);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function hasGitMarkerInAncestors(start: string): Promise<boolean> {
  let directory = resolve(start);
  while (true) {
    try {
      await lstat(resolve(directory, ".git"));
      return true;
    } catch {
      // Walk to the filesystem root.
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

async function gitContext(root: string): Promise<GitContext> {
  try {
    const child = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = (await new Response(child.stdout).text()).trim();
    if ((await child.exited) !== 0 || output === "") {
      return (await hasGitMarkerInAncestors(root))
        ? { state: "unknown" }
        : { state: "not-repository" };
    }
    const [canonicalRepositoryRoot, canonicalRoot] = await Promise.all([
      realpath(output),
      realpath(root),
    ]);
    const rootFromRepository = relative(canonicalRepositoryRoot, canonicalRoot);
    if (
      rootFromRepository === ".." ||
      rootFromRepository.startsWith(`..${sep}`) ||
      isAbsolute(rootFromRepository)
    ) {
      return { state: "unknown" };
    }
    return { state: "repository", root: canonicalRepositoryRoot };
  } catch {
    return (await hasGitMarkerInAncestors(root))
      ? { state: "unknown" }
      : { state: "not-repository" };
  }
}

async function coherentGitContext(root: string, locations: string[]): Promise<GitContext> {
  const contexts = await Promise.all([gitContext(root), ...locations.map(gitContext)]);
  if (contexts.some((context) => context.state === "unknown")) return { state: "unknown" };
  const repositories = contexts.filter(
    (context): context is Extract<GitContext, { state: "repository" }> =>
      context.state === "repository",
  );
  if (repositories.length === 0) return { state: "not-repository" };
  if (
    repositories.length !== contexts.length ||
    new Set(repositories.map((context) => context.root)).size !== 1
  ) {
    return { state: "mismatch" };
  }
  return repositories[0]!;
}

async function hasDescendantGitignore(
  rootInput: string,
  localSecretsPath: string,
): Promise<boolean> {
  const root = resolve(rootInput);
  let directory = dirname(resolve(localSecretsPath));
  const pathFromRoot = relative(root, directory);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    return true;
  }

  while (directory !== root) {
    try {
      // A lower-level ignore file takes precedence over root rules. Treat every
      // filesystem object here conservatively, including symlinks and directories.
      await lstat(resolve(directory, ".gitignore"));
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return true;
    }

    const parent = dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }

  return false;
}

async function gitPathExitCode(
  repositoryRoot: string,
  args: string[],
  absolutePath: string,
): Promise<number | undefined> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch {
    return undefined;
  }
  const path = relative(repositoryRoot, canonicalPath);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
  try {
    const child = Bun.spawn(["git", ...args, "--", path], {
      cwd: repositoryRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    return await child.exited;
  } catch {
    return undefined;
  }
}

async function prospectiveGitPathExitCode(
  repositoryRoot: string,
  args: string[],
  absolutePath: string,
): Promise<number | undefined> {
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(dirname(absolutePath));
  } catch {
    return undefined;
  }
  const candidate = resolve(canonicalParent, basename(absolutePath));
  const path = relative(repositoryRoot, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
  try {
    const child = Bun.spawn(["git", ...args, "--", path], {
      cwd: repositoryRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    return await child.exited;
  } catch {
    return undefined;
  }
}

function escapeGitignorePath(path: string): string {
  return path
    .split("/")
    .map((component) => {
      let escaped = component.replaceAll("\\", "\\\\").replaceAll(" ", "\\ ");
      for (const character of ["[", "]", "*", "?", "!", "#"]) {
        escaped = escaped.replaceAll(character, `\\${character}`);
      }
      return escaped;
    })
    .join("/");
}

function gitignoreRule(root: string, localSecretsPath: string): string {
  return `/${escapeGitignorePath(relativeIOSPath(root, localSecretsPath))}`;
}

function gitignoreTemporaryRule(root: string, localSecretsPath: string): string {
  const components = relativeIOSPath(root, localSecretsPath).split("/");
  const fileName = components.pop()!;
  const directory = components.length > 0 ? `${escapeGitignorePath(components.join("/"))}/` : "";
  return `/${directory}.${escapeGitignorePath(fileName)}.clerk-*.tmp`;
}

function gitignoreContainsRule(content: string, rule: string): boolean {
  return content.split(/\r?\n/).some((line) => line === rule);
}

function gitignoreEndsWithRule(content: string, rule: string): boolean {
  for (const line of content.split(/\r?\n/).reverse()) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    return line === rule;
  }
  return false;
}

function gitignoreRuleIsEffectiveWithoutRepository(content: string, rule: string): boolean {
  const lines = content.split(/\r?\n/);
  const ruleIndex = lines.lastIndexOf(rule);
  if (ruleIndex < 0) return false;

  // Without Git there is no authoritative matcher available. A later negation
  // could re-include this path (or its parent), so fail closed rather than
  // inferring safety from the presence of a positive rule alone.
  return !lines.slice(ruleIndex + 1).some((line) => line.startsWith("!"));
}

function appendGitignoreRule(content: string, rule: string): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const separator = content.length > 0 && !content.endsWith("\n") ? lineEnding : "";
  return `${content}${separator}${rule}${lineEnding}`;
}

function hasProvenRuntimeKeyWiring(target: IOSAppTarget | undefined): target is IOSAppTarget {
  if (!target || !target.swift.evidenceComplete) return false;
  const entryPoint = target.swift.entryPoints[0];
  const configureCall = target.swift.configureCalls[0];
  return (
    target.swift.entryPoints.length === 1 &&
    target.swift.configureCalls.length === 1 &&
    configureCall?.publishableKeyWiring === "local-secrets-loader" &&
    configureCall.localSecretsRuntimeBinding === "proven" &&
    configureCall.startupBinding === "app-init" &&
    configureCall.path === entryPoint?.path &&
    target.swift.localSecretsRuntimeBindings.length === 1 &&
    target.runtimeKeySinks.length === 1
  );
}

function exactStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value;
}

function optionalExactStringArray(value: unknown): string[] | undefined {
  return value == null ? [] : exactStringArray(value);
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== ".." &&
      !isAbsolute(pathFromParent))
  );
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function normalizedSynchronizedExceptionPath(path: string): string | undefined {
  const normalized = normalizeSynchronizedPath(path);
  if (
    normalized === "" ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    containsControlCharacter(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function provenSynchronizedExclusions(
  group: PbxObject,
  targetId: string,
  resourcePhaseIds: Set<string>,
  objects: PbxObjects,
): Set<string> | undefined {
  const exceptionIds = optionalExactStringArray(group.exceptions);
  if (!exceptionIds) return undefined;

  const excluded = new Set<string>();
  for (const exceptionId of exceptionIds) {
    const exception = objects[exceptionId];
    if (!exception) return undefined;

    let applies = false;
    if (exception.isa === "PBXFileSystemSynchronizedBuildFileExceptionSet") {
      const exceptionTargetId = asString(exception.target);
      if (!exceptionTargetId || objects[exceptionTargetId]?.isa !== "PBXNativeTarget") {
        return undefined;
      }
      applies = exceptionTargetId === targetId;
    } else if (exception.isa === "PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet") {
      const exceptionPhaseId = asString(exception.buildPhase);
      const exceptionPhase = exceptionPhaseId ? objects[exceptionPhaseId] : undefined;
      if (
        !exceptionPhaseId ||
        typeof exceptionPhase?.isa !== "string" ||
        !exceptionPhase.isa.endsWith("BuildPhase")
      ) {
        return undefined;
      }
      applies = resourcePhaseIds.has(exceptionPhaseId);
    } else {
      return undefined;
    }

    if (!applies) continue;
    const membershipExceptions = optionalExactStringArray(exception.membershipExceptions);
    if (!membershipExceptions) return undefined;
    for (const path of membershipExceptions) {
      const normalized = normalizedSynchronizedExceptionPath(path);
      if (!normalized) return undefined;
      excluded.add(normalized);
    }

    if (exception.platformFiltersByRelativePath == null) continue;
    if (!isRecord(exception.platformFiltersByRelativePath)) return undefined;
    for (const [path, rawFilters] of Object.entries(exception.platformFiltersByRelativePath)) {
      const filters = exactStringArray(rawFilters);
      const normalized = normalizedSynchronizedExceptionPath(path);
      if (!filters || !normalized) return undefined;
      const applicability = buildFileIOSApplicability({ platformFilters: filters });
      if (!applicability.recognized) return undefined;
      if (!applicability.applies) excluded.add(normalized);
    }
  }
  return excluded;
}

interface RuntimeSinkIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

interface OwnershipScanState {
  entries: number;
  visitedDirectories: Set<string>;
}

async function synchronizedDirectoryOwnsCanonicalSink(options: {
  canonicalDirectory: string;
  canonicalSink: string;
  excluded: Set<string>;
  logicalPrefix: string;
  sinkIdentity: RuntimeSinkIdentity;
  state: OwnershipScanState;
  depth?: number;
}): Promise<boolean | undefined> {
  const {
    canonicalDirectory,
    canonicalSink,
    excluded,
    logicalPrefix,
    sinkIdentity,
    state,
    depth = 0,
  } = options;
  if (depth > MAX_DISCOVERY_DEPTH) return undefined;

  if (isSameOrDescendant(canonicalDirectory, canonicalSink)) {
    const pathFromDirectory = relative(canonicalDirectory, canonicalSink).split(sep).join("/");
    const logicalSinkPath = normalizeSynchronizedPath(
      logicalPrefix ? `${logicalPrefix}/${pathFromDirectory}` : pathFromDirectory,
    );
    if (!synchronizedPathIsExcluded(logicalSinkPath, excluded)) return true;
  }

  const visitKey = `${canonicalDirectory}\0${logicalPrefix}`;
  if (state.visitedDirectories.has(visitKey)) return false;
  state.visitedDirectories.add(visitKey);

  let entries;
  try {
    entries = await readdir(canonicalDirectory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  state.entries += entries.length;
  if (state.entries > MAX_OWNERSHIP_SCAN_ENTRIES) return undefined;

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const logicalPath = normalizeSynchronizedPath(
      logicalPrefix ? `${logicalPrefix}/${entry.name}` : entry.name,
    );
    if (synchronizedPathIsExcluded(logicalPath, excluded)) continue;

    const entryPath = resolve(canonicalDirectory, entry.name);
    let entryInfo;
    try {
      entryInfo = await lstat(entryPath);
    } catch {
      return undefined;
    }

    if (entryInfo.isFile()) {
      if (sameFileIdentity(entryInfo, sinkIdentity)) return true;
      continue;
    }

    if (!entryInfo.isDirectory() && !entryInfo.isSymbolicLink()) continue;
    let canonicalEntry: string;
    let canonicalEntryInfo;
    try {
      canonicalEntry = await realpath(entryPath);
      canonicalEntryInfo = await lstat(canonicalEntry);
    } catch {
      // A dangling or unreadable alias could conceal a second path to the sink.
      return undefined;
    }

    if (canonicalEntryInfo.isFile()) {
      if (sameFileIdentity(canonicalEntryInfo, sinkIdentity)) return true;
      continue;
    }
    if (!canonicalEntryInfo.isDirectory()) continue;

    const nestedOwnership = await synchronizedDirectoryOwnsCanonicalSink({
      canonicalDirectory: canonicalEntry,
      canonicalSink,
      excluded,
      logicalPrefix: logicalPath,
      sinkIdentity,
      state,
      depth: depth + 1,
    });
    if (nestedOwnership == null || nestedOwnership) return nestedOwnership;
  }
  return false;
}

async function synchronizedGroupOwnsCanonicalSink(options: {
  groupPath: string;
  canonicalSink: string;
  excluded: Set<string>;
  sinkIdentity: RuntimeSinkIdentity;
}): Promise<boolean | undefined> {
  let canonicalGroup: string;
  let groupInfo;
  try {
    canonicalGroup = await realpath(options.groupPath);
    groupInfo = await lstat(canonicalGroup);
  } catch {
    return undefined;
  }
  if (!groupInfo.isDirectory()) return undefined;

  return synchronizedDirectoryOwnsCanonicalSink({
    canonicalDirectory: canonicalGroup,
    canonicalSink: options.canonicalSink,
    excluded: options.excluded,
    logicalPrefix: "",
    sinkIdentity: options.sinkIdentity,
    state: { entries: 0, visitedDirectories: new Set() },
  });
}

async function classicReferenceOwnsCanonicalSink(options: {
  referenceId: string;
  canonicalSink: string;
  sinkIdentity: RuntimeSinkIdentity;
  objects: PbxObjects;
  parents: Map<string, string>;
  projectDirectory: string;
  groupRootDirectory: string;
  seen?: Set<string>;
}): Promise<boolean | undefined> {
  const {
    referenceId,
    canonicalSink,
    sinkIdentity,
    objects,
    parents,
    projectDirectory,
    groupRootDirectory,
    seen = new Set<string>(),
  } = options;
  if (seen.has(referenceId)) return undefined;
  seen.add(referenceId);

  const reference = objects[referenceId];
  if (!reference) return undefined;
  if (["PBXVariantGroup", "XCVersionGroup", "PBXGroup"].includes(reference.isa ?? "")) {
    const children = exactStringArray(reference.children);
    if (!children) return undefined;
    let ownsSink = false;
    for (const child of children) {
      const childOwnership = await classicReferenceOwnsCanonicalSink({
        referenceId: child,
        canonicalSink,
        sinkIdentity,
        objects,
        parents,
        projectDirectory,
        groupRootDirectory,
        seen: new Set(seen),
      });
      if (childOwnership == null) return undefined;
      ownsSink ||= childOwnership;
    }
    return ownsSink;
  }
  if (reference.isa !== "PBXFileReference") return undefined;

  const path = resolvePbxFilePath(
    referenceId,
    objects,
    parents,
    projectDirectory,
    groupRootDirectory,
  );
  if (!path) return undefined;

  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      basename(path) !== "LocalSecrets.plist"
    ) {
      return false;
    }
    return undefined;
  }

  if (info.isFile() && !info.isSymbolicLink()) {
    return sameFileIdentity(info, sinkIdentity);
  }

  let canonicalReference: string;
  let canonicalInfo;
  try {
    canonicalReference = await realpath(path);
    canonicalInfo = await lstat(canonicalReference);
  } catch {
    return undefined;
  }
  if (canonicalInfo.isFile()) return sameFileIdentity(canonicalInfo, sinkIdentity);
  if (!canonicalInfo.isDirectory()) return false;

  return synchronizedDirectoryOwnsCanonicalSink({
    canonicalDirectory: canonicalReference,
    canonicalSink,
    excluded: new Set(),
    logicalPrefix: "",
    sinkIdentity,
    state: { entries: 0, visitedDirectories: new Set() },
  });
}

async function targetOwnsCanonicalRuntimeSink(options: {
  canonicalSink: string;
  groupRootDirectory: string;
  objects: PbxObjects;
  parents: Map<string, string>;
  projectDirectory: string;
  sinkIdentity: RuntimeSinkIdentity;
  target: PbxObject;
  targetId: string;
}): Promise<boolean | undefined> {
  const {
    canonicalSink,
    groupRootDirectory,
    objects,
    parents,
    projectDirectory,
    sinkIdentity,
    target,
    targetId,
  } = options;
  const buildPhaseIds = exactStringArray(target.buildPhases);
  if (!buildPhaseIds) return undefined;

  const resourcePhaseIds = new Set<string>();
  for (const phaseId of buildPhaseIds) {
    const phase = objects[phaseId];
    if (typeof phase?.isa !== "string" || !phase.isa.endsWith("BuildPhase")) return undefined;
    if (phase.isa === "PBXResourcesBuildPhase") resourcePhaseIds.add(phaseId);
  }

  let ownsSink = false;
  for (const phaseId of resourcePhaseIds) {
    const phase = objects[phaseId]!;
    const buildFileIds = exactStringArray(phase.files);
    if (!buildFileIds) return undefined;
    for (const buildFileId of buildFileIds) {
      const buildFile = objects[buildFileId];
      if (buildFile?.isa !== "PBXBuildFile") return undefined;
      const applicability = buildFileIOSApplicability(buildFile);
      if (!applicability.recognized) return undefined;
      if (!applicability.applies) continue;
      const referenceId = asString(buildFile.fileRef);
      if (!referenceId) return undefined;
      const referenceOwnership = await classicReferenceOwnsCanonicalSink({
        referenceId,
        canonicalSink,
        sinkIdentity,
        objects,
        parents,
        projectDirectory,
        groupRootDirectory,
      });
      if (referenceOwnership == null) return undefined;
      ownsSink ||= referenceOwnership;
    }
  }

  const synchronizedGroupIds = optionalExactStringArray(target.fileSystemSynchronizedGroups);
  if (!synchronizedGroupIds) return undefined;
  for (const groupId of synchronizedGroupIds) {
    const group = objects[groupId];
    if (group?.isa !== "PBXFileSystemSynchronizedRootGroup") return undefined;
    const groupPath = resolvePbxFilePath(
      groupId,
      objects,
      parents,
      projectDirectory,
      groupRootDirectory,
    );
    if (!groupPath) return undefined;
    const excluded = provenSynchronizedExclusions(group, targetId, resourcePhaseIds, objects);
    if (!excluded) return undefined;
    const synchronizedOwnership = await synchronizedGroupOwnsCanonicalSink({
      groupPath,
      canonicalSink,
      excluded,
      sinkIdentity,
    });
    if (synchronizedOwnership == null) return undefined;
    ownsSink ||= synchronizedOwnership;
  }

  return ownsSink;
}

async function hasExclusiveRuntimeSinkOwnership(
  root: string,
  projectPath: string,
  targetId: string,
  localSecretsPath: string,
): Promise<boolean> {
  let canonicalSink: string;
  let sinkIdentity: RuntimeSinkIdentity;
  try {
    canonicalSink = await realpath(localSecretsPath);
    const sinkInfo = await lstat(canonicalSink);
    if (!sinkInfo.isFile()) return false;
    sinkIdentity = { dev: sinkInfo.dev, ino: sinkInfo.ino };
  } catch {
    return false;
  }

  const selectedProjectPath = resolve(root, projectPath);
  const inventory = await discoverLocalIOSProjects(root, [selectedProjectPath]);
  if (!inventory.complete) return false;
  const owners = new Set<string>();
  const selectedOwner = `${selectedProjectPath}\0${targetId}`;
  let selectedTargetFound = false;
  for (const absoluteProjectPath of inventory.projectPaths) {
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

    const projectTargetIds = exactStringArray(projectObject.targets);
    if (!projectTargetIds) return false;
    const parents = buildPbxParentIndex(objects);
    const projectDirectory = dirname(absoluteProjectPath);
    const groupRootDirectory = resolve(
      projectDirectory,
      asString(projectObject.projectDirPath) ?? "",
    );

    for (const candidateTargetId of projectTargetIds) {
      const target = objects[candidateTargetId];
      if (!target) return false;
      if (target.isa !== "PBXNativeTarget") continue;
      if (absoluteProjectPath === selectedProjectPath && candidateTargetId === targetId) {
        selectedTargetFound = true;
      }

      const ownership = await targetOwnsCanonicalRuntimeSink({
        canonicalSink,
        groupRootDirectory,
        objects,
        parents,
        projectDirectory,
        sinkIdentity,
        target,
        targetId: candidateTargetId,
      });
      if (ownership == null) return false;
      if (ownership) owners.add(`${absoluteProjectPath}\0${candidateTargetId}`);
    }
  }
  return selectedTargetFound && owners.size === 1 && owners.has(selectedOwner);
}

async function prepareRuntimeKeyVerification(
  options: IOSRuntimeKeyPlanOptions,
): Promise<PreparedRuntimeKeyVerification> {
  const root = resolve(options.root);
  const suppliedProjectPath = options.projectPath.replaceAll("\\", "/");
  if (
    !options.targetId ||
    !suppliedProjectPath ||
    isAbsolute(options.projectPath) ||
    !suppliedProjectPath.endsWith(".xcodeproj") ||
    (options.localSecretsPath != null && isAbsolute(options.localSecretsPath))
  ) {
    return verificationBlocked(
      options,
      root,
      suppliedProjectPath,
      "invalid-selection",
      "A root-relative Xcode project, application target, and optional root-relative LocalSecrets path are required.",
    );
  }

  const absoluteProjectPath = resolve(root, suppliedProjectPath);
  const projectPath = relativeIOSPath(root, absoluteProjectPath);
  if (!(await pathIsSafelyWithinIOSRoot(root, absoluteProjectPath))) {
    return verificationBlocked(
      options,
      root,
      projectPath,
      "external-path",
      "The selected Xcode project resolves outside the project root.",
    );
  }

  const inspection = await inspectIOSProject(root, { target: options.targetId });
  if (
    inspection.selection.state !== "selected" ||
    inspection.selection.targetId !== options.targetId ||
    inspection.selection.projectPath !== projectPath
  ) {
    return verificationBlocked(
      options,
      root,
      projectPath,
      "target-not-found",
      "The selected application target could not be verified in the selected Xcode project.",
    );
  }
  const selectedTarget = inspection.appTargets.find(
    (target) => target.id === options.targetId && target.projectPath === projectPath,
  );
  if (!hasProvenRuntimeKeyWiring(selectedTarget)) {
    return verificationBlocked(
      options,
      root,
      projectPath,
      "unproven-runtime-wiring",
      "The selected target must have exactly one proven app entry point, LocalSecrets configure call, LocalSecrets runtime loader, and target-owned LocalSecrets.plist sink.",
    );
  }
  const membership = await targetLocalSecretsPaths(root, absoluteProjectPath, options.targetId);
  if (membership.blocker) {
    return verificationBlocked(
      options,
      root,
      projectPath,
      membership.blocker.code,
      membership.blocker.message,
    );
  }
  const memberPaths = membership.paths ?? [];
  let localSecretsPath: string | undefined;
  if (options.localSecretsPath != null) {
    const requestedPath = resolve(root, options.localSecretsPath);
    if (!(await pathIsSafelyWithinIOSRoot(root, requestedPath))) {
      return verificationBlocked(
        options,
        root,
        projectPath,
        "external-path",
        "The requested LocalSecrets.plist resolves outside the project root.",
      );
    }
    localSecretsPath = memberPaths.find((path) => resolve(path) === requestedPath);
    if (!localSecretsPath) {
      return verificationBlocked(
        options,
        root,
        projectPath,
        "not-target-resource",
        "The requested LocalSecrets.plist is not a proven resource of the selected target.",
      );
    }
  } else if (memberPaths.length === 0) {
    return verificationBlocked(
      options,
      root,
      projectPath,
      "missing-local-secrets",
      "The selected target does not already own a LocalSecrets.plist resource.",
    );
  } else if (memberPaths.length > 1) {
    return verificationBlocked(
      options,
      root,
      projectPath,
      "ambiguous-local-secrets",
      "The selected target owns more than one LocalSecrets.plist resource; select one explicitly.",
    );
  } else {
    localSecretsPath = memberPaths[0];
  }

  if (
    !localSecretsPath ||
    basename(localSecretsPath) !== "LocalSecrets.plist" ||
    resolve(root, selectedTarget.runtimeKeySinks[0]!.path) !== resolve(localSecretsPath)
  ) {
    return verificationBlocked(
      options,
      root,
      projectPath,
      "not-target-resource",
      "A unique target-owned LocalSecrets.plist resource could not be resolved.",
    );
  }
  if (
    !(await hasExclusiveRuntimeSinkOwnership(root, projectPath, options.targetId, localSecretsPath))
  ) {
    return verificationBlocked(
      options,
      root,
      projectPath,
      "shared-local-secrets",
      "LocalSecrets.plist must be owned exclusively by the selected iOS application target before its runtime key can be verified.",
    );
  }

  const localSecretsRelativePath = relativeIOSPath(root, localSecretsPath);
  const redactedSource = {
    plan: makeVerificationPlan(options, root, projectPath, "ready", {
      localSecretsPath: localSecretsRelativePath,
    }),
  };
  const localSecretsSnapshot = await snapshotExistingFile(
    localSecretsPath,
    MAX_LOCAL_SECRETS_BYTES,
  );
  if (!localSecretsSnapshot) {
    return verificationBlocked(
      options,
      root,
      projectPath,
      "unreadable-local-secrets",
      "LocalSecrets.plist is missing, too large, symlinked, or unreadable.",
      redactedSource,
    );
  }
  const plist = parseXMLPlist(localSecretsSnapshot.bytes!);
  if (!plist) {
    return verificationBlocked(
      options,
      root,
      projectPath,
      "malformed-local-secrets",
      "LocalSecrets.plist must be a readable XML property-list dictionary.",
      redactedSource,
    );
  }
  const existingPublishableKey = existingValidPublishableKey(plist);
  if (
    !existingPublishableKey ||
    plist[SECRET_KEY] !== existingPublishableKey ||
    !inspection.localPublishableKey.found ||
    inspection.localPublishableKey.conflict ||
    inspection.localPublishableKey.source !== localSecretsRelativePath
  ) {
    return verificationBlocked(
      options,
      root,
      projectPath,
      "invalid-publishable-key",
      "The proven LocalSecrets.plist runtime sink does not contain one canonical publishable key that can be verified.",
      redactedSource,
    );
  }

  return {
    plan: makeVerificationPlan(options, root, projectPath, "ready", {
      localSecretsPath: localSecretsRelativePath,
      expectedLocalSecretsHash: localSecretsSnapshot.hash,
    }),
    localSecretsSnapshot,
    existingPublishableKey,
  };
}

export async function planIOSRuntimeKeyVerification(
  options: IOSRuntimeKeyPlanOptions,
): Promise<IOSRuntimeKeyVerificationPlan> {
  return (await prepareRuntimeKeyVerification(options)).plan;
}

export async function verifyIOSRuntimeKey(
  plan: IOSRuntimeKeyVerificationPlan,
  linkedPublishableKey: string,
): Promise<IOSRuntimeKeyVerificationResult> {
  if (plan.status === "blocked") return { status: "blocked", plan };
  if (
    plan.schemaVersion !== 1 ||
    plan.kind !== "clerk-ios-runtime-key-verification" ||
    !plan.localSecretsPath ||
    !plan.expectedLocalSecretsHash
  ) {
    return {
      status: "blocked",
      plan: {
        ...plan,
        status: "blocked",
        blockers: [
          {
            code: "invalid-selection",
            message: "The runtime-key verification plan is incomplete or unsupported.",
          },
        ],
      },
    };
  }

  const linkedKey = validatePublishableKey(linkedPublishableKey);
  if (!linkedKey || linkedKey.value !== linkedPublishableKey) {
    return {
      status: "blocked",
      plan: {
        ...plan,
        status: "blocked",
        blockers: [
          { code: "invalid-publishable-key", message: "A valid publishable key is required." },
        ],
      },
    };
  }
  if (linkedKey.instanceType !== "development") {
    return {
      status: "blocked",
      plan: {
        ...plan,
        status: "blocked",
        blockers: [
          {
            code: "production-publishable-key",
            message: "Runtime-key verification accepts a development-instance key only.",
          },
        ],
      },
    };
  }

  const prepared = await prepareRuntimeKeyVerification({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    localSecretsPath: plan.localSecretsPath,
  });
  if (prepared.plan.status === "blocked") return { status: "blocked", plan: prepared.plan };
  if (
    prepared.plan.expectedLocalSecretsHash !== plan.expectedLocalSecretsHash ||
    !prepared.localSecretsSnapshot ||
    !(await snapshotMatches(prepared.localSecretsSnapshot))
  ) {
    return { status: "stale", plan };
  }

  return {
    status: prepared.existingPublishableKey === linkedKey.value ? "matched" : "mismatched",
    plan,
  };
}

async function prepareRuntimeKeyPlan(
  options: IOSRuntimeKeyPlanOptions,
): Promise<PreparedRuntimeKeyPlan> {
  const root = resolve(options.root);
  const suppliedProjectPath = options.projectPath.replaceAll("\\", "/");
  if (
    !options.targetId ||
    !suppliedProjectPath ||
    isAbsolute(options.projectPath) ||
    !suppliedProjectPath.endsWith(".xcodeproj") ||
    (options.localSecretsPath != null && isAbsolute(options.localSecretsPath))
  ) {
    return blocked(
      options,
      root,
      suppliedProjectPath,
      "invalid-selection",
      "A root-relative Xcode project, application target, and optional root-relative LocalSecrets path are required.",
    );
  }

  const absoluteProjectPath = resolve(root, suppliedProjectPath);
  const projectPath = relativeIOSPath(root, absoluteProjectPath);
  if (!(await pathIsSafelyWithinIOSRoot(root, absoluteProjectPath))) {
    return blocked(
      options,
      root,
      projectPath,
      "external-path",
      "The selected Xcode project resolves outside the project root.",
    );
  }

  const inspection = await inspectIOSProject(root, { target: options.targetId });
  if (
    inspection.selection.state !== "selected" ||
    inspection.selection.targetId !== options.targetId ||
    inspection.selection.projectPath !== projectPath
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "target-not-found",
      "The selected application target could not be verified in the selected Xcode project.",
    );
  }
  const selectedTarget = inspection.appTargets.find(
    (target) => target.id === options.targetId && target.projectPath === projectPath,
  );
  const generator =
    inspection.generatedProject ?? (await generatedProjectKind(root, absoluteProjectPath));
  if (generator) {
    return blocked(
      options,
      root,
      projectPath,
      "generated-project",
      `This is a ${generator === "xcodegen" ? "XcodeGen" : "Tuist"} project; update its source manifest instead of generated target resources.`,
    );
  }
  if (!hasProvenRuntimeKeyWiring(selectedTarget)) {
    return blocked(
      options,
      root,
      projectPath,
      "unproven-runtime-wiring",
      "The selected target must have exactly one proven app entry point, LocalSecrets configure call, LocalSecrets runtime loader, and target-owned LocalSecrets.plist sink.",
    );
  }
  const membership = await targetLocalSecretsPaths(root, absoluteProjectPath, options.targetId);
  if (membership.blocker) {
    return blocked(options, root, projectPath, membership.blocker.code, membership.blocker.message);
  }
  const memberPaths = membership.paths ?? [];
  let localSecretsPath: string | undefined;
  if (options.localSecretsPath != null) {
    const requestedPath = resolve(root, options.localSecretsPath);
    if (!(await pathIsSafelyWithinIOSRoot(root, requestedPath))) {
      return blocked(
        options,
        root,
        projectPath,
        "external-path",
        "The requested LocalSecrets.plist resolves outside the project root.",
      );
    }
    localSecretsPath = memberPaths.find((path) => resolve(path) === requestedPath);
    if (!localSecretsPath) {
      return blocked(
        options,
        root,
        projectPath,
        "not-target-resource",
        "The requested LocalSecrets.plist is not a proven resource of the selected target.",
      );
    }
  } else if (memberPaths.length === 0) {
    return blocked(
      options,
      root,
      projectPath,
      "missing-local-secrets",
      "The selected target does not already own a LocalSecrets.plist resource.",
    );
  } else if (memberPaths.length > 1) {
    return blocked(
      options,
      root,
      projectPath,
      "ambiguous-local-secrets",
      "The selected target owns more than one LocalSecrets.plist resource; select one explicitly.",
    );
  } else {
    localSecretsPath = memberPaths[0];
  }

  if (
    !localSecretsPath ||
    basename(localSecretsPath) !== "LocalSecrets.plist" ||
    resolve(root, selectedTarget.runtimeKeySinks[0]!.path) !== resolve(localSecretsPath)
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "not-target-resource",
      "A unique target-owned LocalSecrets.plist resource could not be resolved.",
    );
  }
  if (
    !(await hasExclusiveRuntimeSinkOwnership(root, projectPath, options.targetId, localSecretsPath))
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "shared-local-secrets",
      "LocalSecrets.plist must be owned exclusively by the selected iOS application target before it can be updated automatically.",
    );
  }
  const localSecretsRelativePath = relativeIOSPath(root, localSecretsPath);
  if (containsControlCharacter(localSecretsRelativePath)) {
    return blocked(
      options,
      root,
      projectPath,
      "unsafe-gitignore",
      "The LocalSecrets.plist path contains control characters that cannot be represented safely in .gitignore.",
    );
  }
  const localSecretsSnapshot = await snapshotExistingFile(
    localSecretsPath,
    MAX_LOCAL_SECRETS_BYTES,
  );
  const redactedSource = {
    plan: makePlan(options, root, projectPath, "ready", {
      localSecretsPath: relativeIOSPath(root, localSecretsPath),
    }),
  };
  if (!localSecretsSnapshot) {
    return blocked(
      options,
      root,
      projectPath,
      "unreadable-local-secrets",
      "LocalSecrets.plist is missing, too large, symlinked, or unreadable.",
      redactedSource,
    );
  }
  const plist = parseXMLPlist(localSecretsSnapshot.bytes!);
  if (!plist) {
    return blocked(
      options,
      root,
      projectPath,
      "malformed-local-secrets",
      "LocalSecrets.plist must be a readable XML property-list dictionary.",
      redactedSource,
    );
  }
  if (plist[SECRET_KEY] != null && typeof plist[SECRET_KEY] !== "string") {
    return blocked(
      options,
      root,
      projectPath,
      "unsupported-local-secrets",
      "The CLERK_PUBLISHABLE_KEY entry in LocalSecrets.plist must be a string.",
      redactedSource,
    );
  }
  const existingNormalizedKey = existingValidPublishableKey(plist);
  const plistMayNeedWrite =
    existingNormalizedKey == null || plist[SECRET_KEY] !== existingNormalizedKey;

  const resolvedGitContext = await coherentGitContext(root, [
    absoluteProjectPath,
    dirname(localSecretsPath),
  ]);
  if (resolvedGitContext.state === "unknown") {
    return blocked(
      options,
      root,
      projectPath,
      "git-state-unknown",
      "Git could not verify whether LocalSecrets.plist is tracked or ignored.",
      redactedSource,
    );
  }
  if (resolvedGitContext.state === "mismatch") {
    return blocked(
      options,
      root,
      projectPath,
      "git-repository-mismatch",
      "The selected Xcode project and LocalSecrets.plist must share the invocation root's Git repository boundary.",
      redactedSource,
    );
  }
  if (await hasDescendantGitignore(root, localSecretsPath)) {
    return blocked(
      options,
      root,
      projectPath,
      "unsafe-gitignore",
      "A nested .gitignore can override the invocation root's LocalSecrets.plist protection. Consolidate the sink's ignore rules at the invocation root before retrying.",
      redactedSource,
    );
  }
  if (resolvedGitContext.state === "repository") {
    const tracked = await gitPathExitCode(
      resolvedGitContext.root,
      ["ls-files", "--error-unmatch"],
      localSecretsPath,
    );
    if (tracked == null) {
      return blocked(
        options,
        root,
        projectPath,
        "git-state-unknown",
        "Git could not verify whether LocalSecrets.plist is tracked.",
        redactedSource,
      );
    }
    if (tracked > 1) {
      return blocked(
        options,
        root,
        projectPath,
        "git-state-unknown",
        "Git could not verify whether LocalSecrets.plist is tracked.",
        redactedSource,
      );
    }
    if (tracked === 0) {
      return blocked(
        options,
        root,
        projectPath,
        "tracked-local-secrets",
        "LocalSecrets.plist is tracked by Git. Remove it from the index before writing a publishable key.",
        redactedSource,
      );
    }
  }

  const gitignorePath = resolve(root, ".gitignore");
  const gitignoreSnapshot = await snapshotOptionalFile(
    root,
    gitignorePath,
    MAX_GITIGNORE_BYTES,
    0o644,
  );
  if (!gitignoreSnapshot) {
    return blocked(
      options,
      root,
      projectPath,
      "unsafe-gitignore",
      ".gitignore is too large, symlinked, unreadable, or resolves outside the project root.",
      redactedSource,
    );
  }
  const rule = gitignoreRule(root, localSecretsPath);
  const gitignoreText = gitignoreSnapshot.exists ? decodeUTF8(gitignoreSnapshot.bytes!) : "";
  if (gitignoreText == null) {
    return blocked(
      options,
      root,
      projectPath,
      "unsafe-gitignore",
      ".gitignore must be valid UTF-8.",
      redactedSource,
    );
  }

  const hasExactRule = gitignoreContainsRule(gitignoreText, rule);
  let effectivelyIgnored = hasExactRule && gitignoreEndsWithRule(gitignoreText, rule);
  if (resolvedGitContext.state === "repository") {
    const ignored = await gitPathExitCode(
      resolvedGitContext.root,
      ["check-ignore", "--quiet", "--no-index"],
      localSecretsPath,
    );
    if (ignored == null || ignored > 1) {
      return blocked(
        options,
        root,
        projectPath,
        "git-state-unknown",
        "Git could not verify whether LocalSecrets.plist is effectively ignored.",
        redactedSource,
      );
    }
    effectivelyIgnored = ignored === 0;
  }
  const gitignoreNeeded = !hasExactRule || !effectivelyIgnored;
  const changesGitignore = gitignoreNeeded || plistMayNeedWrite;

  const gitignoreRelativePath = relativeIOSPath(root, gitignorePath);
  return {
    plan: makePlan(options, root, projectPath, "ready", {
      localSecretsPath: localSecretsRelativePath,
      gitignorePath: gitignoreRelativePath,
      gitignoreRule: rule,
      expectedLocalSecretsHash: localSecretsSnapshot.hash,
      expectedGitignoreHash: gitignoreSnapshot.exists ? gitignoreSnapshot.hash! : null,
      changesGitignore,
      actions: [
        ...(changesGitignore
          ? [
              `Ensure ${localSecretsRelativePath} and its atomic-write staging file are effectively ignored by Git.`,
            ]
          : []),
        `Set CLERK_PUBLISHABLE_KEY in ${localSecretsRelativePath} without exposing its value.`,
      ],
    }),
    plist,
    localSecretsSnapshot,
    gitignoreSnapshot,
    gitContext: resolvedGitContext,
    gitignoreNeeded,
  };
}

export async function planIOSRuntimeKey(
  options: IOSRuntimeKeyPlanOptions,
): Promise<IOSRuntimeKeyPlan> {
  return (await prepareRuntimeKeyPlan(options)).plan;
}

function validatePublishableKey(
  value: string,
): { value: string; instanceType: "development" | "production" } | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  try {
    return { value: normalized, instanceType: decodePublishableKey(normalized).instanceType };
  } catch {
    return undefined;
  }
}

function existingValidPublishableKey(plist: Record<string, unknown>): string | undefined {
  const value = plist[SECRET_KEY];
  if (typeof value !== "string") return undefined;
  return validatePublishableKey(value)?.value;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function plistWithoutPublishableKey(plist: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(plist).filter(([key]) => key !== SECRET_KEY));
}

function replaceOrInsertPublishableKey(
  originalBytes: Uint8Array,
  originalPlist: Record<string, unknown>,
  publishableKey: string,
): Uint8Array | undefined {
  const source = decodeUTF8(originalBytes);
  if (!source) return undefined;
  const keyTag = /<key>\s*CLERK_PUBLISHABLE_KEY\s*<\/key>/g;
  const matches = [...source.matchAll(keyTag)];
  if (matches.length > 1) return undefined;
  if (matches.length === 0 && Object.hasOwn(originalPlist, SECRET_KEY)) return undefined;

  let candidate: string;
  if (matches.length === 1) {
    const match = matches[0]!;
    const keyEnd = match.index! + match[0].length;
    const suffix = source.slice(keyEnd);
    const stringValue = /^(\s*)<string\s*>([\s\S]*?)<\/string>/.exec(suffix);
    const emptyStringValue = /^(\s*)<string\s*\/>/.exec(suffix);
    if (stringValue) {
      const replacement = `${stringValue[1]}<string>${xmlEscape(publishableKey)}</string>`;
      candidate = `${source.slice(0, keyEnd)}${replacement}${suffix.slice(stringValue[0].length)}`;
    } else if (emptyStringValue) {
      const replacement = `${emptyStringValue[1]}<string>${xmlEscape(publishableKey)}</string>`;
      candidate = `${source.slice(0, keyEnd)}${replacement}${suffix.slice(emptyStringValue[0].length)}`;
    } else {
      return undefined;
    }
  } else {
    const closing = source.lastIndexOf("</dict>");
    if (closing === -1) return undefined;
    const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
    const lineStart = source.lastIndexOf("\n", closing - 1) + 1;
    const possibleIndent = source.slice(lineStart, closing);
    if (/^[\t ]*$/.test(possibleIndent)) {
      const childIndent = `${possibleIndent}${source.includes("\t<key>") ? "\t" : "  "}`;
      const insertion = `${childIndent}<key>${SECRET_KEY}</key>${lineEnding}${childIndent}<string>${xmlEscape(publishableKey)}</string>${lineEnding}`;
      candidate = `${source.slice(0, lineStart)}${insertion}${source.slice(lineStart)}`;
    } else {
      candidate = `${source.slice(0, closing)}<key>${SECRET_KEY}</key><string>${xmlEscape(publishableKey)}</string>${source.slice(closing)}`;
    }
  }

  const candidateBytes = new TextEncoder().encode(candidate);
  const candidatePlist = parseXMLPlist(candidateBytes);
  if (
    !candidatePlist ||
    candidatePlist[SECRET_KEY] !== publishableKey ||
    !isDeepStrictEqual(
      plistWithoutPublishableKey(originalPlist),
      plistWithoutPublishableKey(candidatePlist),
    )
  ) {
    return undefined;
  }
  return candidateBytes;
}

async function snapshotMatches(snapshot: FileSnapshot): Promise<boolean> {
  if (!snapshot.exists) {
    try {
      await lstat(snapshot.path);
      return false;
    } catch (error) {
      return isFileSystemError(error, "ENOENT");
    }
  }
  return (
    snapshot.identity !== undefined &&
    snapshot.hash !== undefined &&
    (await fileMatchesIdentityAndHash(snapshot.path, snapshot.identity, snapshot.hash))
  );
}

async function fileMatchesHash(
  path: string,
  maximumBytes: number,
  expectedHash: string,
): Promise<boolean> {
  const snapshot = await snapshotExistingFile(path, maximumBytes);
  return snapshot?.hash === expectedHash;
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Same-directory rename/link remains atomic when directory fsync is unavailable.
  }
}

function runtimeKeySiblingPath(path: string): string {
  return resolve(dirname(path), `.${basename(path)}.clerk-${process.pid}-${randomUUID()}.tmp`);
}

type ClaimDestinationResult = { status: "claimed"; claim: ClaimedFile } | { status: "stale" };

async function claimDestination(
  staged: StagedFile,
  expectedIdentity: FileIdentity,
  expectedHash: string,
  claimPathIsSafe = staged.claimPathIsSafe,
): Promise<ClaimDestinationResult> {
  const claimPath = runtimeKeySiblingPath(staged.targetPath);
  if (staged.keyBearing && !(await claimPathIsSafe?.(claimPath))) {
    throw new RuntimeKeyClaimProtectionError(claimPath);
  }
  try {
    await rename(staged.targetPath, claimPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { status: "stale" };
    throw error;
  }

  const movedIdentity = await readPathIdentity(claimPath);
  if (!movedIdentity) {
    throw new RuntimeKeyFileOwnershipError(
      "a claimed runtime-key destination could not be identified after it was moved",
    );
  }
  const claim: ClaimedFile = { path: claimPath, present: true, identity: movedIdentity };
  staged.recoveryClaims.push(claim);
  if (staged.keyBearing && !(await claimPathIsSafe?.(claimPath))) {
    await restoreClaimWithoutClobber(claim, staged.targetPath);
    throw new RuntimeKeyClaimProtectionError(claimPath);
  }
  const movedExpectedFile =
    identitiesMatch(movedIdentity, expectedIdentity) &&
    (await fileMatchesIdentityAndHash(claimPath, expectedIdentity, expectedHash));
  if (movedExpectedFile) return { status: "claimed", claim };

  await restoreClaimWithoutClobber(claim, staged.targetPath);
  return { status: "stale" };
}

async function stageFile(
  snapshot: FileSnapshot,
  content: Uint8Array,
  options: StageFileOptions = {},
): Promise<StagedFile> {
  const temporaryPath = runtimeKeySiblingPath(snapshot.path);
  let created = false;
  let openedIdentity: FileIdentity | undefined;
  try {
    const file = await open(temporaryPath, "wx", snapshot.mode);
    created = true;
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("staged path was not a regular file");
      openedIdentity = { dev: info.dev, ino: info.ino, mode: info.mode & 0o7777 };
      if (options.beforeWrite && !(await options.beforeWrite(temporaryPath))) {
        throw new Error("temporary path is not safely ignored");
      }
      await file.writeFile(content);
      if (options.forceFailureAfterCreate) throw new Error("injected staging failure");
      await file.chmod(snapshot.mode);
      await file.sync();
    } finally {
      await file.close();
    }
    const stagedIdentity = await readRegularFileIdentity(temporaryPath);
    if (
      !openedIdentity ||
      !stagedIdentity ||
      !sameFile(stagedIdentity, openedIdentity) ||
      stagedIdentity.mode !== snapshot.mode ||
      !(await fileMatchesIdentityAndHash(temporaryPath, stagedIdentity, sha256(content)))
    ) {
      throw new Error("staged runtime-key file changed before it could be committed");
    }
    return {
      targetPath: snapshot.path,
      temporaryPath,
      candidateHash: sha256(content),
      original: snapshot,
      committed: false,
      cleanupFailuresRemaining: options.cleanupFailures ?? 0,
      keyBearing: options.keyBearing === true,
      temporaryPresent: true,
      stagedIdentity,
      recoveryClaims: [],
      claimPathIsSafe: options.claimPathIsSafe,
      rollbackClaimPathIsSafe: options.rollbackClaimPathIsSafe,
    };
  } catch {
    if (created) {
      try {
        const currentIdentity = await readRegularFileIdentity(temporaryPath);
        if (!openedIdentity || !currentIdentity || !sameFile(currentIdentity, openedIdentity)) {
          throw new Error("the staged runtime-key path no longer identified this transaction");
        }
        await rm(temporaryPath);
      } catch {
        throw new RuntimeKeyTemporaryFileCleanupError(
          "A temporary runtime-key file could not be removed. Inspect the LocalSecrets.plist directory for a .clerk-*.tmp file before continuing.",
          options.keyBearing === true,
        );
      }
    }
    throw new Error("The runtime-key update could not be staged safely.");
  }
}

async function removeStagedTemporaryFile(staged: StagedFile): Promise<void> {
  if (!staged.temporaryPresent) return;
  if (staged.cleanupFailuresRemaining > 0) {
    staged.cleanupFailuresRemaining -= 1;
    throw new RuntimeKeyTemporaryFileCleanupError(
      "A temporary runtime-key file could not be removed. Inspect the LocalSecrets.plist directory for a .clerk-*.tmp file before continuing.",
      staged.keyBearing,
    );
  }
  try {
    const identity = await readRegularFileIdentity(staged.temporaryPath);
    if (!identity || !sameFile(identity, staged.stagedIdentity)) {
      throw new Error("the staged runtime-key path no longer identified this transaction");
    }
    await rm(staged.temporaryPath);
    staged.temporaryPresent = false;
  } catch {
    throw new RuntimeKeyTemporaryFileCleanupError(
      "A temporary runtime-key file could not be removed. Inspect the LocalSecrets.plist directory for a .clerk-*.tmp file before continuing.",
      staged.keyBearing,
    );
  }
}

async function committedCandidateMatches(staged: StagedFile): Promise<boolean> {
  const identity = staged.committedIdentity ?? staged.stagedIdentity;
  return fileMatchesIdentityAndHash(staged.targetPath, identity, staged.candidateHash);
}

async function claimedOriginalMatches(staged: StagedFile): Promise<boolean> {
  if (!staged.original.exists) return true;
  return (
    staged.claimedOriginal?.present === true &&
    staged.original.hash !== undefined &&
    (await fileMatchesIdentityAndHash(
      staged.claimedOriginal.path,
      staged.claimedOriginal.identity,
      staged.original.hash,
    ))
  );
}

async function commitStagedFile(
  staged: StagedFile,
  options: IOSRuntimeKeyApplyOptions = {},
): Promise<"written" | "stale"> {
  if (!(await snapshotMatches(staged.original))) return "stale";
  if (staged.original.exists) {
    if (!staged.original.identity || !staged.original.hash) return "stale";
    const claimResult = await claimDestination(
      staged,
      staged.original.identity,
      staged.original.hash,
    );
    if (claimResult.status === "stale") return "stale";
    staged.claimedOriginal = claimResult.claim;
    let installed = false;
    try {
      if (
        !(await claimedOriginalMatches(staged)) ||
        !(await fileMatchesIdentityAndHash(
          staged.temporaryPath,
          staged.stagedIdentity,
          staged.candidateHash,
        ))
      ) {
        throw new RuntimeKeyFileOwnershipError(
          "a runtime-key transaction file changed before installation",
        );
      }
      await options.beforeStagedCommitInstall?.(staged.targetPath, staged.claimedOriginal.path);
      if (!(await claimedOriginalMatches(staged))) {
        throw new RuntimeKeyFileOwnershipError(
          "the claimed runtime-key original changed before installation",
        );
      }
      const installResult = await linkOwnedSourceWithoutClobber(
        staged.temporaryPath,
        staged.stagedIdentity,
        staged.candidateHash,
        staged.targetPath,
      );
      if (installResult === "occupied") {
        await removeClaimedPath(staged.claimedOriginal, {
          expectedHash: staged.original.hash,
          expectedMode: staged.original.mode,
        });
        await syncDirectory(dirname(staged.targetPath));
        return "stale";
      }
      installed = true;
    } catch (error) {
      if (!installed && staged.claimedOriginal.present) {
        try {
          await restoreClaimWithoutClobber(staged.claimedOriginal, staged.targetPath);
        } catch (restoreError) {
          throw new RuntimeKeyFileOwnershipError(
            "the claimed runtime-key original could not be restored after commit stopped",
            { cause: new AggregateError([error, restoreError]) },
          );
        }
      }
      throw error;
    }
  } else {
    const installResult = await linkOwnedSourceWithoutClobber(
      staged.temporaryPath,
      staged.stagedIdentity,
      staged.candidateHash,
      staged.targetPath,
    );
    if (installResult === "occupied") return "stale";
  }
  staged.committed = true;
  staged.committedIdentity = staged.stagedIdentity;
  await syncDirectory(dirname(staged.targetPath));
  if (!(await committedCandidateMatches(staged))) {
    throw new RuntimeKeyFileOwnershipError(
      "the committed runtime-key destination changed before it could be verified",
    );
  }
  await removeStagedTemporaryFile(staged);
  return "written";
}

async function cleanupStagedFile(staged: StagedFile): Promise<void> {
  await removeStagedTemporaryFile(staged);
}

async function releaseClaimedOriginals(stagedFiles: readonly StagedFile[]): Promise<boolean> {
  const withClaims = stagedFiles.filter(
    (staged) => staged.committed && staged.claimedOriginal?.present,
  );
  const states = await Promise.all(
    withClaims.map(async (staged) =>
      Boolean(
        staged.original.hash &&
        (await committedCandidateMatches(staged)) &&
        (await claimedOriginalMatches(staged)),
      ),
    ),
  );
  if (!states.every(Boolean)) return false;
  for (const staged of withClaims) {
    await removeClaimedPath(staged.claimedOriginal!, {
      expectedHash: staged.original.hash,
      expectedMode: staged.original.mode,
    });
  }
  return true;
}

async function discardClaimedOriginal(staged: StagedFile): Promise<boolean> {
  if (!staged.claimedOriginal?.present) return true;
  if (!staged.original.hash || !(await claimedOriginalMatches(staged))) return false;
  await removeClaimedPath(staged.claimedOriginal, {
    expectedHash: staged.original.hash,
    expectedMode: staged.original.mode,
  });
  staged.committed = false;
  return true;
}

async function restoreCommittedFile(
  staged: StagedFile,
  options: IOSRuntimeKeyApplyOptions = {},
): Promise<"restored" | "stale"> {
  if (!(await committedCandidateMatches(staged))) return "stale";
  const candidateIdentity = staged.committedIdentity ?? staged.stagedIdentity;
  const candidateClaimResult = await claimDestination(
    staged,
    candidateIdentity,
    staged.candidateHash,
    staged.rollbackClaimPathIsSafe,
  );
  if (candidateClaimResult.status === "stale") return "stale";
  const candidateClaim = candidateClaimResult.claim;
  if (!staged.original.exists) {
    await removeClaimedPath(candidateClaim, {
      expectedHash: staged.candidateHash,
      expectedMode: staged.original.mode,
    });
    await syncDirectory(dirname(staged.targetPath));
    staged.committed = false;
    return "restored";
  }

  let rollback: StagedFile | undefined;
  const originalClaim = staged.claimedOriginal?.present ? staged.claimedOriginal : undefined;
  if (!originalClaim) {
    rollback = await stageFile(
      {
        path: staged.targetPath,
        exists: false,
        mode: staged.original.mode,
      },
      staged.original.bytes!,
      {
        keyBearing: staged.keyBearing,
        beforeWrite: staged.claimPathIsSafe,
        claimPathIsSafe: staged.claimPathIsSafe,
        rollbackClaimPathIsSafe: staged.rollbackClaimPathIsSafe,
      },
    );
  }
  const originalSourcePath = originalClaim?.path ?? rollback!.temporaryPath;
  const originalSource = await readRegularFileIdentityAndHash(originalSourcePath);
  if (
    !originalSource ||
    (originalClaim && !sameFile(originalSource.identity, originalClaim.identity)) ||
    (rollback && !sameFile(originalSource.identity, rollback.stagedIdentity))
  ) {
    throw new RuntimeKeyFileOwnershipError(
      "the original runtime-key file could not be identified during rollback",
    );
  }
  let sourceInstalled = false;
  try {
    await options.beforeStagedRollbackInstall?.(
      staged.targetPath,
      originalSourcePath,
      candidateClaim.path,
    );
    const installResult = await linkOwnedSourceWithoutClobber(
      originalSourcePath,
      originalSource.identity,
      originalSource.hash,
      staged.targetPath,
    );
    if (installResult === "occupied") {
      await removeClaimedPath(candidateClaim, {
        expectedHash: staged.candidateHash,
        expectedMode: staged.original.mode,
      });
      return "stale";
    }
    sourceInstalled = true;
    const restoredIdentity = await readRegularFileIdentity(staged.targetPath);
    if (
      !restoredIdentity ||
      !sameFile(restoredIdentity, originalSource.identity) ||
      !(await fileMatchesIdentityAndHash(
        staged.targetPath,
        originalSource.identity,
        originalSource.hash,
      ))
    ) {
      throw new RuntimeKeyFileOwnershipError(
        "the restored runtime-key destination did not match its recovery source",
      );
    }
    await removeClaimedPath(candidateClaim, {
      expectedHash: staged.candidateHash,
      expectedMode: staged.original.mode,
    });
    if (originalClaim) {
      await removeClaimedPath(originalClaim, {
        expectedHash: originalSource.hash,
        expectedMode: originalSource.identity.mode,
      });
    }
    staged.committed = false;
    await syncDirectory(dirname(staged.targetPath));
    return "restored";
  } catch (error) {
    if (!sourceInstalled) {
      try {
        const publicIdentity = await readPathIdentity(staged.targetPath);
        if (!publicIdentity) {
          await restoreClaimWithoutClobber(candidateClaim, staged.targetPath);
        } else if (candidateClaim.present) {
          await removeClaimedPath(candidateClaim, {
            expectedHash: staged.candidateHash,
            expectedMode: staged.original.mode,
          });
        }
      } catch (restoreError) {
        throw new RuntimeKeyFileOwnershipError(
          "the claimed runtime-key candidate could not be recovered after rollback stopped",
          { cause: new AggregateError([error, restoreError]) },
        );
      }
    }
    throw error;
  } finally {
    if (rollback) await cleanupStagedFile(rollback);
  }
}

async function rollbackFiles(
  stagedFiles: StagedFile[],
  dependency: RollbackDependency,
  preserveProtection = false,
): Promise<boolean> {
  let fullyRestored = true;
  let payloadIsUnsafe = preserveProtection;
  let cleanupFailure: RuntimeKeyTemporaryFileCleanupError | undefined;
  for (const staged of stagedFiles) {
    if (staged.targetPath !== dependency.payloadPath || staged.committed) continue;
    try {
      await cleanupStagedFile(staged);
    } catch (error) {
      fullyRestored = false;
      payloadIsUnsafe = true;
      if (error instanceof RuntimeKeyTemporaryFileCleanupError) {
        cleanupFailure ??= error;
      }
    }
    if (staged.keyBearing && staged.recoveryClaims.some((claim) => claim.present)) {
      fullyRestored = false;
      payloadIsUnsafe = true;
    }
  }
  const payload = stagedFiles.find(
    (staged) => staged.committed && staged.targetPath === dependency.payloadPath,
  );
  const ordered = [
    ...(payload ? [payload] : []),
    ...[...stagedFiles].reverse().filter((staged) => staged !== payload),
  ];
  const keyBearingPaths = (): string[] =>
    stagedFiles
      .filter((staged) => staged.keyBearing)
      .flatMap((staged) => [
        ...(staged.committed ? [staged.targetPath] : []),
        ...(staged.temporaryPresent ? [staged.temporaryPath] : []),
        ...staged.recoveryClaims.filter((claim) => claim.present).map((claim) => claim.path),
      ]);
  for (const staged of ordered) {
    if (!staged.committed) continue;
    if (staged.targetPath === dependency.protectionPath && payloadIsUnsafe) {
      fullyRestored = false;
      continue;
    }
    try {
      let restoreResult: "restored" | "stale";
      try {
        restoreResult = await restoreCommittedFile(staged, dependency.options);
      } catch (error) {
        if (
          !(error instanceof RuntimeKeyClaimProtectionError) ||
          staged.targetPath !== dependency.payloadPath ||
          !(await ensureRollbackProtection(dependency, keyBearingPaths(), error.claimPath))
        ) {
          throw error;
        }
        restoreResult = await restoreCommittedFile(staged, dependency.options);
      }
      if (restoreResult === "restored") {
        continue;
      }
      if (staged.targetPath === dependency.protectionPath && !payloadIsUnsafe) {
        // The payload is back to a non-key-bearing state, so retain a concurrent
        // ignore-file edit instead of overwriting it merely to restore our guard.
        if (!(await discardClaimedOriginal(staged))) fullyRestored = false;
        continue;
      }
    } catch (error) {
      if (error instanceof RuntimeKeyTemporaryFileCleanupError) {
        cleanupFailure ??= error;
        if (staged.targetPath === dependency.payloadPath) payloadIsUnsafe = true;
        if (!staged.committed) continue;
      }
      // Continue so independent files are still restored when it is safe to do so.
    }
    fullyRestored = false;
    if (staged.targetPath === dependency.payloadPath) payloadIsUnsafe = true;
  }
  if (payloadIsUnsafe) {
    if (!(await ensureRollbackProtection(dependency, keyBearingPaths()))) {
      fullyRestored = false;
    }
  }
  if (cleanupFailure) throw cleanupFailure;
  return fullyRestored;
}

async function ensureRollbackProtection(
  dependency: RollbackDependency,
  keyBearingPaths: string[],
  prospectiveClaimPath?: string,
): Promise<boolean> {
  const pathsAreProtected =
    keyBearingPaths.length > 0 &&
    (
      await Promise.all(
        keyBearingPaths.map(async (path) =>
          localSecretsIsIgnored(
            dependency.root,
            path,
            path === dependency.payloadPath
              ? dependency.protectionRules.at(-1)!
              : dependency.protectionRules[0]!,
          ),
        ),
      )
    ).every(Boolean);
  const prospectiveClaimIsProtected =
    prospectiveClaimPath == null ||
    (await localSecretsClaimPathIsIgnored(
      dependency.root,
      prospectiveClaimPath,
      dependency.protectionRules[0]!,
    ));
  if (pathsAreProtected && prospectiveClaimIsProtected) {
    return true;
  }

  const current = await snapshotOptionalFile(
    dependency.root,
    dependency.protectionPath,
    MAX_GITIGNORE_BYTES,
    0o644,
  );
  if (!current) return false;
  const currentText = current.exists ? decodeUTF8(current.bytes!) : "";
  if (currentText == null) return false;

  let protectedText = currentText;
  for (const rule of dependency.protectionRules) {
    protectedText = appendGitignoreRule(protectedText, rule);
  }
  const protection = await stageFile(current, new TextEncoder().encode(protectedText));
  try {
    if ((await commitStagedFile(protection)) !== "written") return false;
    if (!(await releaseClaimedOriginals([protection]))) return false;
  } finally {
    await cleanupStagedFile(protection);
  }

  const protectedPaths = (
    await Promise.all(
      keyBearingPaths.map(async (path) =>
        localSecretsIsIgnored(
          dependency.root,
          path,
          path === dependency.payloadPath
            ? dependency.protectionRules.at(-1)!
            : dependency.protectionRules[0]!,
        ),
      ),
    )
  ).every(Boolean);
  return (
    protectedPaths &&
    (prospectiveClaimPath == null ||
      (await localSecretsClaimPathIsIgnored(
        dependency.root,
        prospectiveClaimPath,
        dependency.protectionRules[0]!,
      )))
  );
}

async function localSecretsIsIgnored(
  root: string,
  localSecretsPath: string,
  rule: string,
): Promise<boolean> {
  if (await hasDescendantGitignore(root, localSecretsPath)) return false;
  const gitignore = await snapshotExistingFile(resolve(root, ".gitignore"), MAX_GITIGNORE_BYTES);
  const gitignoreText = gitignore?.bytes ? decodeUTF8(gitignore.bytes) : undefined;
  if (gitignoreText == null || !gitignoreContainsRule(gitignoreText, rule)) return false;
  const context = await coherentGitContext(root, [dirname(localSecretsPath)]);
  if (context.state === "repository") {
    const tracked = await gitPathExitCode(
      context.root,
      ["ls-files", "--error-unmatch"],
      localSecretsPath,
    );
    if (tracked !== 1) return false;
    const ignored = await gitPathExitCode(
      context.root,
      ["check-ignore", "--quiet", "--no-index"],
      localSecretsPath,
    );
    return ignored === 0;
  }
  return (
    context.state === "not-repository" &&
    gitignoreRuleIsEffectiveWithoutRepository(gitignoreText, rule)
  );
}

async function localSecretsClaimPathIsIgnored(
  root: string,
  claimPath: string,
  rule: string,
): Promise<boolean> {
  if (await hasDescendantGitignore(root, claimPath)) return false;
  const gitignore = await snapshotExistingFile(resolve(root, ".gitignore"), MAX_GITIGNORE_BYTES);
  const gitignoreText = gitignore?.bytes ? decodeUTF8(gitignore.bytes) : undefined;
  if (gitignoreText == null || !gitignoreContainsRule(gitignoreText, rule)) return false;
  const context = await coherentGitContext(root, [dirname(claimPath)]);
  if (context.state === "repository") {
    const tracked = await prospectiveGitPathExitCode(
      context.root,
      ["ls-files", "--error-unmatch"],
      claimPath,
    );
    if (tracked !== 1) return false;
    const ignored = await prospectiveGitPathExitCode(
      context.root,
      ["check-ignore", "--quiet", "--no-index"],
      claimPath,
    );
    return ignored === 0;
  }
  return (
    context.state === "not-repository" &&
    gitignoreRuleIsEffectiveWithoutRepository(gitignoreText, rule)
  );
}

async function postWriteIsValid(plan: IOSRuntimeKeyPlan, publishableKey: string): Promise<boolean> {
  if (!plan.localSecretsPath || !plan.gitignoreRule) return false;
  const localSecretsPath = resolve(plan.root, plan.localSecretsPath);
  if (!(await pathIsSafelyWithinIOSRoot(plan.root, localSecretsPath))) return false;
  const snapshot = await snapshotExistingFile(localSecretsPath, MAX_LOCAL_SECRETS_BYTES);
  const plist = snapshot?.bytes ? parseXMLPlist(snapshot.bytes) : undefined;
  const installedKey =
    plist && typeof plist[SECRET_KEY] === "string"
      ? validatePublishableKey(plist[SECRET_KEY])?.value
      : undefined;
  if (installedKey !== publishableKey) return false;
  const gitBoundary = await coherentGitContext(plan.root, [
    resolve(plan.root, plan.projectPath),
    dirname(localSecretsPath),
  ]);
  if (gitBoundary.state === "unknown" || gitBoundary.state === "mismatch") return false;
  if (!(await localSecretsIsIgnored(plan.root, localSecretsPath, plan.gitignoreRule))) {
    return false;
  }
  const inspection = await inspectIOSProject(plan.root, { target: plan.targetId });
  if (
    inspection.selection.state !== "selected" ||
    inspection.selection.projectPath !== plan.projectPath ||
    inspection.selection.targetId !== plan.targetId ||
    inspection.generatedProject != null
  ) {
    return false;
  }
  if (await generatedProjectKind(plan.root, resolve(plan.root, plan.projectPath))) return false;
  const selectedTarget = inspection.appTargets.find(
    (target) => target.id === plan.targetId && target.projectPath === plan.projectPath,
  );
  if (
    !hasProvenRuntimeKeyWiring(selectedTarget) ||
    selectedTarget.runtimeKeySinks[0]?.path !== plan.localSecretsPath
  ) {
    return false;
  }
  if (
    !(await hasExclusiveRuntimeSinkOwnership(
      plan.root,
      plan.projectPath,
      plan.targetId,
      localSecretsPath,
    ))
  ) {
    return false;
  }
  const selectedSource = inspection.localPublishableKey.source;
  return (
    inspection.localPublishableKey.found &&
    !inspection.localPublishableKey.conflict &&
    selectedSource === plan.localSecretsPath
  );
}

export async function applyIOSRuntimeKey(
  plan: IOSRuntimeKeyPlan,
  publishableKey: string,
  options: IOSRuntimeKeyApplyOptions = {},
): Promise<IOSRuntimeKeyApplyResult> {
  if (plan.status === "blocked") return { status: "blocked", plan };
  if (
    plan.schemaVersion !== 1 ||
    plan.kind !== "clerk-ios-runtime-key" ||
    !plan.localSecretsPath ||
    !plan.gitignorePath ||
    !plan.gitignoreRule ||
    !plan.expectedLocalSecretsHash ||
    plan.expectedGitignoreHash === undefined ||
    typeof plan.changesGitignore !== "boolean"
  ) {
    return {
      status: "blocked",
      plan,
      message: "The runtime-key plan is incomplete or unsupported.",
    };
  }

  const validatedKey = validatePublishableKey(publishableKey);
  if (!validatedKey) {
    return {
      status: "blocked",
      plan: {
        ...plan,
        status: "blocked",
        blockers: [
          {
            code: "invalid-publishable-key",
            message: "A valid Clerk publishable key is required.",
          },
        ],
      },
    };
  }
  if (validatedKey.instanceType !== "development") {
    return {
      status: "blocked",
      plan: {
        ...plan,
        status: "blocked",
        blockers: [
          {
            code: "production-publishable-key",
            message:
              "Automatic iOS runtime wiring accepts a development-instance publishable key only.",
          },
        ],
      },
    };
  }
  const normalizedKey = validatedKey.value;
  const targetGitignoreRule = plan.gitignoreRule;

  const prepared = await prepareRuntimeKeyPlan({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    localSecretsPath: plan.localSecretsPath,
  });
  if (prepared.plan.status === "blocked") {
    return { status: "blocked", plan: prepared.plan };
  }
  if (
    prepared.plan.expectedLocalSecretsHash !== plan.expectedLocalSecretsHash ||
    prepared.plan.expectedGitignoreHash !== plan.expectedGitignoreHash
  ) {
    return {
      status: "stale",
      plan,
      message: "LocalSecrets.plist or .gitignore changed after the plan was created.",
    };
  }
  const localSecretsSnapshot = prepared.localSecretsSnapshot!;
  const gitignoreSnapshot = prepared.gitignoreSnapshot!;
  const plist = prepared.plist!;
  const existingKey = existingValidPublishableKey(plist);
  if (existingKey && existingKey !== normalizedKey) {
    return {
      status: "blocked",
      plan: {
        ...plan,
        status: "blocked",
        blockers: [
          {
            code: "different-publishable-key",
            message:
              "LocalSecrets.plist already contains a different valid publishable key; it was preserved.",
          },
        ],
      },
    };
  }

  const needsPlistWrite = existingKey !== normalizedKey || plist[SECRET_KEY] !== normalizedKey;
  const needsGitignoreWrite = prepared.gitignoreNeeded === true;
  if (!needsPlistWrite && !needsGitignoreWrite) {
    return { status: "satisfied", plan };
  }

  const plistCandidate = needsPlistWrite
    ? replaceOrInsertPublishableKey(localSecretsSnapshot.bytes!, plist, normalizedKey)
    : undefined;
  if (needsPlistWrite && !plistCandidate) {
    return {
      status: "blocked",
      plan: {
        ...plan,
        status: "blocked",
        blockers: [
          {
            code: "unsupported-local-secrets",
            message:
              "The publishable-key entry could not be updated without changing unrelated plist data.",
          },
        ],
      },
    };
  }

  const gitignoreText = gitignoreSnapshot.exists ? decodeUTF8(gitignoreSnapshot.bytes!) : "";
  if (gitignoreText == null) {
    return {
      status: "blocked",
      plan,
      message: ".gitignore is not valid UTF-8.",
    };
  }
  const temporaryRule = needsPlistWrite
    ? gitignoreTemporaryRule(plan.root, localSecretsSnapshot.path)
    : undefined;
  let gitignoreCandidateText = gitignoreText;
  if (temporaryRule) {
    // This durable guard makes a crash-safe same-filesystem atomic write possible: no key
    // bytes are written to the staged plist until Git proves this pattern is effective.
    gitignoreCandidateText = appendGitignoreRule(gitignoreCandidateText, temporaryRule);
  }
  if (needsGitignoreWrite || temporaryRule) {
    // Keep the exact target rule last so it is portable even before a repository exists.
    gitignoreCandidateText = appendGitignoreRule(gitignoreCandidateText, plan.gitignoreRule);
  }
  const gitignoreCandidate =
    gitignoreCandidateText !== gitignoreText
      ? new TextEncoder().encode(gitignoreCandidateText)
      : undefined;
  const gitignoreCandidateHash = gitignoreCandidate
    ? sha256(gitignoreCandidate)
    : gitignoreSnapshot.hash;

  const stagedFiles: StagedFile[] = [];
  const rollbackDependency: RollbackDependency = {
    root: plan.root,
    payloadPath: localSecretsSnapshot.path,
    protectionPath: gitignoreSnapshot.path,
    protectionRules: [...(temporaryRule ? [temporaryRule] : []), targetGitignoreRule],
    options,
  };
  const gitignoreCandidateIsCurrent = async (): Promise<boolean> =>
    gitignoreCandidateHash != null &&
    (await fileMatchesHash(gitignoreSnapshot.path, MAX_GITIGNORE_BYTES, gitignoreCandidateHash));
  try {
    if (gitignoreCandidate) {
      stagedFiles.push(
        await stageFile(gitignoreSnapshot, gitignoreCandidate, {
          cleanupFailures: options.forceGitignoreCommitCleanupFailure === true ? 1 : 0,
        }),
      );
    }

    if (
      !(await snapshotMatches(localSecretsSnapshot)) ||
      !(await snapshotMatches(gitignoreSnapshot))
    ) {
      return {
        status: "stale",
        plan,
        message: "LocalSecrets.plist or .gitignore changed while the update was being prepared.",
      };
    }

    const gitignoreStaged = stagedFiles.find(
      (staged) => staged.targetPath === gitignoreSnapshot.path,
    );
    if (gitignoreStaged) {
      const result = await commitStagedFile(gitignoreStaged, options);
      if (result === "stale") {
        if (!(await rollbackFiles(stagedFiles, rollbackDependency))) {
          throw new Error(
            "The runtime-key update became stale and automatic rollback was incomplete. Git-ignore protection was retained when possible; inspect LocalSecrets.plist and .gitignore before retrying.",
          );
        }
        return {
          status: "stale",
          plan,
          message: "A target file changed while the runtime-key update was being committed.",
        };
      }
    }

    if (needsPlistWrite && !(await gitignoreCandidateIsCurrent())) {
      if (!(await rollbackFiles(stagedFiles, rollbackDependency))) {
        throw new Error(
          "The runtime-key update became stale and automatic rollback was incomplete. Git-ignore protection was retained when possible; inspect LocalSecrets.plist and .gitignore before retrying.",
        );
      }
      return {
        status: "stale",
        plan,
        message: ".gitignore changed after the crash-safe guard was committed.",
      };
    }

    const localSecretsPath = resolve(plan.root, plan.localSecretsPath);
    if (!(await localSecretsIsIgnored(plan.root, localSecretsPath, plan.gitignoreRule))) {
      if (!(await rollbackFiles(stagedFiles, rollbackDependency))) {
        throw new Error(
          "The Git-ignore safety check failed and automatic rollback was incomplete. Git-ignore protection was retained when possible; inspect LocalSecrets.plist and .gitignore before retrying.",
        );
      }
      return {
        status: "rolled-back",
        plan,
        message: "The Git-ignore safety check failed and the original files were restored.",
      };
    }

    let plistStaged: StagedFile | undefined;
    if (plistCandidate && temporaryRule) {
      plistStaged = await stageFile(localSecretsSnapshot, plistCandidate, {
        cleanupFailures: options.forcePlistCleanupFailureBeforeCommit === true ? 2 : 0,
        forceFailureAfterCreate: options.forcePlistStageFailureAfterCreate === true,
        keyBearing: true,
        claimPathIsSafe: async (claimPath) =>
          (await gitignoreCandidateIsCurrent()) &&
          (await localSecretsClaimPathIsIgnored(plan.root, claimPath, temporaryRule)),
        rollbackClaimPathIsSafe: async (claimPath) =>
          localSecretsClaimPathIsIgnored(plan.root, claimPath, temporaryRule),
        beforeWrite: async (temporaryPath) => {
          if (!(await gitignoreCandidateIsCurrent())) return false;
          if (!(await localSecretsIsIgnored(plan.root, temporaryPath, temporaryRule))) return false;
          await options.beforePlistWrite?.(temporaryPath);
          return (
            (await gitignoreCandidateIsCurrent()) &&
            (await localSecretsIsIgnored(plan.root, temporaryPath, temporaryRule)) &&
            (await localSecretsIsIgnored(plan.root, localSecretsPath, targetGitignoreRule))
          );
        },
      });
      stagedFiles.push(plistStaged);
      await options.afterPlistStage?.();
      if (
        !(await gitignoreCandidateIsCurrent()) ||
        !(await snapshotMatches(localSecretsSnapshot)) ||
        !(await localSecretsIsIgnored(plan.root, plistStaged.temporaryPath, temporaryRule)) ||
        !(await localSecretsIsIgnored(plan.root, localSecretsPath, plan.gitignoreRule))
      ) {
        if (!(await rollbackFiles(stagedFiles, rollbackDependency))) {
          throw new Error(
            "The runtime-key update became stale and automatic rollback was incomplete. Git-ignore protection was retained when possible; inspect LocalSecrets.plist and .gitignore before retrying.",
          );
        }
        return {
          status: "stale",
          plan,
          message: "A target file changed while the runtime-key update was being staged.",
        };
      }
      if (!(await gitignoreCandidateIsCurrent())) {
        if (!(await rollbackFiles(stagedFiles, rollbackDependency))) {
          throw new Error(
            "The runtime-key update became stale and automatic rollback was incomplete. Git-ignore protection was retained when possible; inspect LocalSecrets.plist and .gitignore before retrying.",
          );
        }
        return {
          status: "stale",
          plan,
          message: ".gitignore changed before LocalSecrets.plist was committed.",
        };
      }
      if ((await commitStagedFile(plistStaged, options)) === "stale") {
        if (!(await rollbackFiles(stagedFiles, rollbackDependency))) {
          throw new Error(
            "The runtime-key update became stale and automatic rollback was incomplete. Git-ignore protection was retained when possible; inspect LocalSecrets.plist and .gitignore before retrying.",
          );
        }
        return {
          status: "stale",
          plan,
          message: "A target file changed while the runtime-key update was being committed.",
        };
      }
      await options.afterPlistCommit?.();
      if (!(await gitignoreCandidateIsCurrent())) {
        if (!(await rollbackFiles(stagedFiles, rollbackDependency))) {
          throw new Error(
            "The runtime-key update became stale and automatic rollback was incomplete. Git-ignore protection was retained when possible; inspect LocalSecrets.plist and .gitignore before retrying.",
          );
        }
        return {
          status: "stale",
          plan,
          message: ".gitignore changed after LocalSecrets.plist was committed.",
        };
      }
    }

    await options.beforePostWriteValidation?.();
    const valid =
      options.forcePostWriteValidationFailure !== true &&
      (!needsPlistWrite || (await gitignoreCandidateIsCurrent())) &&
      (await postWriteIsValid(plan, normalizedKey)) &&
      (!needsPlistWrite || (await gitignoreCandidateIsCurrent()));
    if (valid) {
      const originalsReleased = await releaseClaimedOriginals(stagedFiles);
      if (!originalsReleased) {
        if (!(await rollbackFiles(stagedFiles, rollbackDependency))) {
          throw new Error(
            "The runtime-key update became stale and automatic rollback was incomplete. Git-ignore protection was retained when possible; inspect LocalSecrets.plist and .gitignore before retrying.",
          );
        }
        return {
          status: "stale",
          plan,
          message: "A target file changed before the runtime-key update was finalized.",
        };
      }
      return { status: "applied", plan };
    }

    if (!(await rollbackFiles(stagedFiles, rollbackDependency))) {
      throw new Error(
        "The runtime-key update failed validation and automatic rollback was incomplete. Git-ignore protection was retained when possible; inspect LocalSecrets.plist and .gitignore before retrying.",
      );
    }
    return {
      status: "rolled-back",
      plan,
      message: "The runtime-key update failed validation and the original files were restored.",
    };
  } catch (error) {
    if (
      !(await rollbackFiles(
        stagedFiles,
        rollbackDependency,
        error instanceof RuntimeKeyTemporaryFileCleanupError && error.keyBearing,
      ))
    ) {
      throw new Error(
        "The runtime-key update failed and automatic rollback was incomplete. Git-ignore protection was retained when possible; inspect LocalSecrets.plist and .gitignore before retrying.",
      );
    }
    if (error instanceof RuntimeKeyTemporaryFileCleanupError) throw error;
    return {
      status: "rolled-back",
      plan,
      message: "The runtime-key update failed and the original files were restored.",
    };
  } finally {
    await Promise.all(stagedFiles.map(cleanupStagedFile));
  }
}

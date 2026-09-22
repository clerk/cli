import { readdir } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { addBuildSettingConflictDiagnostics } from "./build-settings.ts";
import { inspectXCProjTargetBuildConfigurations } from "./xcproj-build-settings.ts";
import { attachEntitlements } from "./entitlements-inspection.ts";
import { localClerkIOSPackageIsStructurallyValid } from "./local-package.ts";
import type { IOSTargetSourceMembership, ParsedIOSProject } from "./project-adapter.ts";
import { pathIsSafelyWithinIOSRoot, relativeIOSPath } from "./discovery.ts";
import { isClerkIOSRepository, sanitizeRepositoryURL } from "./pbx.ts";
import { inspectSwiftSources } from "./swift.ts";
import type {
  IOSAppTarget,
  IOSClerkPackageState,
  IOSDiagnostic,
  IOSNativePlatform,
  IOSPackageReference,
  IOSProductLinkState,
  IOSSwiftInspection,
} from "./types.ts";
import {
  XCProjError,
  type XCProjRecord,
  type XCProjTarget,
  xcprojArray,
  xcprojPackages,
  xcprojRecord,
  xcprojString,
  xcprojStringArray,
  xcprojTargets,
} from "./xcproj.ts";

const APP_PRODUCT_TYPES = new Set(["application", "com.apple.product-type.application"]);
const MAX_SOURCE_FILES = 2_500;
const MAX_SOURCE_DEPTH = 24;
const SOURCE_IGNORES = new Set([
  ".build",
  ".git",
  ".swiftpm",
  "build",
  "Carthage",
  "DerivedData",
  "Pods",
  "SourcePackages",
]);

function emptySwiftInspection(): IOSSwiftInspection {
  return {
    sourceFilesScanned: 0,
    evidenceComplete: false,
    entryPoints: [],
    importsClerkKit: [],
    importsClerkKitUI: [],
    configureCalls: [],
    appRootEvidence: [],
    environmentInjections: [],
    rootEnvironmentInjections: [],
    environmentConsumers: [],
    authViewReferences: [],
    authFlowReferences: [],
    appleAuthReferences: [],
    openURLHandlers: [],
    status: "absent",
  };
}

function describeUnmodeledApplePlatforms(platforms: string[]): string {
  const hasVisionOS = platforms.some((platform) =>
    /^(?:visionos|xros|xrsimulator)$/i.test(platform),
  );
  const hasMacCatalyst = platforms.some((platform) => /^maccatalyst$/i.test(platform));
  const remaining = platforms.filter(
    (platform) =>
      !/^(?:visionos|xros|xrsimulator)$/i.test(platform) && !/^maccatalyst$/i.test(platform),
  );
  return [
    ...(hasVisionOS ? ["visionOS"] : []),
    ...(hasMacCatalyst ? ["Mac Catalyst"] : []),
    ...remaining,
  ].join(", ");
}

function packageName(repositoryOrPath: string): string {
  return basename(repositoryOrPath.replace(/\/$/, "")).replace(/\.git$/i, "");
}

async function inspectPackages(
  root: string,
  projectPath: string,
  document: XCProjRecord,
): Promise<IOSPackageReference[]> {
  const result: IOSPackageReference[] = [];
  for (const item of xcprojPackages(document)) {
    if (item.kind === "remote") {
      const repository = sanitizeRepositoryURL(item.repository);
      result.push({
        kind: "remote",
        objectId: packageName(repository),
        repository,
        requirement: item.version
          ? Object.fromEntries(
              Object.entries(item.version).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : undefined,
        isClerk: isClerkIOSRepository(repository),
      });
      continue;
    }
    const absolutePath = resolve(dirname(projectPath), item.path);
    const safelyLocal = await pathIsSafelyWithinIOSRoot(root, absolutePath);
    result.push({
      kind: "local",
      objectId: packageName(item.path),
      path: safelyLocal ? relativeIOSPath(root, absolutePath) : absolutePath,
      isClerk: safelyLocal && (await localClerkIOSPackageIsStructurallyValid(root, absolutePath)),
    });
  }
  return result;
}

function platformFiltersApply(
  raw: unknown,
  platform: IOSNativePlatform,
): { applies: boolean; complete: boolean } {
  if (raw === undefined) return { applies: true, complete: true };
  if (!Array.isArray(raw) || !raw.every((value): value is string => typeof value === "string")) {
    return { applies: false, complete: false };
  }
  if (raw.length === 0) return { applies: true, complete: true };
  const recognized = raw.every((value) =>
    /^(?:ios|iphone(?:os|simulator)?|macos|maccatalyst|visionos|xros|xrsimulator|tvos|watchos)$/i.test(
      value,
    ),
  );
  if (!recognized) return { applies: false, complete: false };
  return {
    complete: true,
    applies:
      platform === "ios"
        ? raw.some((value) => /^(?:ios|iphone(?:os|simulator)?)$/i.test(value))
        : raw.some((value) => /^macos$/i.test(value)),
  };
}

function inspectTargetPackages(
  root: string,
  projectPath: string,
  target: XCProjTarget,
  packages: IOSPackageReference[],
  diagnostics: IOSDiagnostic[],
  platform: IOSNativePlatform,
): IOSClerkPackageState {
  const memberState = (
    productName: "ClerkKit" | "ClerkKitUI",
  ): { state: IOSProductLinkState; packageNames: string[] } => {
    const matching = target.packageProductMembers.filter(
      (member) => member["product-name"] === productName,
    );
    if (matching.length === 0) return { state: "absent", packageNames: [] };
    let linked = false;
    let evidenceComplete = true;
    for (const member of matching) {
      const phase = xcprojRecord(member["build-phase"]);
      const applicability = platformFiltersApply(phase.platforms, platform);
      evidenceComplete &&= applicability.complete;
      linked ||= phase["build-phase"] === "frameworks" && applicability.applies;
    }
    if (!evidenceComplete) {
      diagnostics.push({
        code: "clerk.package-unattributed",
        severity: "warning",
        message: `${target.name} contains an unrecognized platform filter on ${productName}.`,
        evidence: [{ path: relativeIOSPath(root, resolve(projectPath, "project.xcproj")) }],
      });
    }
    return {
      state: linked ? "linked" : "declared",
      packageNames: matching.flatMap((member) =>
        typeof member.package === "string" ? [member.package] : [],
      ),
    };
  };

  const clerkKit = memberState("ClerkKit");
  const clerkKitUI = memberState("ClerkKitUI");
  const hasProduct = clerkKit.state !== "absent" || clerkKitUI.state !== "absent";
  const attributedNames = [...clerkKit.packageNames, ...clerkKitUI.packageNames];
  const uniqueNames = new Set(attributedNames.map((name) => name.toLowerCase()));
  const explicitPackage =
    attributedNames.length > 0 && uniqueNames.size === 1
      ? packages.find((item) => item.objectId.toLowerCase() === attributedNames[0]!.toLowerCase())
      : undefined;
  const declaredClerkPackage = packages.find((item) => item.isClerk);
  let packageKind: IOSClerkPackageState["package"] = "absent";
  if (explicitPackage?.isClerk) packageKind = explicitPackage.kind;
  else if (attributedNames.length === 0 && declaredClerkPackage)
    packageKind = declaredClerkPackage.kind;
  else if (hasProduct) {
    packageKind = "unattributed";
    diagnostics.push({
      code: "clerk.package-unattributed",
      severity: "warning",
      message: `${target.name} declares a Clerk product without an attributable clerk-ios package reference.`,
      evidence: [{ path: relativeIOSPath(root, resolve(projectPath, "project.xcproj")) }],
    });
  }
  return { package: packageKind, clerkKit: clerkKit.state, clerkKitUI: clerkKitUI.state };
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function sourceReferencePath(
  projectDirectory: string,
  parent: string,
  path: string,
): string | undefined {
  if (/^<(?:PRODUCTS|SDK|DEVELOPER)>\//.test(path)) return undefined;
  if (path.startsWith("<PROJECT>/")) {
    return resolve(projectDirectory, path.slice("<PROJECT>/".length));
  }
  if (path.startsWith("<")) return undefined;
  return resolve(parent, path);
}

async function collectSwiftFiles(
  root: string,
  directory: string,
  groupRoot: string,
  included: (relativePath: string) => boolean,
  files: Map<string, { absolutePath: string; relativePath: string }>,
  state: { complete: boolean },
  depth = 0,
): Promise<void> {
  if (depth > MAX_SOURCE_DEPTH || files.size >= MAX_SOURCE_FILES) {
    state.complete = false;
    return;
  }
  if (!(await pathIsSafelyWithinIOSRoot(root, directory))) {
    state.complete = false;
    return;
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    state.complete = false;
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (files.size >= MAX_SOURCE_FILES) {
      state.complete = false;
      return;
    }
    const absolutePath = resolve(directory, entry.name);
    const pathFromGroup = normalizedPath(relative(groupRoot, absolutePath).split(sep).join("/"));
    if (!included(pathFromGroup)) continue;
    if (entry.isDirectory()) {
      if (!SOURCE_IGNORES.has(entry.name) && !entry.name.startsWith(".")) {
        await collectSwiftFiles(root, absolutePath, groupRoot, included, files, state, depth + 1);
      }
    } else if (entry.isFile() && extname(entry.name) === ".swift") {
      files.set(absolutePath, { absolutePath, relativePath: relativeIOSPath(root, absolutePath) });
    } else if (entry.isSymbolicLink() && extname(entry.name) === ".swift") {
      state.complete = false;
    }
  }
}

function folderMembership(
  reference: XCProjRecord,
  targetName: string,
  platform: IOSNativePlatform | undefined,
  state: { complete: boolean },
): { member: boolean; included: (path: string) => boolean } {
  let members: string[];
  try {
    members =
      reference["target-membership"] === undefined
        ? []
        : xcprojStringArray(reference["target-membership"]);
  } catch {
    state.complete = false;
    members = [];
  }
  const defaultMember = members.includes(targetName);
  const inclusions = new Set<string>();
  const exclusions = new Set<string>();
  const filters = new Map<string, unknown>();
  let exceptions: unknown[] = [];
  try {
    exceptions =
      reference["membership-exceptions"] === undefined
        ? []
        : xcprojArray(reference["membership-exceptions"]);
  } catch {
    state.complete = false;
  }
  for (const raw of exceptions) {
    let exception: XCProjRecord;
    try {
      exception = xcprojRecord(raw);
      if (exception.target !== targetName) continue;
      const hasInclusions = Object.hasOwn(exception, "inclusions");
      const hasExclusions = Object.hasOwn(exception, "exclusions");
      if (hasInclusions === hasExclusions) {
        state.complete = false;
        continue;
      }
      for (const path of xcprojStringArray(
        exception[hasInclusions ? "inclusions" : "exclusions"],
      )) {
        (hasInclusions ? inclusions : exclusions).add(normalizedPath(path));
      }
      if (exception.platforms !== undefined) {
        const byPath = xcprojRecord(exception.platforms);
        for (const [path, value] of Object.entries(byPath))
          filters.set(normalizedPath(path), value);
      }
    } catch {
      state.complete = false;
    }
  }
  const matchesPath = (set: Set<string>, path: string): boolean =>
    [...set].some((candidate) => path === candidate || path.startsWith(`${candidate}/`));
  const matchesPathOrIncludedDescendant = (set: Set<string>, path: string): boolean =>
    matchesPath(set, path) || [...set].some((candidate) => candidate.startsWith(`${path}/`));
  return {
    member: defaultMember || inclusions.size > 0,
    included(path) {
      const base = defaultMember
        ? !matchesPath(exclusions, path)
        : matchesPathOrIncludedDescendant(inclusions, path);
      if (!base || !platform) return base;
      for (const [candidate, raw] of filters) {
        if (path !== candidate && !path.startsWith(`${candidate}/`)) continue;
        const result = platformFiltersApply(raw, platform);
        state.complete &&= result.complete;
        return result.applies;
      }
      return true;
    },
  };
}

function fileBelongsToSources(
  reference: XCProjRecord,
  targetName: string,
  platform: IOSNativePlatform | undefined,
  state: { complete: boolean },
): boolean {
  let memberships: unknown[];
  try {
    memberships =
      reference["target-membership"] === undefined
        ? []
        : xcprojArray(reference["target-membership"]);
  } catch {
    state.complete = false;
    return false;
  }
  for (const raw of memberships) {
    let buildPhase: string | undefined;
    let filters: unknown;
    if (typeof raw === "string") buildPhase = raw;
    else {
      try {
        const member = xcprojRecord(raw);
        buildPhase = xcprojString(member["build-phase"]);
        filters = member.platforms;
      } catch {
        state.complete = false;
        continue;
      }
    }
    if (buildPhase !== `${targetName}/compile-sources`) continue;
    if (!platform) return true;
    const result = platformFiltersApply(filters, platform);
    state.complete &&= result.complete;
    if (result.applies) return true;
  }
  return false;
}

async function sourceFilesForTarget(options: {
  root: string;
  projectPath: string;
  document: XCProjRecord;
  targetName: string;
  platform?: IOSNativePlatform;
  diagnostics: IOSDiagnostic[];
}): Promise<{ files: Array<{ absolutePath: string; relativePath: string }>; complete: boolean }> {
  const { root, projectPath, document, targetName, platform, diagnostics } = options;
  const state = { complete: true };
  const files = new Map<string, { absolutePath: string; relativePath: string }>();
  const projectDirectory = dirname(projectPath);
  const visit = async (raw: unknown, parent: string): Promise<void> => {
    let reference: XCProjRecord;
    try {
      reference = xcprojRecord(raw);
    } catch {
      state.complete = false;
      return;
    }
    const kind = typeof reference.kind === "string" ? reference.kind : "file";
    const path = typeof reference.path === "string" ? reference.path : "";
    if (kind === "group") {
      const groupDirectory = path ? sourceReferencePath(projectDirectory, parent, path) : parent;
      if (!groupDirectory) return;
      let children: unknown[];
      try {
        children = reference.children === undefined ? [] : xcprojArray(reference.children);
      } catch {
        state.complete = false;
        return;
      }
      for (const child of children) await visit(child, groupDirectory);
      return;
    }
    if (kind === "folder") {
      if (!path) {
        state.complete = false;
        return;
      }
      const directory = sourceReferencePath(projectDirectory, parent, path);
      if (!directory) return;
      const membership = folderMembership(reference, targetName, platform, state);
      if (membership.member) {
        await collectSwiftFiles(root, directory, directory, membership.included, files, state);
      }
      return;
    }
    if (kind !== "file") {
      state.complete = false;
      return;
    }
    if (!path || extname(path) !== ".swift") return;
    if (!fileBelongsToSources(reference, targetName, platform, state)) return;
    const absolutePath = sourceReferencePath(projectDirectory, parent, path);
    if (!absolutePath || !(await pathIsSafelyWithinIOSRoot(root, absolutePath))) {
      state.complete = false;
      return;
    }
    files.set(absolutePath, { absolutePath, relativePath: relativeIOSPath(root, absolutePath) });
  };
  try {
    for (const reference of xcprojArray(document.files)) await visit(reference, projectDirectory);
  } catch {
    state.complete = false;
  }
  if (files.size === 0 || !state.complete) {
    diagnostics.push({
      code: "xcode.incomplete-source-membership",
      severity: "info",
      message:
        files.size === 0
          ? `No Swift source membership could be resolved for ${targetName}; source-level Clerk checks may be incomplete.`
          : `Swift source membership for ${targetName} was only partially inspected; absence checks are advisory.`,
      evidence: [{ path: relativeIOSPath(root, resolve(projectPath, "project.xcproj")) }],
    });
  }
  return {
    files: [...files.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    complete: state.complete,
  };
}

/** Converts a validated JSON-format Xcode document into the shared semantic inspection model. */
export async function inspectXCProjProject(options: {
  root: string;
  projectPath: string;
  documentPath: string;
  document: XCProjRecord;
  requestedTarget?: string;
  requestedPlatform?: IOSNativePlatform;
}): Promise<ParsedIOSProject> {
  const { root, projectPath, documentPath, document, requestedTarget, requestedPlatform } = options;
  const projectRelativePath = relativeIOSPath(root, projectPath);
  const documentRelativePath = relativeIOSPath(root, documentPath);
  const diagnostics: IOSDiagnostic[] = [];
  const packages = await inspectPackages(root, projectPath, document);
  const targets = xcprojTargets(document);
  const appTargets: IOSAppTarget[] = [];
  const appTargetCandidates: ParsedIOSProject["appTargetCandidates"] = [];
  const sourceMemberships: IOSTargetSourceMembership[] = [];

  for (const target of targets) {
    const ownership = await sourceFilesForTarget({
      root,
      projectPath,
      document,
      targetName: target.name,
      diagnostics: [],
    });
    sourceMemberships.push({
      targetId: target.id,
      targetName: target.name,
      projectPath: projectRelativePath,
      files: ownership.files,
      complete: ownership.complete,
    });
  }

  for (const target of targets) {
    if (
      target.kind !== "native" ||
      !target.productType ||
      !APP_PRODUCT_TYPES.has(target.productType)
    ) {
      continue;
    }
    const configurationDiagnostics: IOSDiagnostic[] = [];
    const inspectedConfigurations = await inspectXCProjTargetBuildConfigurations({
      root,
      projectPath,
      projectDocumentPath: documentPath,
      project: document,
      target,
      diagnostics: configurationDiagnostics,
      platform: requestedPlatform,
    });
    const concretePlatforms = new Set(
      inspectedConfigurations.flatMap((configuration) =>
        configuration.platformEvidenceComplete && configuration.platform
          ? [configuration.platform]
          : [],
      ),
    );
    const hasUncertainConfiguration = inspectedConfigurations.some(
      (configuration) => !configuration.platformEvidenceComplete,
    );
    const hasResolvedUnsupportedConfiguration = inspectedConfigurations.some(
      (configuration) => configuration.platformEvidenceComplete && !configuration.platform,
    );
    const inferredPlatforms = new Set(
      inspectedConfigurations.flatMap((configuration) =>
        configuration.platform ? [configuration.platform] : [],
      ),
    );
    const targetPlatform: IOSNativePlatform | undefined = requestedPlatform
      ? requestedPlatform
      : concretePlatforms.has("ios")
        ? "ios"
        : concretePlatforms.has("macos")
          ? "macos"
          : hasUncertainConfiguration || inspectedConfigurations.length === 0
            ? inferredPlatforms.has("macos")
              ? "macos"
              : "ios"
            : undefined;
    if (!targetPlatform) continue;
    const platformEvidenceComplete =
      inspectedConfigurations.length > 0 &&
      !hasUncertainConfiguration &&
      !hasResolvedUnsupportedConfiguration &&
      concretePlatforms.size === 1;
    if (!platformEvidenceComplete) {
      const unmodeledPlatforms = [
        ...new Set(
          inspectedConfigurations.flatMap((configuration) => configuration.unmodeledPlatforms),
        ),
      ].sort();
      configurationDiagnostics.push({
        code: "xcode.unresolved-target-platform",
        severity: "error",
        message:
          unmodeledPlatforms.length > 0
            ? `${target.name} also ships ${describeUnmodeledApplePlatforms(unmodeledPlatforms)}, which Clerk CLI can inspect but does not automate.`
            : `${target.name} does not have one proven native platform across every build configuration.`,
        remedy:
          unmodeledPlatforms.length > 0
            ? "Automatic setup currently supports only non-Catalyst iOS and native macOS destinations."
            : "Resolve SDKROOT, SUPPORTED_PLATFORMS, and SUPPORTS_MACCATALYST consistently before running Clerk setup.",
        evidence: [{ path: documentRelativePath, objectId: target.id, keyPath: "build-settings" }],
      });
    }
    appTargetCandidates.push({
      targetId: target.id,
      targetName: target.name,
      projectPath: projectRelativePath,
      platform: targetPlatform,
    });
    if (requestedTarget && requestedTarget !== target.id && requestedTarget !== target.name)
      continue;
    diagnostics.push(...configurationDiagnostics);
    const configurations = inspectedConfigurations.map((configuration) => configuration.model);
    const supportedPlatforms = (["ios", "macos"] as const).filter((platform) =>
      inspectedConfigurations.some((configuration) =>
        configuration.supportedPlatforms.includes(platform),
      ),
    );
    await attachEntitlements(
      root,
      projectPath,
      targetPlatform,
      configurations,
      new Map(
        inspectedConfigurations.map((configuration) => [
          configuration.model.name,
          configuration.entitlementContexts,
        ]),
      ),
      diagnostics,
    );
    addBuildSettingConflictDiagnostics(target.name, configurations, diagnostics);
    const ownership = sourceMemberships.find(
      (membership) =>
        membership.targetId === target.id && membership.projectPath === projectRelativePath,
    );
    const targetSourceDiagnostics: IOSDiagnostic[] = [];
    const sources = await sourceFilesForTarget({
      root,
      projectPath,
      document,
      targetName: target.name,
      platform: targetPlatform,
      diagnostics: targetSourceDiagnostics,
    });
    sources.complete &&= ownership?.complete ?? false;
    diagnostics.push(...targetSourceDiagnostics);
    const swift =
      sources.files.length > 0
        ? await inspectSwiftSources(sources.files, {
            membershipComplete: sources.complete,
            platform: targetPlatform,
          })
        : emptySwiftInspection();
    appTargets.push({
      id: target.id,
      name: target.name,
      platform: targetPlatform,
      supportedPlatforms,
      platformEvidenceComplete,
      projectPath: projectRelativePath,
      configurations,
      packages: inspectTargetPackages(
        root,
        projectPath,
        target,
        packages,
        diagnostics,
        targetPlatform,
      ),
      swift,
    });
  }

  appTargets.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  appTargetCandidates.sort(
    (left, right) =>
      left.targetName.localeCompare(right.targetName) ||
      left.targetId.localeCompare(right.targetId),
  );
  return {
    inspection: {
      path: projectRelativePath,
      projectFilePath: documentRelativePath,
      projectFormat: "xcproj",
      packages,
      appTargetIds: appTargetCandidates.map((target) => target.targetId),
      diagnostics,
    },
    appTargets,
    appTargetCandidates,
    diagnostics,
    sourceMemberships,
  };
}

export function isXCProjInspectionError(error: unknown): error is XCProjError {
  return error instanceof XCProjError;
}

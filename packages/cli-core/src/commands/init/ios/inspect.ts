import { readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { parse as parsePbxProject } from "@bacons/xcode/json";
import { bundleIdentifiersEqual } from "../../../lib/apple-native-identity.ts";
import {
  addBuildSettingConflictDiagnostics,
  inspectTargetBuildConfigurations,
  resolveEntitlementsAbsolutePath,
  type EntitlementBuildContext,
} from "./build-settings.ts";
import { readBoundedRegularFile } from "./bounded-file.ts";
import {
  discoverIOSContainers,
  discoverReferencedIOSProjects,
  inspectWorkspace,
  pathIsSafelyWithinIOSRoot,
  relativeIOSPath,
} from "./discovery.ts";
import { hasInterruptedIOSFileTransaction } from "./file-transaction.ts";
import { localClerkIOSPackageIsStructurallyValid } from "./local-package.ts";
import {
  asString,
  asStringArray,
  asStringRecord,
  buildPbxParentIndex,
  isClerkIOSRepository,
  isRecord,
  resolvePbxFilePath,
  sanitizeRepositoryURL,
  type PbxObject,
  type PbxObjects,
  type PbxParentIndex,
} from "./pbx.ts";
import { parseIOSPlist } from "./plist.ts";
import { inspectSwiftSources } from "./swift.ts";
import type {
  IOSAppTarget,
  IOSBuildConfiguration,
  IOSClerkPackageState,
  IOSDiagnostic,
  IOSEntitlementsInspection,
  IOSPackageReference,
  IOSProductLinkState,
  IOSProjectInspection,
  IOSProjectInspectionResult,
  IOSSourceEvidence,
  IOSTargetSelection,
} from "./types.ts";

const APP_PRODUCT_TYPE = "com.apple.product-type.application";
const APPLE_SIGN_IN_KEY = "com.apple.developer.applesignin";
const MAX_ENTITLEMENTS_BYTES = 2_000_000;
const MAX_PBXPROJ_BYTES = 15_000_000;
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

interface ParsedProject {
  inspection: IOSProjectInspection;
  appTargets: IOSAppTarget[];
  appTargetCandidates: Array<{ targetId: string; targetName: string; projectPath: string }>;
  diagnostics: IOSDiagnostic[];
  sourceMemberships?: IOSTargetSourceMembership[];
}

export interface IOSTargetSourceMembership {
  targetId: string;
  targetName: string;
  projectPath: string;
  files: Array<{ absolutePath: string; relativePath: string }>;
  complete: boolean;
}

const sourceMembershipByInspection = new WeakMap<
  IOSProjectInspectionResult,
  IOSTargetSourceMembership[]
>();

function emptySwiftInspection() {
  return {
    sourceFilesScanned: 0,
    evidenceComplete: false,
    entryPoints: [],
    importsClerkKit: [],
    importsClerkKitUI: [],
    configureCalls: [],
    environmentInjections: [],
    environmentConsumers: [],
    authFlowReferences: [],
    openURLHandlers: [],
    status: "absent" as const,
  };
}

function normalizeObjects(value: unknown): PbxObjects | undefined {
  if (!isRecord(value)) return undefined;
  const objects: PbxObjects = {};
  for (const [id, object] of Object.entries(value)) {
    if (isRecord(object)) objects[id] = object;
  }
  return objects;
}

function canonicalRequirement(value: unknown): Record<string, string> | undefined {
  const requirement = asStringRecord(value);
  return Object.keys(requirement).length > 0 ? requirement : undefined;
}

function buildFileIOSApplicability(object: PbxObject): {
  applies: boolean;
  recognized: boolean;
} {
  const rawFilters = object.platformFilters;
  if (
    rawFilters != null &&
    (!Array.isArray(rawFilters) || rawFilters.some((item) => typeof item !== "string"))
  ) {
    return { applies: false, recognized: false };
  }
  const rawFilter = object.platformFilter;
  const platformFilter = asString(rawFilter);
  if (Object.hasOwn(object, "platformFilter") && platformFilter == null) {
    return { applies: false, recognized: false };
  }
  const filters = [...asStringArray(rawFilters), ...(platformFilter ? [platformFilter] : [])];
  if (filters.length === 0) return { applies: true, recognized: true };
  if (filters.some((filter) => /(?:^|[^a-z])(?:ios|iphone)/i.test(filter))) {
    return { applies: true, recognized: true };
  }
  const recognized = filters.every((filter) =>
    /(?:maccatalyst|macos|tvos|watchos|xros|visionos|driverkit)/i.test(filter),
  );
  return { applies: false, recognized };
}

function inspectInlinePublishableKey(
  target: IOSAppTarget | undefined,
  diagnostics: IOSDiagnostic[],
): IOSProjectInspectionResult["localPublishableKey"] {
  if (!target?.swift.evidenceComplete) {
    return { state: "unproven" };
  }

  const calls = target.swift.configureCalls;
  if (calls.length === 0) return { state: "missing" };

  const inlineCalls = calls.filter((call) => call.publishableKeyWiring === "inline-literal");

  // Only the documented, single startup literal proves which Clerk instance
  // the selected target runs against. Every other expression is custom and is
  // intentionally preserved without inspecting its source or value.
  if (
    calls.length !== 1 ||
    inlineCalls.length !== 1 ||
    inlineCalls[0]?.startupBinding !== "app-init"
  ) {
    return { state: "unproven" };
  }

  const call = inlineCalls[0];
  if (!call || call.inlinePublishableKey?.state !== "valid") {
    const source = call?.path;
    if (source) {
      diagnostics.push({
        code: "clerk.invalid-publishable-key",
        severity: "warning",
        message: `The inline publishable key in ${source} has an invalid format.`,
        remedy: "Replace it with a valid pk_test_ or pk_live_ publishable key.",
        evidence: [{ path: source, keyPath: "Clerk.configure(publishableKey:)" }],
      });
    }
    return source ? { state: "invalid", source } : { state: "unproven" };
  }

  return {
    state: "valid",
    source: call.path,
    frontendApiHost: call.inlinePublishableKey.frontendApiHost,
    instanceType: call.inlinePublishableKey.instanceType,
  };
}

async function inspectPackageReferences(
  root: string,
  projectPath: string,
  projectObject: PbxObject,
  objects: PbxObjects,
): Promise<IOSPackageReference[]> {
  const packageIds = new Set(asStringArray(projectObject.packageReferences));
  // Some modern/local project layouts leave the project-level list partial.
  // Preserve any package object the target graph can still reference.
  for (const [id, object] of Object.entries(objects)) {
    if (
      object.isa === "XCRemoteSwiftPackageReference" ||
      object.isa === "XCLocalSwiftPackageReference"
    ) {
      packageIds.add(id);
    }
  }

  const packages: IOSPackageReference[] = [];
  for (const objectId of [...packageIds].sort()) {
    const object = objects[objectId];
    if (object?.isa === "XCRemoteSwiftPackageReference") {
      const rawRepository = asString(object.repositoryURL);
      if (!rawRepository) continue;
      const repository = sanitizeRepositoryURL(rawRepository);
      packages.push({
        kind: "remote",
        objectId,
        repository,
        requirement: canonicalRequirement(object.requirement),
        isClerk: isClerkIOSRepository(repository),
      });
    } else if (object?.isa === "XCLocalSwiftPackageReference") {
      const relativePath = asString(object.relativePath);
      if (!relativePath) continue;
      const absolutePath = resolve(dirname(projectPath), relativePath);
      const safelyLocal = await pathIsSafelyWithinIOSRoot(root, absolutePath);
      packages.push({
        kind: "local",
        objectId,
        path: safelyLocal ? relativeIOSPath(root, absolutePath) : absolutePath,
        isClerk: safelyLocal && (await localClerkIOSPackageIsStructurallyValid(root, absolutePath)),
      });
    }
  }
  return packages;
}

function targetProductState(
  targetObject: PbxObject,
  objects: PbxObjects,
  productName: "ClerkKit" | "ClerkKitUI",
): { state: IOSProductLinkState; productIds: string[]; packageIds: string[] } {
  const targetProductIds = asStringArray(targetObject.packageProductDependencies);
  const matchingProductIds = targetProductIds.filter((id) => {
    const product = objects[id];
    return (
      product?.isa === "XCSwiftPackageProductDependency" && product.productName === productName
    );
  });
  if (matchingProductIds.length === 0) {
    return { state: "absent", productIds: [], packageIds: [] };
  }

  const linkedProductIds = new Set<string>();
  for (const phaseId of asStringArray(targetObject.buildPhases)) {
    const phase = objects[phaseId];
    if (phase?.isa !== "PBXFrameworksBuildPhase") continue;
    for (const buildFileId of asStringArray(phase.files)) {
      const buildFile = objects[buildFileId];
      if (!buildFile || !buildFileIOSApplicability(buildFile).applies) continue;
      const productRef = asString(buildFile.productRef);
      if (productRef) linkedProductIds.add(productRef);
    }
  }

  const packageIds = matchingProductIds
    .map((id) => asString(objects[id]?.package))
    .filter((id): id is string => id != null);
  return {
    state: matchingProductIds.some((id) => linkedProductIds.has(id)) ? "linked" : "declared",
    productIds: matchingProductIds,
    packageIds,
  };
}

function inspectTargetPackages(
  root: string,
  projectPath: string,
  targetName: string,
  targetObject: PbxObject,
  objects: PbxObjects,
  packages: IOSPackageReference[],
  diagnostics: IOSDiagnostic[],
): IOSClerkPackageState {
  const clerkKit = targetProductState(targetObject, objects, "ClerkKit");
  const clerkKitUI = targetProductState(targetObject, objects, "ClerkKitUI");
  const packageById = new Map(packages.map((item) => [item.objectId, item]));
  const productIds = [...clerkKit.productIds, ...clerkKitUI.productIds];
  const productPackageIds = [...clerkKit.packageIds, ...clerkKitUI.packageIds];
  const uniqueProductPackageIds = new Set(productPackageIds);
  // Explicit product attribution is authoritative only when the entire Clerk
  // product graph resolves to one verified package. Some workspace-local and
  // older Xcode graphs omit every package field, so retain that separate
  // declared-package fallback below.
  const explicitlyAttributedPackage =
    productPackageIds.length === productIds.length && uniqueProductPackageIds.size === 1
      ? packageById.get(productPackageIds[0]!)
      : undefined;
  const attributedClerkPackage = explicitlyAttributedPackage?.isClerk
    ? explicitlyAttributedPackage
    : undefined;
  const declaredClerkPackage = packages.find((item) => item.isClerk);
  const hasClerkProduct = clerkKit.state !== "absent" || clerkKitUI.state !== "absent";

  let packageKind: IOSClerkPackageState["package"] = "absent";
  if (attributedClerkPackage) packageKind = attributedClerkPackage.kind;
  else if (productPackageIds.length === 0 && declaredClerkPackage) {
    packageKind = declaredClerkPackage.kind;
  } else if (hasClerkProduct) {
    packageKind = "unattributed";
    diagnostics.push({
      code: "clerk.package-unattributed",
      severity: "warning",
      message: `${targetName} declares a Clerk product without an attributable clerk-ios package reference. This can be valid for a workspace-local package, but should be reviewed.`,
      evidence: [...clerkKit.productIds, ...clerkKitUI.productIds].map((objectId) => ({
        path: relativeIOSPath(root, resolve(projectPath, "project.pbxproj")),
        objectId,
      })),
    });
  }

  return { package: packageKind, clerkKit: clerkKit.state, clerkKitUI: clerkKitUI.state };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function appleEntitlementState(
  parsed: Record<string, unknown>,
): IOSEntitlementsInspection["signInWithAppleState"] {
  if (!Object.hasOwn(parsed, APPLE_SIGN_IN_KEY)) return "absent";
  const value = parsed[APPLE_SIGN_IN_KEY];
  return Array.isArray(value) && value.length === 1 && value[0] === "Default" ? "exact" : "invalid";
}

async function inspectEntitlements(
  root: string,
  absolutePath: string,
  evidence: IOSSourceEvidence[],
  diagnostics: IOSDiagnostic[],
): Promise<IOSEntitlementsInspection | undefined> {
  const relativePath = relativeIOSPath(root, absolutePath);
  const file = await readBoundedRegularFile(absolutePath, MAX_ENTITLEMENTS_BYTES);
  if (file.status === "missing") {
    diagnostics.push({
      code: "xcode.missing-entitlements",
      severity: "warning",
      message: `The configured entitlements file does not exist: ${relativePath}`,
      remedy: "Create the file in Xcode or update CODE_SIGN_ENTITLEMENTS.",
      evidence,
    });
    return undefined;
  }

  try {
    if (file.status !== "ok") throw new Error("unreadable entitlements");
    const bytes = file.bytes;
    if (new TextDecoder().decode(bytes.slice(0, 8)).startsWith("bplist")) {
      throw new Error("binary plist");
    }
    const parsed = parseIOSPlist(new TextDecoder().decode(bytes));
    if (!isRecord(parsed)) throw new Error("plist root is not a dictionary");

    const associatedDomainsKey = "com.apple.developer.associated-domains";
    const rawAssociatedDomains = parsed[associatedDomainsKey];
    if (
      Object.hasOwn(parsed, associatedDomainsKey) &&
      (!Array.isArray(rawAssociatedDomains) ||
        !rawAssociatedDomains.every((value): value is string => typeof value === "string"))
    ) {
      diagnostics.push({
        code: "xcode.invalid-associated-domains",
        severity: "warning",
        message: `${relativePath} has an invalid Associated Domains entitlement value.`,
        remedy: `Set ${associatedDomainsKey} to an array containing only strings, then rerun the inspector.`,
        evidence: [{ path: relativePath, keyPath: associatedDomainsKey }],
      });
    }
    const associatedDomains =
      Array.isArray(rawAssociatedDomains) &&
      rawAssociatedDomains.every((value): value is string => typeof value === "string")
        ? rawAssociatedDomains
        : [];
    const applicationIdentifier = asString(parsed["application-identifier"]);
    const signInWithAppleState = appleEntitlementState(parsed);
    if (signInWithAppleState === "invalid") {
      diagnostics.push({
        code: "xcode.invalid-apple-entitlement",
        severity: "warning",
        message: `${relativePath} has an invalid Sign in with Apple entitlement value.`,
        remedy: `Set ${APPLE_SIGN_IN_KEY} to an array containing only Default, then rerun the inspector.`,
        evidence: [{ path: relativePath, keyPath: APPLE_SIGN_IN_KEY }],
      });
    }
    return {
      path: relativePath,
      associatedDomains: associatedDomains.sort((left, right) => left.localeCompare(right)),
      unresolvedAssociatedDomains: [],
      applicationIdentifier,
      teamIdentifier: asString(parsed["com.apple.developer.team-identifier"]),
      signInWithAppleState,
      signInWithApple: signInWithAppleState === "exact",
    };
  } catch {
    diagnostics.push({
      code: "xcode.unreadable-entitlements",
      severity: "warning",
      message: `Could not inspect entitlements at ${relativePath}. Only XML plist entitlements are read in portable mode.`,
      remedy: "Open the file in Xcode and save it as XML, then rerun the inspector.",
      evidence,
    });
    return undefined;
  }
}

async function attachEntitlements(
  root: string,
  projectPath: string,
  configurations: IOSBuildConfiguration[],
  contextsByConfiguration: Map<string, EntitlementBuildContext[]>,
  diagnostics: IOSDiagnostic[],
): Promise<void> {
  const cache = new Map<string, IOSEntitlementsInspection | undefined>();
  for (const configuration of configurations) {
    if (configuration.entitlementsPath.state !== "resolved") continue;
    const absolutePath = resolveEntitlementsAbsolutePath(
      root,
      projectPath,
      configuration.entitlementsPath,
    );
    if (!absolutePath) {
      diagnostics.push({
        code: "xcode.external-path",
        severity: "warning",
        message: `${configuration.name} resolves CODE_SIGN_ENTITLEMENTS outside the inspected root.`,
        evidence: configuration.entitlementsPath.evidence,
      });
      continue;
    }
    if (!(await pathIsSafelyWithinIOSRoot(root, absolutePath))) {
      diagnostics.push({
        code: "xcode.external-path",
        severity: "warning",
        message: `${configuration.name} resolves CODE_SIGN_ENTITLEMENTS through a path outside the inspected root.`,
        evidence: configuration.entitlementsPath.evidence,
      });
      continue;
    }
    if (!cache.has(absolutePath)) {
      cache.set(
        absolutePath,
        await inspectEntitlements(
          root,
          absolutePath,
          configuration.entitlementsPath.evidence,
          diagnostics,
        ),
      );
    }
    const entitlements = cache.get(absolutePath);
    if (!entitlements) continue;

    const contexts = contextsByConfiguration.get(configuration.name) ?? [];
    const resolvedAssociatedDomains: string[] = [];
    const unresolvedAssociatedDomains: string[] = [];
    for (const domain of entitlements.associatedDomains) {
      const expansions = contexts.map((context) => expandEntitlementDomain(domain, context));
      const resolved = expansions.filter((value): value is string => value != null);
      if (
        contexts.length > 0 &&
        resolved.length === contexts.length &&
        new Set(resolved).size === 1
      ) {
        resolvedAssociatedDomains.push(resolved[0]!);
      } else {
        unresolvedAssociatedDomains.push(domain);
      }
    }
    if (unresolvedAssociatedDomains.length > 0) {
      diagnostics.push({
        code: "xcode.unresolved-build-setting",
        severity: "warning",
        message: `${configuration.name} has associated-domain values with unresolved build settings.`,
        remedy:
          "Resolve the variables in the entitlements configuration before relying on domain checks.",
        evidence: configuration.entitlementsPath.evidence,
      });
    }

    const applicationIdentifier = entitlements.applicationIdentifier;
    const prefixMatch = /^([A-Z0-9]{10})\.(.+)$/.exec(applicationIdentifier ?? "");
    const literalAppIdentifierPrefix =
      prefixMatch &&
      configuration.bundleIdentifier.state === "resolved" &&
      bundleIdentifiersEqual(prefixMatch[2], configuration.bundleIdentifier.value)
        ? prefixMatch[1]
        : undefined;
    configuration.entitlements = {
      ...entitlements,
      associatedDomains: resolvedAssociatedDomains.sort(),
      unresolvedAssociatedDomains: unresolvedAssociatedDomains.sort(),
      ...(literalAppIdentifierPrefix ? { literalAppIdentifierPrefix } : {}),
    };
  }
}

function expandEntitlementDomain(
  raw: string,
  context: EntitlementBuildContext,
): string | undefined {
  const variable = /\$\(([^)]+)\)|\$\{([^}]+)\}/g;
  const resolving = new Set<string>();
  const expand = (value: string, depth: number): string | undefined => {
    if (depth > 20) return undefined;
    let unresolved = false;
    variable.lastIndex = 0;
    const expanded = value.replace(variable, (_match, parenthesized, braced) => {
      const name = String(parenthesized ?? braced);
      if (name.includes(":")) {
        unresolved = true;
        return "";
      }
      const settingName =
        context.settings[name] == null && name === "CFBundleIdentifier"
          ? "PRODUCT_BUNDLE_IDENTIFIER"
          : name;
      if (resolving.has(settingName)) {
        unresolved = true;
        return "";
      }
      const taints = [
        ...(context.settingTaints.get(settingName) ?? []),
        ...(context.globalTaintOverrides.has(settingName) ? [] : context.globalTaints),
      ];
      if (taints.length > 0) {
        unresolved = true;
        return "";
      }
      const replacement = context.settings[settingName] ?? context.builtins[settingName];
      if (replacement == null) {
        unresolved = true;
        return "";
      }
      resolving.add(settingName);
      const nested = expand(replacement, depth + 1);
      resolving.delete(settingName);
      if (nested == null) unresolved = true;
      return nested ?? "";
    });
    variable.lastIndex = 0;
    return unresolved || variable.test(expanded) ? undefined : expanded;
  };

  const expanded = expand(raw, 0)?.trim();
  if (!expanded || /pk_(?:test|live)_/i.test(expanded)) return undefined;
  return expanded;
}

function normalizeSynchronizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function synchronizedStringCollection(
  object: PbxObject,
  property: "exceptions" | "membershipExceptions",
  state: { complete: boolean },
): string[] {
  if (!Object.hasOwn(object, property)) return [];

  const value = object[property];
  if (!Array.isArray(value)) {
    state.complete = false;
    return typeof value === "string" ? [value] : [];
  }

  const strings = value.filter((item): item is string => typeof item === "string");
  if (strings.length !== value.length) state.complete = false;
  return strings;
}

function synchronizedExclusions(
  group: PbxObject,
  targetId: string,
  relevantPhaseIds: Set<string>,
  objects: PbxObjects,
  state: { complete: boolean },
): Set<string> {
  const excluded = new Set<string>();
  for (const exceptionId of synchronizedStringCollection(group, "exceptions", state)) {
    const exception = objects[exceptionId];
    if (!exception) {
      state.complete = false;
      continue;
    }

    let appliesToTarget = false;
    let appliesToPhase = false;
    if (exception.isa === "PBXFileSystemSynchronizedBuildFileExceptionSet") {
      const exceptionTarget = exception.target;
      if (typeof exceptionTarget !== "string" || exceptionTarget.length === 0) {
        state.complete = false;
        continue;
      }
      appliesToTarget = exceptionTarget === targetId;
    } else if (exception.isa === "PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet") {
      const buildPhase = exception.buildPhase;
      if (typeof buildPhase !== "string" || buildPhase.length === 0) {
        state.complete = false;
        continue;
      }
      appliesToPhase = relevantPhaseIds.has(buildPhase);
    } else {
      state.complete = false;
      continue;
    }
    if (!appliesToTarget && !appliesToPhase) continue;

    for (const path of synchronizedStringCollection(exception, "membershipExceptions", state)) {
      excluded.add(normalizeSynchronizedPath(path));
    }
    if (Object.hasOwn(exception, "platformFiltersByRelativePath")) {
      const filtersByPath = exception.platformFiltersByRelativePath;
      if (!isRecord(filtersByPath)) {
        state.complete = false;
        continue;
      }
      for (const [path, filters] of Object.entries(filtersByPath)) {
        const platformFilters = stringArray(filters);
        if (!Array.isArray(filters) || platformFilters.length !== filters.length) {
          state.complete = false;
          continue;
        }
        if (
          platformFilters.length > 0 &&
          !platformFilters.some((filter) => /(?:^|[^a-z])(?:ios|iphone)/i.test(filter))
        ) {
          excluded.add(normalizeSynchronizedPath(path));
        }
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

async function collectSwiftFiles(
  root: string,
  directory: string,
  groupRoot: string,
  excluded: Set<string>,
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

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (files.size >= MAX_SOURCE_FILES) {
      state.complete = false;
      return;
    }
    const absolutePath = resolve(directory, entry.name);
    const pathFromGroup = relative(groupRoot, absolutePath).split(sep).join("/");
    if (synchronizedPathIsExcluded(pathFromGroup, excluded)) {
      continue;
    }
    if (entry.isDirectory()) {
      if (!SOURCE_IGNORES.has(entry.name) && !entry.name.startsWith(".")) {
        await collectSwiftFiles(root, absolutePath, groupRoot, excluded, files, state, depth + 1);
      }
    } else if (entry.isFile() && extname(entry.name) === ".swift") {
      files.set(absolutePath, { absolutePath, relativePath: relativeIOSPath(root, absolutePath) });
    } else if (entry.isSymbolicLink() && extname(entry.name) === ".swift") {
      state.complete = false;
    }
  }
}

async function sourceFilesForTarget(options: {
  root: string;
  projectPath: string;
  groupRootDirectory: string;
  targetId: string;
  targetObject: PbxObject;
  objects: PbxObjects;
  parents: PbxParentIndex;
  diagnostics: IOSDiagnostic[];
}): Promise<{
  files: Array<{ absolutePath: string; relativePath: string }>;
  complete: boolean;
}> {
  const {
    root,
    projectPath,
    groupRootDirectory,
    targetId,
    targetObject,
    objects,
    parents,
    diagnostics,
  } = options;
  const projectDirectory = dirname(projectPath);
  const files = new Map<string, { absolutePath: string; relativePath: string }>();
  const state = { complete: true };
  const projectEvidencePath = relativeIOSPath(root, resolve(projectPath, "project.pbxproj"));
  const reportDangling = (objectId: string, message: string): void => {
    state.complete = false;
    diagnostics.push({
      code: "xcode.dangling-reference",
      severity: "warning",
      message,
      evidence: [{ path: projectEvidencePath, objectId }],
    });
  };
  const requiredStringCollection = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      const strings = value.filter((item): item is string => typeof item === "string");
      if (strings.length !== value.length) state.complete = false;
      return strings;
    }

    state.complete = false;
    return typeof value === "string" ? [value] : [];
  };
  const buildPhaseIds = requiredStringCollection(targetObject.buildPhases);
  for (const phaseId of buildPhaseIds) {
    if (!objects[phaseId]) {
      reportDangling(phaseId, `Target ${targetId} contains a dangling build phase reference.`);
    }
  }
  const sourcePhaseIds = new Set(
    buildPhaseIds.filter((phaseId) => objects[phaseId]?.isa === "PBXSourcesBuildPhase"),
  );

  for (const phaseId of sourcePhaseIds) {
    const phase = objects[phaseId];
    if (phase?.isa !== "PBXSourcesBuildPhase") continue;
    for (const buildFileId of requiredStringCollection(phase.files)) {
      const buildFile = objects[buildFileId];
      if (!buildFile) {
        reportDangling(
          buildFileId,
          `Sources phase ${phaseId} contains a dangling build-file reference.`,
        );
        continue;
      }
      const applicability = buildFileIOSApplicability(buildFile);
      if (!applicability.applies) {
        if (!applicability.recognized) state.complete = false;
        continue;
      }
      const fileReference = asString(buildFile.fileRef);
      if (!fileReference) {
        reportDangling(
          buildFileId,
          `Sources phase ${phaseId} contains a build file with no file reference.`,
        );
        continue;
      }
      if (!objects[fileReference]) {
        reportDangling(
          fileReference,
          `Sources phase ${phaseId} contains a dangling file reference.`,
        );
        continue;
      }
      const absolutePath = resolvePbxFilePath(
        fileReference,
        objects,
        parents,
        projectDirectory,
        groupRootDirectory,
      );
      if (!absolutePath) {
        if (extname(asString(objects[fileReference]?.path) ?? "") === ".swift") {
          state.complete = false;
        }
        continue;
      }
      if (extname(absolutePath) !== ".swift") continue;
      if (!(await pathIsSafelyWithinIOSRoot(root, absolutePath))) {
        state.complete = false;
        diagnostics.push({
          code: "xcode.external-path",
          severity: "warning",
          message: `Skipped Swift source outside the inspected root: ${absolutePath}`,
          evidence: [{ path: absolutePath, objectId: fileReference }],
        });
        continue;
      }
      files.set(absolutePath, { absolutePath, relativePath: relativeIOSPath(root, absolutePath) });
    }
  }

  const synchronizedGroupIds = Object.hasOwn(targetObject, "fileSystemSynchronizedGroups")
    ? requiredStringCollection(targetObject.fileSystemSynchronizedGroups)
    : [];
  for (const groupId of synchronizedGroupIds) {
    const group = objects[groupId];
    if (group?.isa !== "PBXFileSystemSynchronizedRootGroup") {
      reportDangling(
        groupId,
        `Target ${targetId} contains an invalid synchronized-group reference.`,
      );
      continue;
    }
    const groupPath = resolvePbxFilePath(
      groupId,
      objects,
      parents,
      projectDirectory,
      groupRootDirectory,
    );
    if (!groupPath) {
      state.complete = false;
      continue;
    }
    if (!(await pathIsSafelyWithinIOSRoot(root, groupPath))) {
      state.complete = false;
      diagnostics.push({
        code: "xcode.external-path",
        severity: "warning",
        message: `Skipped synchronized source group outside the inspected root: ${groupPath}`,
        evidence: [{ path: groupPath, objectId: groupId }],
      });
      continue;
    }

    const excluded = synchronizedExclusions(group, targetId, sourcePhaseIds, objects, state);
    await collectSwiftFiles(root, groupPath, groupPath, excluded, files, state);
  }

  if (files.size === 0 || !state.complete) {
    diagnostics.push({
      code: "xcode.incomplete-source-membership",
      severity: "info",
      message:
        files.size === 0
          ? `No Swift source membership could be resolved for ${asString(targetObject.name) ?? targetId}; source-level Clerk checks may be incomplete.`
          : `Swift source membership for ${asString(targetObject.name) ?? targetId} was only partially inspected; absence checks are advisory.`,
      evidence: [
        {
          path: relativeIOSPath(root, resolve(projectPath, "project.pbxproj")),
          objectId: targetId,
        },
      ],
    });
  }

  return {
    files: [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    complete: state.complete,
  };
}

async function parseProject(
  root: string,
  projectPath: string,
  requestedTarget?: string,
): Promise<ParsedProject> {
  const projectRelativePath = relativeIOSPath(root, projectPath);
  const pbxprojPath = resolve(projectPath, "project.pbxproj");
  const pbxprojRelativePath = relativeIOSPath(root, pbxprojPath);
  const diagnostics: IOSDiagnostic[] = [];
  const emptyInspection = (objectVersion?: string): IOSProjectInspection => ({
    path: projectRelativePath,
    pbxprojPath: pbxprojRelativePath,
    objectVersion,
    packages: [],
    appTargetIds: [],
    diagnostics,
  });
  if (!(await pathIsSafelyWithinIOSRoot(root, pbxprojPath))) {
    diagnostics.push({
      code: "xcode.external-path",
      severity: "error",
      message: `${projectRelativePath} resolves project.pbxproj outside the inspected root.`,
      evidence: [{ path: pbxprojRelativePath }],
    });
    return { inspection: emptyInspection(), appTargets: [], appTargetCandidates: [], diagnostics };
  }
  const file = await readBoundedRegularFile(pbxprojPath, MAX_PBXPROJ_BYTES);
  if (file.status === "missing") {
    diagnostics.push({
      code: "xcode.missing-project-file",
      severity: "error",
      message: `${projectRelativePath} does not contain project.pbxproj.`,
      evidence: [{ path: pbxprojRelativePath }],
    });
    return { inspection: emptyInspection(), appTargets: [], appTargetCandidates: [], diagnostics };
  }
  if (file.status === "too-large") {
    diagnostics.push({
      code: "xcode.malformed-project",
      severity: "error",
      message: `${pbxprojRelativePath} is too large to inspect safely.`,
      evidence: [{ path: pbxprojRelativePath }],
    });
    return { inspection: emptyInspection(), appTargets: [], appTargetCandidates: [], diagnostics };
  }

  let archive: Record<string, unknown>;
  try {
    if (file.status !== "ok") throw new Error("unreadable project");
    const parsed: unknown = parsePbxProject(new TextDecoder().decode(file.bytes));
    if (!isRecord(parsed)) throw new Error("invalid project root");
    archive = parsed;
  } catch (error) {
    const parserLocation =
      error instanceof Error
        ? error.message.match(/\b(?:line|column|position)\s+\d+(?::\d+)?/i)?.[0]
        : undefined;
    diagnostics.push({
      code: "xcode.malformed-project",
      severity: "error",
      // Parser messages can quote the surrounding pbxproj token. Do not echo
      // arbitrary project content because shell phases sometimes hold secrets.
      message: `Could not parse ${pbxprojRelativePath}${parserLocation ? ` (${parserLocation})` : ""}.`,
      evidence: [{ path: pbxprojRelativePath }],
    });
    return { inspection: emptyInspection(), appTargets: [], appTargetCandidates: [], diagnostics };
  }

  const objectVersion = asString(archive.objectVersion);
  const objects = normalizeObjects(archive.objects);
  if (!objects) {
    diagnostics.push({
      code: "xcode.malformed-project",
      severity: "error",
      message: `${pbxprojRelativePath} has no readable Xcode object graph.`,
      evidence: [{ path: pbxprojRelativePath }],
    });
    return {
      inspection: emptyInspection(objectVersion),
      appTargets: [],
      appTargetCandidates: [],
      diagnostics,
    };
  }

  const rootObjectId = asString(archive.rootObject);
  const projectObject =
    (rootObjectId ? objects[rootObjectId] : undefined) ??
    Object.values(objects).find((object) => object.isa === "PBXProject");
  if (projectObject?.isa !== "PBXProject") {
    diagnostics.push({
      code: "xcode.malformed-project",
      severity: "error",
      message: `${pbxprojRelativePath} has no PBXProject root object.`,
      evidence: [{ path: pbxprojRelativePath }],
    });
    return {
      inspection: emptyInspection(objectVersion),
      appTargets: [],
      appTargetCandidates: [],
      diagnostics,
    };
  }

  const parents = buildPbxParentIndex(objects);
  const groupRootDirectory = resolve(
    dirname(projectPath),
    asString(projectObject.projectDirPath) ?? "",
  );
  const packages = await inspectPackageReferences(root, projectPath, projectObject, objects);
  const appTargets: IOSAppTarget[] = [];
  const appTargetCandidates: ParsedProject["appTargetCandidates"] = [];
  const targetIds = asStringArray(projectObject.targets).sort();
  const sourceMemberships: IOSTargetSourceMembership[] = [];
  const sourceMembershipById = new Map<
    string,
    {
      files: Array<{ absolutePath: string; relativePath: string }>;
      complete: boolean;
      diagnostics: IOSDiagnostic[];
    }
  >();

  // Resolve every native target, not only application products. Source
  // mutators use this hidden result to refuse files shared with extensions,
  // tests, or another app target while the public inspection JSON stays
  // semantic and compact.
  for (const targetId of targetIds) {
    const targetObject = objects[targetId];
    if (targetObject?.isa !== "PBXNativeTarget") continue;
    const membershipDiagnostics: IOSDiagnostic[] = [];
    const membership = await sourceFilesForTarget({
      root,
      projectPath,
      groupRootDirectory,
      targetId,
      targetObject,
      objects,
      parents,
      diagnostics: membershipDiagnostics,
    });
    sourceMembershipById.set(targetId, { ...membership, diagnostics: membershipDiagnostics });
    sourceMemberships.push({
      targetId,
      targetName: asString(targetObject.name) ?? targetId,
      projectPath: projectRelativePath,
      files: membership.files,
      complete: membership.complete,
    });
  }

  for (const targetId of targetIds) {
    const targetObject = objects[targetId];
    if (targetObject?.isa !== "PBXNativeTarget" || targetObject.productType !== APP_PRODUCT_TYPE) {
      continue;
    }
    const targetName = asString(targetObject.name) ?? targetId;
    const configurationDiagnostics: IOSDiagnostic[] = [];
    const targetConfigurations = await inspectTargetBuildConfigurations({
      root,
      projectPath,
      groupRootDirectory,
      projectObject,
      targetId,
      targetObject,
      objects,
      parents,
      diagnostics: configurationDiagnostics,
    });
    if (
      targetConfigurations.length > 0 &&
      !targetConfigurations.some((configuration) => configuration.isIOS)
    ) {
      continue;
    }
    appTargetCandidates.push({
      targetId,
      targetName,
      projectPath: projectRelativePath,
    });
    if (requestedTarget && requestedTarget !== targetId && requestedTarget !== targetName) {
      continue;
    }
    diagnostics.push(...configurationDiagnostics);

    const configurations = targetConfigurations.map((configuration) => configuration.model);
    await attachEntitlements(
      root,
      projectPath,
      configurations,
      new Map(
        targetConfigurations.map((configuration) => [
          configuration.model.name,
          configuration.entitlementContexts,
        ]),
      ),
      diagnostics,
    );
    addBuildSettingConflictDiagnostics(targetName, configurations, diagnostics);
    const targetSources = sourceMembershipById.get(targetId) ?? {
      files: [],
      complete: false,
      diagnostics: [],
    };
    diagnostics.push(...targetSources.diagnostics);

    const swiftInspection =
      targetSources.files.length > 0
        ? await inspectSwiftSources(targetSources.files, {
            membershipComplete: targetSources.complete,
            platform: "ios",
          })
        : emptySwiftInspection();
    if (targetSources.complete && !swiftInspection.evidenceComplete) {
      diagnostics.push({
        code: "xcode.incomplete-source-membership",
        severity: "warning",
        message: `One or more Swift members of ${targetName} could not be read safely; absence checks are advisory.`,
        evidence: [
          {
            path: relativeIOSPath(root, resolve(projectPath, "project.pbxproj")),
            objectId: targetId,
          },
        ],
      });
    }

    const appTarget: IOSAppTarget = {
      id: targetId,
      name: targetName,
      productName: asString(targetObject.productName),
      projectPath: projectRelativePath,
      configurations,
      packages: inspectTargetPackages(
        root,
        projectPath,
        targetName,
        targetObject,
        objects,
        packages,
        diagnostics,
      ),
      swift: swiftInspection,
    };
    appTargets.push(appTarget);
  }

  appTargets.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  appTargetCandidates.sort(
    (a, b) => a.targetName.localeCompare(b.targetName) || a.targetId.localeCompare(b.targetId),
  );
  return {
    inspection: {
      path: projectRelativePath,
      pbxprojPath: pbxprojRelativePath,
      objectVersion,
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

function selectTarget(
  candidates: ParsedProject["appTargetCandidates"],
  requestedTarget: string | undefined,
  diagnostics: IOSDiagnostic[],
): IOSTargetSelection {
  if (requestedTarget) {
    const matches = candidates.filter(
      (candidate) =>
        candidate.targetId === requestedTarget || candidate.targetName === requestedTarget,
    );
    const match = matches[0];
    if (matches.length === 1 && match) return { state: "selected", ...match };
    if (matches.length > 1) {
      const matchedByObjectId = matches.every(
        (candidate) => candidate.targetId === requestedTarget,
      );
      diagnostics.push({
        code: "xcode.ambiguous-app-target",
        severity: "error",
        message: matchedByObjectId
          ? `Target object ID "${requestedTarget}" exists in more than one project.`
          : `Target name "${requestedTarget}" exists in more than one project.`,
        remedy: matchedByObjectId
          ? "Run the inspector from the directory containing only the intended project."
          : "Rerun with --target <target-id>.",
        evidence: matches.map((candidate) => ({
          path: candidate.projectPath,
          objectId: candidate.targetId,
        })),
      });
      return { state: "ambiguous", candidates: matches };
    }

    diagnostics.push({
      code: "xcode.target-not-found",
      severity: "error",
      message: `No iOS application target matches "${requestedTarget}".`,
      remedy: "Choose one of the reported target names or IDs.",
      evidence: candidates.map((candidate) => ({
        path: candidate.projectPath,
        objectId: candidate.targetId,
      })),
    });
    return {
      state: "not-found",
      requested: requestedTarget,
      candidates: candidates.map((candidate) => `${candidate.targetName} (${candidate.targetId})`),
    };
  }

  const onlyCandidate = candidates[0];
  if (candidates.length === 1 && onlyCandidate) {
    return { state: "selected", ...onlyCandidate };
  }
  if (candidates.length === 0) {
    diagnostics.push({
      code: "xcode.no-ios-app-target",
      severity: "error",
      message: "No iOS application target was found.",
      remedy: "Run from an iOS app project, or pass --framework ios from its project root.",
      evidence: [],
    });
    return { state: "none" };
  }

  diagnostics.push({
    code: "xcode.ambiguous-app-target",
    severity: "error",
    message: `Found ${candidates.length} iOS application targets; none was selected automatically.`,
    remedy: "Rerun with --target <target-name-or-id>.",
    evidence: candidates.map((candidate) => ({
      path: candidate.projectPath,
      objectId: candidate.targetId,
    })),
  });
  return { state: "ambiguous", candidates };
}

async function detectGeneratedProject(
  root: string,
): Promise<{ kind: "xcodegen" | "tuist"; path: string } | null> {
  const xcodeGenPath = resolve(root, "project.yml");
  if (
    (await pathIsSafelyWithinIOSRoot(root, xcodeGenPath)) &&
    (await Bun.file(xcodeGenPath).exists())
  ) {
    return { kind: "xcodegen", path: "project.yml" };
  }
  for (const path of ["Project.swift", "Workspace.swift", "Tuist/ProjectDescriptionHelpers"]) {
    const absolutePath = resolve(root, path);
    if (
      (await pathIsSafelyWithinIOSRoot(root, absolutePath)) &&
      (await Bun.file(absolutePath).exists())
    ) {
      return { kind: "tuist", path };
    }
  }
  return null;
}

export async function inspectIOSProject(
  rootInput: string,
  options: { target?: string; exhaustiveContainerDiscovery?: boolean } = {},
): Promise<IOSProjectInspectionResult> {
  const invocationPath = resolve(rootInput);
  const root = invocationPath.endsWith(".xcodeproj")
    ? dirname(invocationPath)
    : invocationPath.endsWith(".xcworkspace")
      ? dirname(invocationPath).endsWith(".xcodeproj")
        ? dirname(dirname(invocationPath))
        : dirname(invocationPath)
      : invocationPath;
  if (await hasInterruptedIOSFileTransaction(root)) {
    return {
      schemaVersion: 1,
      platform: "ios",
      root,
      workspaces: [],
      projects: [],
      appTargets: [],
      selection: { state: "none" },
      localPublishableKey: { state: "unproven" },
      generatedProject: null,
      diagnostics: [
        {
          code: "xcode.interrupted-file-transaction",
          severity: "error",
          message:
            "Clerk stopped inspection because an iOS file update is incomplete or still active.",
          remedy:
            "Wait for any running Clerk command to finish. If none is running, run `clerk init` without `--dry-run` to recover the interrupted update before inspecting the project again.",
          evidence: [],
        },
      ],
    };
  }
  const diagnostics: IOSDiagnostic[] = [];
  const discovered = await discoverIOSContainers(invocationPath, {
    exhaustive: options.exhaustiveContainerDiscovery === true,
  });
  const projectPaths = new Set(discovered.projectPaths);
  const workspaces = [];

  for (const workspacePath of discovered.workspacePaths) {
    const workspace = await inspectWorkspace(root, workspacePath);
    workspaces.push(workspace.inspection);
    for (const projectPath of workspace.localProjectPaths) projectPaths.add(projectPath);
  }

  const referencedProjects = await discoverReferencedIOSProjects(root, projectPaths);
  for (const projectPath of referencedProjects.projectPaths) projectPaths.add(projectPath);

  if (projectPaths.size === 0) {
    diagnostics.push({
      code: "xcode.no-project",
      severity: "error",
      message: "No .xcodeproj was found in the inspected root.",
      remedy: "Run this command from the directory containing your iOS project.",
      evidence: [],
    });
  }

  const projects: IOSProjectInspection[] = [];
  const appTargets: IOSAppTarget[] = [];
  const appTargetCandidates: ParsedProject["appTargetCandidates"] = [];
  const sourceMemberships: IOSTargetSourceMembership[] = [];
  for (const projectPath of [...projectPaths].sort()) {
    const parsed = await parseProject(root, projectPath, options.target);
    projects.push(parsed.inspection);
    appTargets.push(...parsed.appTargets);
    appTargetCandidates.push(...parsed.appTargetCandidates);
    sourceMemberships.push(...(parsed.sourceMemberships ?? []));
    diagnostics.push(...parsed.diagnostics);
  }
  if (options.exhaustiveContainerDiscovery === true && !discovered.complete) {
    for (const membership of sourceMemberships) membership.complete = false;
  }
  if (!referencedProjects.complete) {
    for (const membership of sourceMemberships) membership.complete = false;
    for (const target of appTargets) target.swift.evidenceComplete = false;
    diagnostics.push({
      code: "xcode.incomplete-source-membership",
      severity: "warning",
      message:
        "One or more referenced Xcode projects could not be inspected safely; source ownership checks are incomplete.",
      evidence: [],
    });
  }
  appTargets.sort(
    (a, b) =>
      a.projectPath.localeCompare(b.projectPath) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  appTargetCandidates.sort(
    (a, b) =>
      a.projectPath.localeCompare(b.projectPath) ||
      a.targetName.localeCompare(b.targetName) ||
      a.targetId.localeCompare(b.targetId),
  );

  const generatedProjectMarker = await detectGeneratedProject(root);
  if (generatedProjectMarker) {
    diagnostics.push({
      code: "xcode.generated-project",
      severity: "warning",
      message: `This appears to be a ${generatedProjectMarker.kind === "xcodegen" ? "XcodeGen" : "Tuist"} project. Future automated setup must update the source manifest, not generated project.pbxproj output.`,
      evidence: [{ path: generatedProjectMarker.path }],
    });
  }

  const selection = selectTarget(appTargetCandidates, options.target, diagnostics);
  const selectedAppTarget =
    selection.state === "selected"
      ? appTargets.find(
          (target) =>
            target.id === selection.targetId && target.projectPath === selection.projectPath,
        )
      : undefined;
  const localPublishableKeyInspection = inspectInlinePublishableKey(selectedAppTarget, diagnostics);
  const result: IOSProjectInspectionResult = {
    schemaVersion: 1,
    platform: "ios",
    root,
    workspaces: workspaces.sort((a, b) => a.path.localeCompare(b.path)),
    projects: projects.sort((a, b) => a.path.localeCompare(b.path)),
    appTargets,
    selection,
    localPublishableKey: localPublishableKeyInspection,
    generatedProject: generatedProjectMarker?.kind ?? null,
    diagnostics,
  };
  sourceMembershipByInspection.set(result, sourceMemberships);
  return result;
}

/**
 * Returns the exact source-membership result used by the iOS semantic
 * inspector without adding source paths to the serializable inspection JSON.
 * This is intended for strict source mutators that must prove a non-Clerk
 * Swift file belongs to one selected application target.
 */
export async function inspectIOSSourceMembership(
  rootInput: string,
): Promise<IOSTargetSourceMembership[]> {
  const inspection = await inspectIOSProject(rootInput, {
    exhaustiveContainerDiscovery: true,
  });
  return sourceMembershipByInspection.get(inspection) ?? [];
}

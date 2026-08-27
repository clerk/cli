import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { parse as parsePbxProject } from "@bacons/xcode/json";
import { parseEnvFile } from "../../../lib/dotenv.ts";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import {
  addBuildSettingConflictDiagnostics,
  inspectTargetBuildConfigurations,
  resolveEntitlementsAbsolutePath,
} from "./build-settings.ts";
import {
  discoverIOSContainers,
  inspectWorkspace,
  maskXMLComments,
  pathIsSafelyWithinIOSRoot,
  relativeIOSPath,
  xmlAttribute,
} from "./discovery.ts";
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
const MAX_PBXPROJ_BYTES = 15_000_000;
const MAX_SOURCE_FILES = 2_500;
const MAX_SOURCE_DEPTH = 24;
const MAX_SECRET_DISCOVERY_DEPTH = 5;
const MAX_SECRET_FILES = 20;
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
    localSecretsRuntimeBindings: [],
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

interface PublishableKeyCandidate {
  value?: string;
  decoded?: { frontendApiHost: string; instanceType: "development" | "production" };
  invalid?: true;
  source: string;
  evidence: IOSSourceEvidence[];
  priority: number;
  ambient?: true;
}

async function collectSchemeFiles(
  root: string,
  directory: string,
  output: string[],
  depth = 0,
): Promise<void> {
  if (depth > 6 || output.length >= 100) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectSchemeFiles(root, path, output, depth + 1);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".xcscheme") &&
      (await pathIsSafelyWithinIOSRoot(root, path))
    ) {
      output.push(path);
    }
  }
}

function enclosingXcodeContainer(path: string): string | undefined {
  let current = dirname(path);
  while (true) {
    if (current.endsWith(".xcodeproj") || current.endsWith(".xcworkspace")) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function schemeReferencesSelectedProject(
  root: string,
  schemePath: string,
  selectedProjectPath: string,
  referencedContainer: string | undefined,
): boolean {
  const selectedProject = resolve(root, selectedProjectPath);
  const enclosingContainer = enclosingXcodeContainer(schemePath);
  if (!referencedContainer) {
    return (
      enclosingContainer?.endsWith(".xcodeproj") === true && enclosingContainer === selectedProject
    );
  }
  const base = enclosingContainer ? dirname(enclosingContainer) : root;
  const normalized = referencedContainer.replaceAll("\\", "/");
  return resolve(base, ...normalized.split("/")) === selectedProject;
}

async function schemePublishableKeyCandidates(
  root: string,
  selection: IOSTargetSelection,
  schemeRoots: string[],
): Promise<PublishableKeyCandidate[]> {
  if (selection.state !== "selected") return [];
  const schemePaths: string[] = [];
  for (const schemeRoot of [...new Set(schemeRoots)].sort()) {
    if (await pathIsSafelyWithinIOSRoot(root, schemeRoot)) {
      await collectSchemeFiles(root, schemeRoot, schemePaths);
    }
  }
  const candidates: PublishableKeyCandidate[] = [];

  for (const path of schemePaths.sort()) {
    const file = Bun.file(path);
    if (!(await file.exists()) || file.size > 2_000_000) continue;
    let xml: string;
    try {
      xml = maskXMLComments(await file.text());
    } catch {
      continue;
    }

    for (const launchAction of xml.matchAll(/<LaunchAction\b[^>]*>([\s\S]*?)<\/LaunchAction>/g)) {
      const body = launchAction[1] ?? "";
      const referencesTarget = [...body.matchAll(/<BuildableReference\b([^>]*)>/g)].some(
        (reference) => {
          const attributes = reference[1] ?? "";
          if (xmlAttribute(attributes, "BlueprintIdentifier") !== selection.targetId) {
            return false;
          }
          const container = xmlAttribute(attributes, "ReferencedContainer")?.replace(
            /^container:/,
            "",
          );
          return schemeReferencesSelectedProject(root, path, selection.projectPath, container);
        },
      );
      if (!referencesTarget) continue;

      for (const variable of body.matchAll(/<EnvironmentVariable\b([^>]*)\/?\s*>/g)) {
        const attributes = variable[1] ?? "";
        if (xmlAttribute(attributes, "key") !== "CLERK_PUBLISHABLE_KEY") continue;
        if ((xmlAttribute(attributes, "isEnabled") ?? "YES").toUpperCase() === "NO") continue;
        const value = xmlAttribute(attributes, "value")?.trim();
        if (!value) continue;
        const source = relativeIOSPath(root, path);
        candidates.push({
          value,
          source,
          evidence: [{ path: source, keyPath: "LaunchAction.EnvironmentVariables" }],
          priority: 5,
        });
      }
    }
  }
  return candidates;
}

async function collectLocalSecretsPlists(
  root: string,
  directory: string,
  output: string[],
  depth = 0,
): Promise<void> {
  if (depth > MAX_SECRET_DISCOVERY_DEPTH || output.length >= MAX_SECRET_FILES) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (output.length >= MAX_SECRET_FILES) return;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SOURCE_IGNORES.has(entry.name) && !entry.name.startsWith(".")) {
        await collectLocalSecretsPlists(root, absolutePath, output, depth + 1);
      }
    } else if (
      entry.isFile() &&
      entry.name === "LocalSecrets.plist" &&
      (await pathIsSafelyWithinIOSRoot(root, absolutePath))
    ) {
      output.push(absolutePath);
    }
  }
}

async function readPublishableKeyCandidates(
  root: string,
  selection: IOSTargetSelection,
  targetLocalSecretsPaths: string[],
  schemeRoots: string[],
  inlineCandidates: PublishableKeyCandidate[],
): Promise<PublishableKeyCandidate[]> {
  const selectedProjectDirectory =
    selection.state === "selected" ? dirname(resolve(root, selection.projectPath)) : root;
  const projectDirectories = [...new Set([selectedProjectDirectory, root])];
  const candidates: PublishableKeyCandidate[] = [
    ...inlineCandidates,
    ...(await schemePublishableKeyCandidates(root, selection, schemeRoots)),
  ];

  for (const directory of projectDirectories) {
    for (const [fileName, priority] of [
      [".env.local", 20],
      [".env", 30],
    ] as const) {
      const path = resolve(directory, fileName);
      if (!(await pathIsSafelyWithinIOSRoot(root, path))) continue;
      const file = Bun.file(path);
      if (!(await file.exists()) || file.size > 1_000_000) continue;
      try {
        for (const line of parseEnvFile(await file.text())) {
          if (line.type === "entry" && line.key === "CLERK_PUBLISHABLE_KEY" && line.value) {
            candidates.push({
              value: line.value,
              source: relativeIOSPath(root, path),
              evidence: [{ path: relativeIOSPath(root, path), keyPath: line.key }],
              priority,
            });
          }
        }
      } catch {
        // A partially-written env file is not evidence of a usable key.
      }
    }
  }

  for (const path of targetLocalSecretsPaths) {
    const file = Bun.file(path);
    if (!(await file.exists()) || file.size > 1_000_000) continue;
    try {
      const parsed = parseIOSPlist(await file.text());
      const value = isRecord(parsed) ? asString(parsed.CLERK_PUBLISHABLE_KEY) : undefined;
      if (value) {
        candidates.push({
          value,
          source: relativeIOSPath(root, path),
          evidence: [{ path: relativeIOSPath(root, path), keyPath: "CLERK_PUBLISHABLE_KEY" }],
          priority: 10,
        });
      }
    } catch {
      // Binary/malformed secret files are ignored rather than printing parser data.
    }
  }

  for (const directory of projectDirectories) {
    const path = resolve(directory, ".clerk", ".tmp", "keyless.json");
    if (!(await pathIsSafelyWithinIOSRoot(root, path))) continue;
    const file = Bun.file(path);
    if (!(await file.exists()) || file.size > 1_000_000) continue;
    try {
      const parsed: unknown = await file.json();
      const value = isRecord(parsed) ? asString(parsed.publishableKey) : undefined;
      if (value) {
        candidates.push({
          value,
          source: relativeIOSPath(root, path),
          evidence: [{ path: relativeIOSPath(root, path), keyPath: "publishableKey" }],
          priority: 40,
        });
      }
    } catch {
      // A partially-written SDK keyless file is not evidence of a usable key.
    }
  }

  const ambient = process.env.CLERK_PUBLISHABLE_KEY;
  if (ambient) {
    candidates.push({
      value: ambient,
      source: "CLERK_PUBLISHABLE_KEY environment variable",
      evidence: [],
      priority: 50,
      ambient: true,
    });
  }

  return candidates.sort((a, b) => a.priority - b.priority || a.source.localeCompare(b.source));
}

async function inspectLocalPublishableKeys(
  root: string,
  selection: IOSTargetSelection,
  targetLocalSecretsPaths: string[],
  schemeRoots: string[],
  inlineCandidates: PublishableKeyCandidate[],
  diagnostics: IOSDiagnostic[],
): Promise<IOSProjectInspectionResult["localPublishableKey"]> {
  const candidates = await readPublishableKeyCandidates(
    root,
    selection,
    targetLocalSecretsPaths,
    schemeRoots,
    inlineCandidates,
  );
  const candidateSources = [...new Set(candidates.map((candidate) => candidate.source))].sort();
  const decodedCandidates: Array<{
    candidate: PublishableKeyCandidate;
    decoded?: { frontendApiHost: string; instanceType: "development" | "production" };
  }> = [];
  const invalidSources = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.decoded) {
      decodedCandidates.push({ candidate, decoded: candidate.decoded });
      continue;
    }
    try {
      if (candidate.invalid || candidate.value == null) throw new Error("invalid candidate");
      const value = decodePublishableKey(candidate.value);
      decodedCandidates.push({
        candidate,
        decoded: { frontendApiHost: value.fapiHost, instanceType: value.instanceType },
      });
    } catch {
      invalidSources.add(candidate.source);
      decodedCandidates.push({ candidate });
      diagnostics.push({
        code: "clerk.invalid-publishable-key",
        severity: "warning",
        message: `A publishable key candidate from ${candidate.source} has an invalid format.`,
        remedy: "Replace it with a valid pk_test_ or pk_live_ publishable key.",
        evidence: candidate.evidence,
      });
    }
  }

  const localCandidates = decodedCandidates.filter((item) => !item.candidate.ambient);
  const ambientCandidates = decodedCandidates.filter((item) => item.candidate.ambient);
  const effectivePriority = localCandidates[0]?.candidate.priority;
  const effectiveCandidates =
    effectivePriority == null
      ? ambientCandidates
      : localCandidates.filter((item) => item.candidate.priority === effectivePriority);

  // A non-empty higher-precedence source is what the app/CLI will consume.
  // Never fall through to a lower-precedence valid key when that source is malformed.
  if (effectiveCandidates.some((item) => !item.decoded)) {
    return {
      found: false,
      source: effectiveCandidates[0]!.candidate.source,
      conflict: false,
      candidateSources,
      invalidSources: [...invalidSources].sort(),
    };
  }

  const effectiveValid = effectiveCandidates.filter(
    (
      item,
    ): item is typeof item & {
      decoded: { frontendApiHost: string; instanceType: "development" | "production" };
    } => item.decoded != null,
  );
  const identities = new Set(
    effectiveValid.map((item) => `${item.decoded.instanceType}:${item.decoded.frontendApiHost}`),
  );
  const effective = effectiveValid[0];

  if (identities.size > 1) {
    diagnostics.push({
      code: "clerk.conflicting-publishable-keys",
      severity: "error",
      message: "Equally effective publishable-key sources point to different Clerk instances.",
      remedy: "Remove the stale source or make the equally preferred values agree.",
      evidence: effectiveValid.flatMap((item) => item.candidate.evidence),
    });
    return {
      found: true,
      source: effective!.candidate.source,
      conflict: true,
      candidateSources,
      invalidSources: [...invalidSources].sort(),
    };
  }

  if (!effective) {
    return {
      found: false,
      conflict: false,
      candidateSources,
      invalidSources: [...invalidSources].sort(),
    };
  }
  return {
    found: true,
    conflict: false,
    source: effective.candidate.source,
    frontendApiHost: effective.decoded.frontendApiHost,
    instanceType: effective.decoded.instanceType,
    candidateSources,
    invalidSources: [...invalidSources].sort(),
  };
}

async function localPackageIsClerk(root: string, packagePath: string): Promise<boolean> {
  const manifestPath = resolve(packagePath, "Package.swift");
  if (!(await pathIsSafelyWithinIOSRoot(root, manifestPath))) return false;
  const manifest = Bun.file(manifestPath);
  if (!(await manifest.exists()) || manifest.size > 1_000_000) return false;
  try {
    const source = await manifest.text();
    return /\b(?:ClerkKit|ClerkKitUI)\b/.test(source);
  } catch {
    return false;
  }
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
        isClerk: safelyLocal && (await localPackageIsClerk(root, absolutePath)),
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
  const productPackageIds = [...clerkKit.packageIds, ...clerkKitUI.packageIds];
  const attributed = productPackageIds
    .map((id) => packageById.get(id))
    .filter((item): item is IOSPackageReference => item?.isClerk === true);
  const declaredClerkPackage = packages.find((item) => item.isClerk);
  const hasClerkProduct = clerkKit.state !== "absent" || clerkKitUI.state !== "absent";

  let packageKind: IOSClerkPackageState["package"] = "absent";
  if (attributed[0]) packageKind = attributed[0].kind;
  else if (declaredClerkPackage) packageKind = declaredClerkPackage.kind;
  else if (hasClerkProduct) {
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

async function inspectEntitlements(
  root: string,
  absolutePath: string,
  evidence: IOSSourceEvidence[],
  diagnostics: IOSDiagnostic[],
): Promise<IOSEntitlementsInspection | undefined> {
  const relativePath = relativeIOSPath(root, absolutePath);
  const file = Bun.file(absolutePath);
  if (!(await file.exists())) {
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
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0, 8)).startsWith("bplist")) {
      throw new Error("binary plist");
    }
    const parsed = parseIOSPlist(new TextDecoder().decode(bytes));
    if (!isRecord(parsed)) throw new Error("plist root is not a dictionary");

    const applicationIdentifier = asString(parsed["application-identifier"]);
    return {
      path: relativePath,
      associatedDomains: stringArray(parsed["com.apple.developer.associated-domains"]).sort(),
      unresolvedAssociatedDomains: [],
      applicationIdentifier,
      teamIdentifier: asString(parsed["com.apple.developer.team-identifier"]),
      signInWithApple: stringArray(parsed["com.apple.developer.applesignin"]).length > 0,
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
  settingsByConfiguration: Map<string, Record<string, string>>,
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

    const settings = settingsByConfiguration.get(configuration.name) ?? {};
    const resolvedAssociatedDomains: string[] = [];
    const unresolvedAssociatedDomains: string[] = [];
    for (const domain of entitlements.associatedDomains) {
      const expanded = expandEntitlementDomain(
        domain,
        settings,
        configuration.bundleIdentifier.state === "resolved"
          ? configuration.bundleIdentifier.value
          : undefined,
      );
      if (expanded) resolvedAssociatedDomains.push(expanded);
      else unresolvedAssociatedDomains.push(domain);
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
      prefixMatch[2] === configuration.bundleIdentifier.value
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
  settings: Record<string, string>,
  bundleIdentifier: string | undefined,
): string | undefined {
  const variable = /\$\(([^)]+)\)|\$\{([^}]+)\}/g;
  const builtins: Record<string, string | undefined> = {
    CFBundleIdentifier: bundleIdentifier,
    PRODUCT_BUNDLE_IDENTIFIER: bundleIdentifier,
  };
  const resolving = new Set<string>();
  const expand = (value: string, depth: number): string | undefined => {
    if (depth > 20) return undefined;
    let unresolved = false;
    variable.lastIndex = 0;
    const expanded = value.replace(variable, (_match, parenthesized, braced) => {
      const name = String(parenthesized ?? braced);
      if (name.includes(":") || resolving.has(name)) {
        unresolved = true;
        return "";
      }
      const replacement = settings[name] ?? builtins[name];
      if (replacement == null) {
        unresolved = true;
        return "";
      }
      resolving.add(name);
      const nested = expand(replacement, depth + 1);
      resolving.delete(name);
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

function synchronizedExclusions(
  group: PbxObject,
  targetId: string,
  relevantPhaseIds: Set<string>,
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
      relevantPhaseIds.has(asString(exception.buildPhase) ?? "");
    if (!appliesToTarget && !appliesToPhase) continue;

    for (const path of asStringArray(exception.membershipExceptions)) {
      excluded.add(normalizeSynchronizedPath(path));
    }
    if (isRecord(exception.platformFiltersByRelativePath)) {
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
  }
  return excluded;
}

function synchronizedPathIsExcluded(path: string, excluded: Set<string>): boolean {
  return [...excluded].some(
    (excludedPath) => path === excludedPath || path.startsWith(`${excludedPath}/`),
  );
}

async function localSecretsForTarget(options: {
  root: string;
  projectPath: string;
  groupRootDirectory: string;
  targetId: string;
  targetObject: PbxObject;
  objects: PbxObjects;
  parents: Map<string, string>;
}): Promise<string[]> {
  const { root, projectPath, groupRootDirectory, targetId, targetObject, objects, parents } =
    options;
  const projectDirectory = dirname(projectPath);
  const paths = new Set<string>();
  const resourcePhaseIds = new Set(
    asStringArray(targetObject.buildPhases).filter(
      (phaseId) => objects[phaseId]?.isa === "PBXResourcesBuildPhase",
    ),
  );

  for (const phaseId of resourcePhaseIds) {
    const phase = objects[phaseId];
    if (phase?.isa !== "PBXResourcesBuildPhase") continue;
    for (const buildFileId of asStringArray(phase.files)) {
      const buildFile = objects[buildFileId];
      if (!buildFile || !buildFileIOSApplicability(buildFile).applies) continue;
      const fileReference = asString(buildFile.fileRef);
      if (!fileReference) continue;
      const absolutePath = resolvePbxFilePath(
        fileReference,
        objects,
        parents,
        projectDirectory,
        groupRootDirectory,
      );
      if (
        absolutePath?.endsWith(`${sep}LocalSecrets.plist`) &&
        (await pathIsSafelyWithinIOSRoot(root, absolutePath))
      ) {
        paths.add(absolutePath);
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
    await collectLocalSecretsPlists(root, groupPath, discovered);
    const excluded = synchronizedExclusions(group, targetId, resourcePhaseIds, objects);
    for (const absolutePath of discovered) {
      const relativePath = relative(groupPath, absolutePath).split(sep).join("/");
      if (!synchronizedPathIsExcluded(relativePath, excluded)) paths.add(absolutePath);
    }
  }

  return [...paths].sort();
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
  parents: Map<string, string>;
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
  for (const phaseId of asStringArray(targetObject.buildPhases)) {
    if (!objects[phaseId]) {
      reportDangling(phaseId, `Target ${targetId} contains a dangling build phase reference.`);
    }
  }
  const sourcePhaseIds = new Set(
    asStringArray(targetObject.buildPhases).filter(
      (phaseId) => objects[phaseId]?.isa === "PBXSourcesBuildPhase",
    ),
  );

  for (const phaseId of sourcePhaseIds) {
    const phase = objects[phaseId];
    if (phase?.isa !== "PBXSourcesBuildPhase") continue;
    for (const buildFileId of asStringArray(phase.files)) {
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

  for (const groupId of asStringArray(targetObject.fileSystemSynchronizedGroups)) {
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

    const excluded = synchronizedExclusions(group, targetId, sourcePhaseIds, objects);
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
  const file = Bun.file(pbxprojPath);
  if (!(await file.exists())) {
    diagnostics.push({
      code: "xcode.missing-project-file",
      severity: "error",
      message: `${projectRelativePath} does not contain project.pbxproj.`,
      evidence: [{ path: pbxprojRelativePath }],
    });
    return { inspection: emptyInspection(), appTargets: [], appTargetCandidates: [], diagnostics };
  }
  if (file.size > MAX_PBXPROJ_BYTES) {
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
    const parsed: unknown = parsePbxProject(await readFile(pbxprojPath, "utf8"));
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
          configuration.settings,
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

    const targetLocalSecrets = await localSecretsForTarget({
      root,
      projectPath,
      groupRootDirectory,
      targetId,
      targetObject,
      objects,
      parents,
    });
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
      runtimeKeySinks: targetLocalSecrets.map((path) => ({
        kind: "local-secrets-plist" as const,
        path: relativeIOSPath(root, path),
      })),
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
  const inlinePublishableKeyCandidates: PublishableKeyCandidate[] =
    selectedAppTarget?.swift.configureCalls
      .filter((call) => call.publishableKeyWiring === "inline-literal")
      .map((call) => ({
        source: call.path,
        evidence: [{ path: call.path, keyPath: "Clerk.configure(publishableKey:)" }],
        priority: 0,
        ...(call.inlinePublishableKey?.state === "valid"
          ? {
              decoded: {
                frontendApiHost: call.inlinePublishableKey.frontendApiHost,
                instanceType: call.inlinePublishableKey.instanceType,
              },
            }
          : { invalid: true as const }),
      })) ?? [];
  const localPublishableKeyInspection = await inspectLocalPublishableKeys(
    root,
    selection,
    selectedAppTarget?.runtimeKeySinks.map((sink) => resolve(root, sink.path)) ?? [],
    [
      ...(selection.state === "selected" ? [resolve(root, selection.projectPath)] : []),
      ...discovered.workspacePaths,
    ],
    inlinePublishableKeyCandidates,
    diagnostics,
  );
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

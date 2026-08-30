import { lstat, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { dirname, isAbsolute, resolve } from "node:path";
import { build as buildPbxProject, parse as parsePbxProject } from "@bacons/xcode/json";
import semver from "semver";
import { hasIncompleteIOSContainerDiscovery, inspectIOSProject } from "./inspect.ts";
import { pathIsSafelyWithinIOSRoot, relativeIOSPath } from "./discovery.ts";
import { localClerkIOSPackageIsStructurallyValid } from "./local-package.ts";
import {
  applyIOSExistingFileTransaction,
  hashIOSFileBytes,
  prepareIOSFileMutationBoundary,
  type IOSExistingFileMutation,
  type IOSFileMutationBoundary,
} from "./file-transaction.ts";
import {
  asString,
  asStringArray,
  isClerkIOSRepository,
  isRecord,
  type PbxObject,
  type PbxObjects,
} from "./pbx.ts";
import type { IOSNativePlatform } from "./types.ts";

const APP_PRODUCT_TYPE = "com.apple.product-type.application";
const CLERK_REPOSITORY = "https://github.com/clerk/clerk-ios";
const MAX_PBXPROJ_BYTES = 15_000_000;
const MAX_PACKAGE_METADATA_BYTES = 2_000_000;
const PRODUCT_NAMES = ["ClerkKit", "ClerkKitUI"] as const;
const CLERK_SDK_MINIMUM_DEPLOYMENT_TARGET = {
  ios: "17.0",
  macos: "14.0",
} as const satisfies Record<IOSNativePlatform, string>;

export const DEFAULT_CLERK_IOS_MINIMUM_VERSION = "1.0.0";
// These floors are equal today, but remain separate so AuthView can raise its
// minimum without changing the core-only ClerkKit installation policy.
export const PREBUILT_AUTH_CLERK_IOS_MINIMUM_VERSION = DEFAULT_CLERK_IOS_MINIMUM_VERSION;

export type IOSSDKProduct = (typeof PRODUCT_NAMES)[number];

export interface IOSSDKInstallOptions {
  root: string;
  /** Project-root-relative path selected by the iOS inspector. */
  projectPath: string;
  targetId: string;
  /** Primary platform view used to inspect the selected target. */
  platform?: IOSNativePlatform;
  /** Every platform on which the selected target must link the requested products. */
  supportedPlatforms?: IOSNativePlatform[];
  includeClerkKitUI?: boolean;
  /** Used only when a new clerk-ios remote reference must be created. */
  minimumVersion?: string;
  /** Require proof that the selected package supports the documented ClerkKitUI products. */
  requirePrebuiltAuthCompatibility?: boolean;
}

export type IOSSDKInstallBlockerCode =
  | "invalid-selection"
  | "external-path"
  | "generated-project"
  | "unreadable-project"
  | "malformed-project"
  | "target-not-found"
  | "ambiguous-target"
  | "incomplete-container-discovery"
  | "unresolved-platform"
  | "ambiguous-package"
  | "duplicate-package"
  | "unattributed-product"
  | "wrong-package"
  | "duplicate-product"
  | "ambiguous-frameworks-phase"
  | "duplicate-build-file"
  | "incompatible-sdk"
  | "unsupported-project";

export interface IOSSDKInstallBlocker {
  code: IOSSDKInstallBlockerCode;
  message: string;
}

export interface IOSSDKInstallPlan {
  schemaVersion: 1;
  kind: "clerk-ios-sdk-install";
  status: "ready" | "satisfied" | "blocked";
  root: string;
  projectPath: string;
  targetId: string;
  platform: IOSNativePlatform;
  supportedPlatforms: IOSNativePlatform[];
  products: IOSSDKProduct[];
  minimumVersion: string;
  requirePrebuiltAuthCompatibility?: true;
  /** SHA-256 of the exact project.pbxproj bytes this plan was made from. */
  expectedPbxprojHash?: string;
  actions: string[];
  blockers: IOSSDKInstallBlocker[];
}

export interface IOSSDKInstallApplyResult {
  status: "applied" | "satisfied" | "blocked" | "stale" | "rolled-back";
  plan: IOSSDKInstallPlan;
  message?: string;
}

interface ProjectParts {
  project: ReturnType<typeof parsePbxProject>;
  objects: PbxObjects;
  projectObjectId: string;
  projectObject: PbxObject;
  targetObject: PbxObject;
}

interface VerifiedPackage {
  id: string;
  kind: "remote" | "local";
}

interface ProductGraph {
  productId?: string;
  inTarget: boolean;
  /** One applicable build file per requested platform, when present. */
  buildFileIds: Partial<Record<IOSNativePlatform, string>>;
  hasAnyBuildFile: boolean;
}

interface PreparedInstall {
  plan: IOSSDKInstallPlan;
  pbxprojPath?: string;
  boundary?: IOSFileMutationBoundary;
  originalBytes?: Uint8Array;
  originalHash?: string;
  candidateBytes?: Uint8Array;
  candidateHash?: string;
  mode?: number;
}

function requestedProducts(includeClerkKitUI: boolean | undefined): IOSSDKProduct[] {
  return includeClerkKitUI ? ["ClerkKit", "ClerkKitUI"] : ["ClerkKit"];
}

function canonicalPlatforms(platforms: readonly IOSNativePlatform[]): IOSNativePlatform[] {
  const selected = new Set(platforms);
  return (["ios", "macos"] as const).filter((platform) => selected.has(platform));
}

function planPlatforms(options: IOSSDKInstallOptions): IOSNativePlatform[] {
  return canonicalPlatforms(options.supportedPlatforms ?? [options.platform ?? "ios"]);
}

function parsedDeploymentTarget(value: string): [number, number, number] | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const components = match.slice(1).map((component) => Number(component ?? "0")) as [
    number,
    number,
    number,
  ];
  return components.every(Number.isSafeInteger) ? components : undefined;
}

function deploymentTargetMeetsClerkSDKFloor(value: string, platform: IOSNativePlatform): boolean {
  const actual = parsedDeploymentTarget(value);
  const minimum = parsedDeploymentTarget(CLERK_SDK_MINIMUM_DEPLOYMENT_TARGET[platform]);
  if (!actual || !minimum) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}

function platformLabel(platform: IOSNativePlatform): string {
  return platform === "macos" ? "macOS" : "iOS";
}

function validMinimumVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function requiredCompatibilityVersion(requirePrebuiltAuthCompatibility: boolean): string {
  if (
    requirePrebuiltAuthCompatibility &&
    semver.gt(PREBUILT_AUTH_CLERK_IOS_MINIMUM_VERSION, DEFAULT_CLERK_IOS_MINIMUM_VERSION)
  ) {
    return PREBUILT_AUTH_CLERK_IOS_MINIMUM_VERSION;
  }
  return DEFAULT_CLERK_IOS_MINIMUM_VERSION;
}

function effectiveMinimumVersion(options: IOSSDKInstallOptions): string {
  const requested = options.minimumVersion ?? DEFAULT_CLERK_IOS_MINIMUM_VERSION;
  const required = requiredCompatibilityVersion(options.requirePrebuiltAuthCompatibility === true);
  if (semver.valid(requested) == null || semver.gte(requested, required)) {
    return requested;
  }
  return required;
}

function supportedRemoteRequirement(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const kind = asString(value.kind);
  if (kind === "upToNextMajorVersion" || kind === "upToNextMinorVersion") {
    const minimumVersion = asString(value.minimumVersion);
    return minimumVersion != null && validMinimumVersion(minimumVersion);
  }
  if (kind === "versionRange") {
    const minimumVersion = asString(value.minimumVersion);
    const maximumVersion = asString(value.maximumVersion);
    return (
      minimumVersion != null &&
      maximumVersion != null &&
      validMinimumVersion(minimumVersion) &&
      validMinimumVersion(maximumVersion)
    );
  }
  if (kind === "exactVersion") {
    const version = asString(value.version);
    return version != null && validMinimumVersion(version);
  }
  if (kind === "branch") return (asString(value.branch)?.trim().length ?? 0) > 0;
  if (kind === "revision") return (asString(value.revision)?.trim().length ?? 0) > 0;
  return false;
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

function makePlan(
  options: IOSSDKInstallOptions,
  root: string,
  projectPath: string,
  status: IOSSDKInstallPlan["status"],
  details: {
    actions?: string[];
    blockers?: IOSSDKInstallBlocker[];
    expectedPbxprojHash?: string;
  } = {},
): IOSSDKInstallPlan {
  return {
    schemaVersion: 1,
    kind: "clerk-ios-sdk-install",
    status,
    root,
    projectPath,
    targetId: options.targetId,
    platform: options.platform ?? "ios",
    supportedPlatforms: planPlatforms(options),
    products: requestedProducts(options.includeClerkKitUI),
    minimumVersion: effectiveMinimumVersion(options),
    ...(options.requirePrebuiltAuthCompatibility ? { requirePrebuiltAuthCompatibility: true } : {}),
    expectedPbxprojHash: details.expectedPbxprojHash,
    actions: details.actions ?? [],
    blockers: details.blockers ?? [],
  };
}

function blocked(
  options: IOSSDKInstallOptions,
  root: string,
  projectPath: string,
  code: IOSSDKInstallBlockerCode,
  message: string,
  source: Partial<PreparedInstall> = {},
): PreparedInstall {
  return {
    ...source,
    plan: makePlan(options, root, projectPath, "blocked", {
      blockers: [{ code, message }],
    }),
  };
}

function strictStringArray(object: PbxObject, key: string): string[] | undefined {
  const value = object[key];
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return [...value];
}

function projectParts(
  project: ReturnType<typeof parsePbxProject>,
  targetId: string,
): ProjectParts | undefined {
  const archive: unknown = project;
  if (!isRecord(archive) || !isRecord(archive.objects)) return undefined;
  for (const object of Object.values(archive.objects)) {
    if (!isRecord(object)) return undefined;
  }
  // Retain the parsed dictionary itself. Newly allocated object IDs must land
  // in the model that the writer serializes, not a detached index copy.
  const objects = archive.objects as PbxObjects;
  const projectObjectId = asString(archive.rootObject);
  const projectObject = projectObjectId ? objects[projectObjectId] : undefined;
  const targetObject = objects[targetId];
  if (!projectObjectId || projectObject?.isa !== "PBXProject" || !targetObject) {
    return undefined;
  }
  return { project, objects, projectObjectId, projectObject, targetObject };
}

async function localReferenceIsClerk(
  root: string,
  projectPath: string,
  object: PbxObject,
): Promise<boolean> {
  const relativePath = asString(object.relativePath);
  if (!relativePath) return false;
  const packagePath = resolve(dirname(projectPath), relativePath);
  return localClerkIOSPackageIsStructurallyValid(root, packagePath);
}

async function verifiedPackages(
  root: string,
  projectPath: string,
  objects: PbxObjects,
): Promise<VerifiedPackage[]> {
  const result: VerifiedPackage[] = [];
  for (const [id, object] of Object.entries(objects)) {
    if (object.isa === "XCRemoteSwiftPackageReference") {
      const repository = asString(object.repositoryURL);
      if (repository && isClerkIOSRepository(repository)) {
        result.push({ id, kind: "remote" });
      }
    } else if (
      object.isa === "XCLocalSwiftPackageReference" &&
      (await localReferenceIsClerk(root, projectPath, object))
    ) {
      result.push({ id, kind: "local" });
    }
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

type RemoteRequirementProof = "compatible" | "incompatible" | "needs-resolution";

function requirementBounds(requirement: PbxObject): {
  minimum?: string;
  maximum?: string;
  exact?: string;
} {
  const kind = asString(requirement.kind);
  if (kind === "exactVersion") return { exact: asString(requirement.version) };
  if (kind === "versionRange") {
    return {
      minimum: asString(requirement.minimumVersion),
      maximum: asString(requirement.maximumVersion),
    };
  }
  if (kind === "upToNextMajorVersion" || kind === "upToNextMinorVersion") {
    const minimum = asString(requirement.minimumVersion);
    const parsed = minimum == null ? null : semver.parse(minimum);
    if (!minimum || !parsed) return {};
    return {
      minimum,
      maximum:
        kind === "upToNextMajorVersion"
          ? `${parsed.major + 1}.0.0`
          : `${parsed.major}.${parsed.minor + 1}.0`,
    };
  }
  return {};
}

function remoteRequirementProof(
  requirement: PbxObject,
  requiredVersion: string,
): RemoteRequirementProof {
  const bounds = requirementBounds(requirement);
  if (bounds.exact) {
    return semver.valid(bounds.exact) && semver.gte(bounds.exact, requiredVersion)
      ? "compatible"
      : "incompatible";
  }
  if (!bounds.minimum || semver.valid(bounds.minimum) == null) return "needs-resolution";
  if (
    bounds.maximum &&
    (semver.valid(bounds.maximum) == null || !semver.gt(bounds.maximum, bounds.minimum))
  ) {
    return "incompatible";
  }
  if (semver.gte(bounds.minimum, requiredVersion)) return "compatible";
  if (
    bounds.maximum &&
    semver.valid(bounds.maximum) != null &&
    !semver.lt(requiredVersion, bounds.maximum)
  ) {
    return "incompatible";
  }
  return "needs-resolution";
}

function requirementAllowsVersion(requirement: PbxObject, version: string): boolean {
  if (semver.valid(version) == null) return false;
  const bounds = requirementBounds(requirement);
  if (bounds.exact) return semver.valid(bounds.exact) != null && semver.eq(version, bounds.exact);
  if (!bounds.minimum || semver.valid(bounds.minimum) == null) return false;
  if (semver.lt(version, bounds.minimum)) return false;
  return (
    !bounds.maximum || (semver.valid(bounds.maximum) != null && semver.lt(version, bounds.maximum))
  );
}

function packageResolvedPaths(
  root: string,
  projectPath: string,
  inspection: Awaited<ReturnType<typeof inspectIOSProject>>,
): string[] {
  const paths = new Set<string>([
    resolve(
      root,
      projectPath,
      "project.xcworkspace",
      "xcshareddata",
      "swiftpm",
      "Package.resolved",
    ),
  ]);
  for (const workspace of inspection.workspaces) {
    if (workspace.projectPaths.includes(projectPath)) {
      paths.add(resolve(root, workspace.path, "xcshareddata", "swiftpm", "Package.resolved"));
    }
  }
  return [...paths].sort();
}

async function resolvedClerkVersions(
  root: string,
  projectPath: string,
  inspection: Awaited<ReturnType<typeof inspectIOSProject>>,
): Promise<{ versions: string[]; unreadable: boolean }> {
  const versions: string[] = [];
  let unreadable = false;
  for (const path of packageResolvedPaths(root, projectPath, inspection)) {
    if (!(await pathIsSafelyWithinIOSRoot(root, path))) {
      unreadable = true;
      continue;
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      unreadable = true;
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PACKAGE_METADATA_BYTES) {
      unreadable = true;
      continue;
    }
    try {
      const document: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isRecord(document)) throw new Error("invalid Package.resolved root");
      const legacyObject = isRecord(document.object) ? document.object : undefined;
      const pins = Array.isArray(document.pins)
        ? document.pins
        : Array.isArray(legacyObject?.pins)
          ? legacyObject.pins
          : undefined;
      if (!pins) throw new Error("invalid Package.resolved pins");
      for (const pin of pins) {
        if (!isRecord(pin)) {
          unreadable = true;
          continue;
        }
        const location = asString(pin.location) ?? asString(pin.repositoryURL);
        const identity = (asString(pin.identity) ?? asString(pin.package))?.toLowerCase();
        const isClerkPin = location
          ? isClerkIOSRepository(location)
          : identity === "clerk-ios" || identity === "clerk";
        if (!isClerkPin) continue;
        const state = isRecord(pin.state) ? pin.state : undefined;
        const version = state ? asString(state.version) : undefined;
        if (!version || semver.valid(version) == null) unreadable = true;
        else versions.push(version);
      }
    } catch {
      unreadable = true;
    }
  }
  return { versions: [...new Set(versions)].sort(semver.compare), unreadable };
}

async function sdkProductCompatibilityBlocker(
  root: string,
  projectPath: string,
  inspection: Awaited<ReturnType<typeof inspectIOSProject>>,
  selectedPackage: VerifiedPackage,
  objects: PbxObjects,
  products: IOSSDKProduct[],
  requirePrebuiltAuthCompatibility: boolean,
): Promise<IOSSDKInstallBlocker | undefined> {
  const requiredVersion = requiredCompatibilityVersion(requirePrebuiltAuthCompatibility);
  const prefix = requirePrebuiltAuthCompatibility
    ? `ClerkKitUI's documented native components require clerk-ios ${requiredVersion} or newer.`
    : `${products.join(" and ")} ${products.length === 1 ? "requires" : "require"} clerk-ios ${requiredVersion} or newer.`;
  if (selectedPackage.kind === "local") {
    // Local package verification already proves the modern ClerkKit products
    // structurally. AuthView retains its stricter API-compatibility policy.
    if (!requirePrebuiltAuthCompatibility) return undefined;
    return {
      code: "incompatible-sdk",
      message: `${prefix} A local package's compiled target membership cannot be proven without executing its Package.swift manifest, so no source was changed. Use a compatible remote clerk-ios package or integrate AuthView manually.`,
    };
  }

  const requirement = objects[selectedPackage.id]?.requirement;
  if (!isRecord(requirement)) {
    return {
      code: "incompatible-sdk",
      message: `${prefix} The existing remote package requirement could not prove that version, so no source was changed.`,
    };
  }
  const proof = remoteRequirementProof(requirement, requiredVersion);
  if (proof === "compatible") return undefined;
  if (proof === "incompatible") {
    return {
      code: "incompatible-sdk",
      message: `${prefix} The existing remote package requirement excludes that version, so no source was changed. Update the package requirement and rerun clerk init.`,
    };
  }

  const resolved = await resolvedClerkVersions(root, projectPath, inspection);
  if (
    !resolved.unreadable &&
    resolved.versions.length > 0 &&
    resolved.versions.every(
      (version) =>
        semver.gte(version, requiredVersion) && requirementAllowsVersion(requirement, version),
    )
  ) {
    return undefined;
  }
  return {
    code: "incompatible-sdk",
    message: `${prefix} Neither the existing remote requirement nor a canonical Package.resolved file proves a compatible version, so no source was changed. Require or resolve clerk-ios ${requiredVersion} or newer, then rerun clerk init.`,
  };
}

function duplicateValue(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function stableObjectId(objects: PbxObjects, seed: string): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const id = new Bun.CryptoHasher("sha256")
      .update(`clerk-ios-sdk:${seed}:${attempt}`)
      .digest("hex")
      .slice(0, 24)
      .toUpperCase();
    if (!objects[id]) return id;
  }
  throw new Error("Could not allocate a deterministic Xcode object ID.");
}

function clerkProductName(object: PbxObject | undefined): IOSSDKProduct | undefined {
  if (object?.isa !== "XCSwiftPackageProductDependency") return undefined;
  const name = asString(object.productName);
  return PRODUCT_NAMES.find((productName) => productName === name);
}

function buildFilePlatformApplicability(
  object: PbxObject,
  platform: IOSNativePlatform,
): {
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
  const rawPlatformFilter = object.platformFilter;
  const platformFilter = asString(rawPlatformFilter);
  if (Object.hasOwn(object, "platformFilter") && platformFilter == null) {
    return { applies: false, recognized: false };
  }
  const filters = [...asStringArray(rawFilters), ...(platformFilter ? [platformFilter] : [])];
  if (filters.length === 0) return { applies: true, recognized: true };
  const recognized = filters.every((filter) =>
    /^(?:ios|iphone(?:os|simulator)?|maccatalyst|macos|tvos|watchos|xros|visionos|driverkit)$/i.test(
      filter,
    ),
  );
  if (!recognized) return { applies: false, recognized: false };
  const applies =
    platform === "ios"
      ? filters.some((filter) => /^(?:ios|iphone(?:os|simulator)?)$/i.test(filter))
      : filters.some((filter) => /^macos$/i.test(filter));
  return { applies, recognized: true };
}

function validateProductPackage(
  productId: string,
  objects: PbxObjects,
  verifiedPackageIds: Set<string>,
  unsafeLocalPackageIds: Set<string>,
): IOSSDKInstallBlocker | undefined {
  const product = objects[productId];
  const productName = clerkProductName(product);
  if (!productName) {
    return {
      code: "malformed-project",
      message: `The selected target contains an unreadable Swift package product dependency (${productId}).`,
    };
  }
  const packageId = asString(product?.package);
  if (!packageId) {
    return {
      code: "unattributed-product",
      message: `${productName} is not attributed to a Swift package reference, so it cannot be repaired automatically.`,
    };
  }
  if (!verifiedPackageIds.has(packageId)) {
    if (unsafeLocalPackageIds.has(packageId)) {
      return {
        code: "external-path",
        message: `${productName} points to a local package that cannot be verified safely inside the project root.`,
      };
    }
    return {
      code: "wrong-package",
      message: `${productName} points to a package other than a verified clerk-ios reference.`,
    };
  }
  return undefined;
}

function scanProductGraph(
  productName: IOSSDKProduct,
  targetProductIds: string[],
  frameworkFiles: string[],
  objects: PbxObjects,
  verifiedPackageIds: Set<string>,
  unsafeLocalPackageIds: Set<string>,
  platforms: IOSNativePlatform[],
): { graph?: ProductGraph; blocker?: IOSSDKInstallBlocker } {
  const targetMatches = targetProductIds.filter(
    (id) => clerkProductName(objects[id]) === productName,
  );
  if (targetMatches.length > 1) {
    return {
      blocker: {
        code: "duplicate-product",
        message: `The selected target contains more than one ${productName} product dependency.`,
      },
    };
  }

  const phaseMatches: Array<{
    buildFileId: string;
    productId: string;
    applies: IOSNativePlatform[];
  }> = [];
  for (const buildFileId of frameworkFiles) {
    const buildFile = objects[buildFileId];
    if (!buildFile || buildFile.isa !== "PBXBuildFile") {
      return {
        blocker: {
          code: "malformed-project",
          message: `The selected target's Frameworks phase contains a dangling build file (${buildFileId}).`,
        },
      };
    }
    const productId = asString(buildFile.productRef);
    if (productId && clerkProductName(objects[productId]) === productName) {
      const applicability = platforms.map((platform) => ({
        platform,
        ...buildFilePlatformApplicability(buildFile, platform),
      }));
      if (applicability.some((item) => !item.recognized)) {
        return {
          blocker: {
            code: "unsupported-project",
            message: `${productName} has an unrecognized platform filter in the selected target's Frameworks phase.`,
          },
        };
      }
      phaseMatches.push({
        buildFileId,
        productId,
        applies: applicability.filter((item) => item.applies).map((item) => item.platform),
      });
    }
  }
  for (const platform of platforms) {
    if (phaseMatches.filter((match) => match.applies.includes(platform)).length > 1) {
      return {
        blocker: {
          code: "duplicate-build-file",
          message: `The selected target links ${productName} more than once for ${
            platform === "macos" ? "macOS" : "iOS"
          } in its Frameworks phase.`,
        },
      };
    }
  }

  const targetProductId = targetMatches[0];
  const phaseProductIds = [...new Set(phaseMatches.map((match) => match.productId))];
  if (phaseProductIds.length > 1) {
    return {
      blocker: {
        code: "duplicate-product",
        message: `The selected target links more than one ${productName} product dependency.`,
      },
    };
  }
  const phaseProductId = phaseProductIds[0];
  if (targetProductId && phaseProductId && targetProductId !== phaseProductId) {
    return {
      blocker: {
        code: "duplicate-product",
        message: `The selected target declares and links different ${productName} dependencies.`,
      },
    };
  }
  const productId = targetProductId ?? phaseProductId;
  if (productId) {
    const blocker = validateProductPackage(
      productId,
      objects,
      verifiedPackageIds,
      unsafeLocalPackageIds,
    );
    if (blocker) return { blocker };
  }
  return {
    graph: {
      productId,
      inTarget: targetProductId != null,
      buildFileIds: Object.fromEntries(
        platforms.flatMap((platform) => {
          const match = phaseMatches.find((candidate) => candidate.applies.includes(platform));
          return match ? [[platform, match.buildFileId]] : [];
        }),
      ),
      hasAnyBuildFile: phaseMatches.length > 0,
    },
  };
}

function validateCandidateGraph(
  parts: ProjectParts,
  packageId: string,
  products: IOSSDKProduct[],
  platforms: IOSNativePlatform[],
): boolean {
  const packageReferences = strictStringArray(parts.projectObject, "packageReferences");
  const targetProducts = strictStringArray(parts.targetObject, "packageProductDependencies");
  const buildPhases = strictStringArray(parts.targetObject, "buildPhases");
  if (!packageReferences || !targetProducts || !buildPhases) return false;
  if (packageReferences.filter((id) => id === packageId).length !== 1) return false;

  const frameworkPhaseIds = buildPhases.filter(
    (id) => parts.objects[id]?.isa === "PBXFrameworksBuildPhase",
  );
  if (frameworkPhaseIds.length !== 1) return false;
  const frameworkFiles = strictStringArray(parts.objects[frameworkPhaseIds[0]!]!, "files");
  if (!frameworkFiles) return false;

  for (const productName of products) {
    const productIds: string[] = targetProducts.filter(
      (id) => clerkProductName(parts.objects[id]) === productName,
    );
    const productId = productIds[0];
    if (productIds.length !== 1 || !productId) return false;
    if (asString(parts.objects[productId]?.package) !== packageId) return false;
    for (const platform of platforms) {
      const linked = frameworkFiles.filter((buildFileId) => {
        const buildFile = parts.objects[buildFileId];
        if (!buildFile || buildFile.isa !== "PBXBuildFile") return false;
        const applicability = buildFilePlatformApplicability(buildFile, platform);
        return (
          asString(buildFile.productRef) === productId &&
          applicability.recognized &&
          applicability.applies
        );
      });
      if (linked.length !== 1) return false;
      const allLinkedProducts = frameworkFiles.filter((buildFileId) => {
        const buildFile = parts.objects[buildFileId];
        if (!buildFile || buildFile.isa !== "PBXBuildFile") return false;
        const linkedProduct = parts.objects[asString(buildFile.productRef) ?? ""];
        const applicability = buildFilePlatformApplicability(buildFile, platform);
        return (
          clerkProductName(linkedProduct) === productName &&
          applicability.recognized &&
          applicability.applies
        );
      });
      if (allLinkedProducts.length !== 1) return false;
    }
  }
  return true;
}

async function prepareInstall(options: IOSSDKInstallOptions): Promise<PreparedInstall> {
  const root = resolve(options.root);
  const suppliedProjectPath = options.projectPath.replaceAll("\\", "/");
  const minimumVersion = effectiveMinimumVersion(options);
  if (
    !options.targetId ||
    !suppliedProjectPath ||
    isAbsolute(options.projectPath) ||
    !suppliedProjectPath.endsWith(".xcodeproj") ||
    !validMinimumVersion(minimumVersion)
  ) {
    return blocked(
      options,
      root,
      suppliedProjectPath,
      "invalid-selection",
      "A selected root-relative .xcodeproj, target object ID, and valid minimum version are required.",
    );
  }

  const absoluteProjectPath = resolve(root, suppliedProjectPath);
  const projectPath = relativeIOSPath(root, absoluteProjectPath);
  const pbxprojPath = resolve(absoluteProjectPath, "project.pbxproj");
  if (
    !(await pathIsSafelyWithinIOSRoot(root, absoluteProjectPath)) ||
    !(await pathIsSafelyWithinIOSRoot(root, pbxprojPath))
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "external-path",
      `${projectPath}/project.pbxproj resolves outside the project root.`,
      { pbxprojPath },
    );
  }

  let info: Awaited<ReturnType<typeof lstat>>;
  let originalBuffer: Buffer;
  try {
    info = await lstat(pbxprojPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PBXPROJ_BYTES) {
      throw new Error("unsupported project file");
    }
    originalBuffer = await readFile(pbxprojPath);
  } catch {
    return blocked(
      options,
      root,
      projectPath,
      "unreadable-project",
      `${projectPath}/project.pbxproj is missing, too large, symlinked, or unreadable.`,
      { pbxprojPath },
    );
  }
  const originalBytes = new Uint8Array(originalBuffer);
  const originalHash = hashIOSFileBytes(originalBytes);
  const boundary = await prepareIOSFileMutationBoundary(root, pbxprojPath);
  if (!boundary) {
    return blocked(
      options,
      root,
      projectPath,
      "external-path",
      `${projectPath}/project.pbxproj moved outside its prepared project boundary.`,
    );
  }
  const source = {
    pbxprojPath,
    boundary,
    originalBytes,
    originalHash,
    mode: info.mode & 0o7777,
  };

  let originalText: string;
  let parsed: ReturnType<typeof parsePbxProject>;
  try {
    originalText = new TextDecoder("utf-8", { fatal: true }).decode(originalBuffer);
    parsed = parsePbxProject(originalText);
  } catch {
    return blocked(
      options,
      root,
      projectPath,
      "malformed-project",
      `${projectPath}/project.pbxproj could not be parsed safely.`,
      source,
    );
  }
  const parsedParts = projectParts(parsed, options.targetId);
  if (!parsedParts) {
    return blocked(
      options,
      root,
      projectPath,
      "target-not-found",
      `The selected target ${options.targetId} does not exist in ${projectPath}.`,
      source,
    );
  }
  if (
    parsedParts.targetObject.isa !== "PBXNativeTarget" ||
    asString(parsedParts.targetObject.productType) !== APP_PRODUCT_TYPE
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "target-not-found",
      `The selected object ${options.targetId} is not an application target.`,
      source,
    );
  }

  const inspection = await inspectIOSProject(root, {
    target: options.targetId,
    exhaustiveContainerDiscovery: true,
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const generator =
    inspection.generatedProject ?? (await generatedProjectKind(root, absoluteProjectPath));
  if (hasIncompleteIOSContainerDiscovery(inspection)) {
    return blocked(
      options,
      root,
      projectPath,
      "incomplete-container-discovery",
      "Complete local Xcode container discovery could not be proven.",
      source,
    );
  }
  if (inspection.selection.state === "ambiguous") {
    return blocked(
      options,
      root,
      projectPath,
      "ambiguous-target",
      `Target object ID ${options.targetId} is ambiguous in this project root.`,
      source,
    );
  }
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
      `The selected target ${options.targetId} is not a verified native Apple application target in ${projectPath}.`,
      source,
    );
  }
  const platform = inspection.selection.platform;
  const inspectedTarget = inspection.appTargets.find(
    (target) => target.id === options.targetId && target.projectPath === projectPath,
  );
  if (!inspectedTarget?.platformEvidenceComplete) {
    return blocked(
      options,
      root,
      projectPath,
      "unresolved-platform",
      "Resolve SDKROOT and SUPPORTED_PLATFORMS consistently across every selected-target build configuration before changing Swift package links.",
      source,
    );
  }
  const supportedPlatforms = canonicalPlatforms(inspectedTarget.supportedPlatforms);
  const requestedSupportedPlatforms = options.supportedPlatforms
    ? canonicalPlatforms(options.supportedPlatforms)
    : supportedPlatforms;
  if (
    supportedPlatforms.length === 0 ||
    requestedSupportedPlatforms.length !== supportedPlatforms.length ||
    requestedSupportedPlatforms.some((item, index) => item !== supportedPlatforms[index])
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "unresolved-platform",
      "The selected target's supported iOS and macOS platforms changed after this SDK plan was created.",
      source,
    );
  }
  if (options.platform && platform !== options.platform) {
    return blocked(
      options,
      root,
      projectPath,
      "target-not-found",
      `The selected target is no longer a verified ${
        options.platform === "macos" ? "macOS" : "iOS"
      } application target.`,
      source,
    );
  }
  options = { ...options, platform, supportedPlatforms };
  for (const supportedPlatform of supportedPlatforms) {
    const platformInspection =
      supportedPlatform === platform
        ? inspection
        : await inspectIOSProject(root, {
            target: options.targetId,
            exhaustiveContainerDiscovery: true,
            platform: supportedPlatform,
          });
    const platformTarget = platformInspection.appTargets.find(
      (target) => target.id === options.targetId && target.projectPath === projectPath,
    );
    if (
      hasIncompleteIOSContainerDiscovery(platformInspection) ||
      platformInspection.selection.state !== "selected" ||
      platformInspection.selection.targetId !== options.targetId ||
      platformInspection.selection.projectPath !== projectPath ||
      platformInspection.selection.platform !== supportedPlatform ||
      !platformTarget?.platformEvidenceComplete
    ) {
      return blocked(
        options,
        root,
        projectPath,
        "unresolved-platform",
        `The selected target's ${
          supportedPlatform === "macos" ? "macOS" : "iOS"
        } build settings could not be proven consistently across every configuration.`,
        source,
      );
    }
    if (
      platformTarget.configurations.length === 0 ||
      platformTarget.configurations.some(
        (configuration) =>
          configuration.deploymentTarget.state !== "resolved" ||
          !deploymentTargetMeetsClerkSDKFloor(
            configuration.deploymentTarget.value,
            supportedPlatform,
          ),
      )
    ) {
      const label = platformLabel(supportedPlatform);
      const minimum = CLERK_SDK_MINIMUM_DEPLOYMENT_TARGET[supportedPlatform];
      const setting =
        supportedPlatform === "macos" ? "MACOSX_DEPLOYMENT_TARGET" : "IPHONEOS_DEPLOYMENT_TARGET";
      return blocked(
        options,
        root,
        projectPath,
        "incompatible-sdk",
        `The Clerk Swift SDK requires ${label} ${minimum} or newer for every selected-target build configuration. Set ${setting} to ${minimum} or newer, make conditioned values consistent, then rerun clerk init.`,
        source,
      );
    }
  }

  // Parse a second model instead of structured-cloning. pbxproj data literals
  // can be Buffers, which structuredClone turns into writer-incompatible
  // Uint8Arrays under Bun.
  let model: ReturnType<typeof parsePbxProject>;
  try {
    model = parsePbxProject(originalText);
  } catch {
    return blocked(
      options,
      root,
      projectPath,
      "malformed-project",
      "The Xcode project could not be parsed into an isolated mutation model.",
      source,
    );
  }
  const parts = projectParts(model, options.targetId);
  if (!parts) {
    return blocked(
      options,
      root,
      projectPath,
      "malformed-project",
      "The Xcode project object graph could not be cloned safely.",
      source,
    );
  }
  const projectPackageIds = strictStringArray(parts.projectObject, "packageReferences");
  const targetProductIds = strictStringArray(parts.targetObject, "packageProductDependencies");
  const targetBuildPhases = strictStringArray(parts.targetObject, "buildPhases");
  if (!projectPackageIds || !targetProductIds || !targetBuildPhases) {
    return blocked(
      options,
      root,
      projectPath,
      "malformed-project",
      "The selected target has malformed package or build-phase reference lists.",
      source,
    );
  }
  if (duplicateValue(projectPackageIds)) {
    return blocked(
      options,
      root,
      projectPath,
      "duplicate-package",
      "The project packageReferences list contains a duplicate object ID.",
      source,
    );
  }
  if (duplicateValue(targetProductIds)) {
    return blocked(
      options,
      root,
      projectPath,
      "duplicate-product",
      "The selected target packageProductDependencies list contains a duplicate object ID.",
      source,
    );
  }
  if (duplicateValue(targetBuildPhases)) {
    return blocked(
      options,
      root,
      projectPath,
      "ambiguous-frameworks-phase",
      "The selected target buildPhases list contains a duplicate object ID.",
      source,
    );
  }
  if (
    projectPackageIds.some(
      (id) =>
        !parts.objects[id] ||
        !["XCRemoteSwiftPackageReference", "XCLocalSwiftPackageReference"].includes(
          parts.objects[id]!.isa ?? "",
        ),
    ) ||
    targetProductIds.some((id) => parts.objects[id]?.isa !== "XCSwiftPackageProductDependency") ||
    targetBuildPhases.some(
      (id) =>
        !parts.objects[id] || !(asString(parts.objects[id]!.isa) ?? "").endsWith("BuildPhase"),
    )
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "malformed-project",
      "The selected target contains a dangling or invalid package, product, or build-phase reference.",
      source,
    );
  }

  const packages = await verifiedPackages(root, absoluteProjectPath, parts.objects);
  if (packages.length > 1) {
    return blocked(
      options,
      root,
      projectPath,
      "ambiguous-package",
      "More than one verified clerk-ios package reference exists in this Xcode project.",
      source,
    );
  }
  const verifiedPackageIds = new Set(packages.map((item) => item.id));
  const unsafeLocalPackageIds = new Set<string>();
  for (const [id, object] of Object.entries(parts.objects)) {
    if (object.isa !== "XCLocalSwiftPackageReference") continue;
    const relativePath = asString(object.relativePath);
    if (
      !relativePath ||
      !(await pathIsSafelyWithinIOSRoot(
        root,
        resolve(dirname(absoluteProjectPath), relativePath, "Package.swift"),
      ))
    ) {
      unsafeLocalPackageIds.add(id);
    }
  }

  const frameworkPhaseIds = targetBuildPhases.filter(
    (id) => parts.objects[id]?.isa === "PBXFrameworksBuildPhase",
  );
  if (frameworkPhaseIds.length > 1) {
    return blocked(
      options,
      root,
      projectPath,
      "ambiguous-frameworks-phase",
      "The selected target contains more than one Frameworks build phase.",
      source,
    );
  }
  let frameworkPhaseId = frameworkPhaseIds[0];
  let frameworkFiles: string[] = [];
  if (frameworkPhaseId) {
    const files = strictStringArray(parts.objects[frameworkPhaseId]!, "files");
    if (!files) {
      return blocked(
        options,
        root,
        projectPath,
        "malformed-project",
        "The selected target's Frameworks build phase has a malformed files list.",
        source,
      );
    }
    if (duplicateValue(files)) {
      return blocked(
        options,
        root,
        projectPath,
        "duplicate-build-file",
        "The selected target's Frameworks build phase contains a duplicate build file.",
        source,
      );
    }
    frameworkFiles = files;
  }

  const graphs = new Map<IOSSDKProduct, ProductGraph>();
  const productBlockers: IOSSDKInstallBlocker[] = [];
  for (const productName of PRODUCT_NAMES) {
    const result = scanProductGraph(
      productName,
      targetProductIds,
      frameworkFiles,
      parts.objects,
      verifiedPackageIds,
      unsafeLocalPackageIds,
      supportedPlatforms,
    );
    if (result.blocker) {
      productBlockers.push(result.blocker);
    } else {
      graphs.set(productName, result.graph!);
    }
  }
  if (productBlockers.length > 0) {
    return {
      ...source,
      plan: makePlan(options, root, projectPath, "blocked", {
        blockers: productBlockers,
      }),
    };
  }

  const actions: string[] = [];
  const products = requestedProducts(options.includeClerkKitUI);
  let selectedPackage = packages[0];
  const packageWasPresent = selectedPackage != null;
  if (!selectedPackage) {
    const packageId = stableObjectId(
      parts.objects,
      `${parts.projectObjectId}:${options.targetId}:remote-package:${CLERK_REPOSITORY}`,
    );
    parts.objects[packageId] = {
      isa: "XCRemoteSwiftPackageReference",
      repositoryURL: CLERK_REPOSITORY,
      requirement: { kind: "upToNextMajorVersion", minimumVersion },
    };
    selectedPackage = { id: packageId, kind: "remote" };
    verifiedPackageIds.add(packageId);
    actions.push(`Add clerk-ios ${minimumVersion} or newer as a Swift package reference.`);
  } else if (selectedPackage.kind === "remote") {
    const packageObject = parts.objects[selectedPackage.id];
    if (!supportedRemoteRequirement(packageObject?.requirement)) {
      return blocked(
        options,
        root,
        projectPath,
        "unsupported-project",
        "The existing clerk-ios remote reference has no readable package requirement.",
        source,
      );
    }
  }

  if (packageWasPresent) {
    const compatibilityBlocker = await sdkProductCompatibilityBlocker(
      root,
      projectPath,
      inspection,
      selectedPackage,
      parts.objects,
      products,
      options.requirePrebuiltAuthCompatibility === true,
    );
    if (compatibilityBlocker) {
      return {
        ...source,
        plan: makePlan(options, root, projectPath, "blocked", {
          blockers: [compatibilityBlocker],
        }),
      };
    }
  }

  if (!projectPackageIds.includes(selectedPackage.id)) {
    parts.projectObject.packageReferences = [...projectPackageIds, selectedPackage.id];
    projectPackageIds.push(selectedPackage.id);
    actions.push("Attach the verified clerk-ios package reference to the Xcode project.");
  }

  const requiresFrameworkPhase = products.some((productName) =>
    supportedPlatforms.some((platform) => !graphs.get(productName)?.buildFileIds[platform]),
  );
  if (!frameworkPhaseId && requiresFrameworkPhase) {
    frameworkPhaseId = stableObjectId(
      parts.objects,
      `${parts.projectObjectId}:${options.targetId}:frameworks-phase`,
    );
    parts.objects[frameworkPhaseId] = {
      isa: "PBXFrameworksBuildPhase",
      buildActionMask: 2147483647,
      files: [],
      runOnlyForDeploymentPostprocessing: 0,
    };
    parts.targetObject.buildPhases = [...targetBuildPhases, frameworkPhaseId];
    frameworkFiles = [];
    actions.push("Create a Frameworks build phase for the selected target.");
  }

  for (const productName of products) {
    const graph = graphs.get(productName)!;
    let productId = graph.productId;
    if (!productId) {
      productId = stableObjectId(
        parts.objects,
        `${parts.projectObjectId}:${options.targetId}:product:${selectedPackage.id}:${productName}`,
      );
      parts.objects[productId] = {
        isa: "XCSwiftPackageProductDependency",
        package: selectedPackage.id,
        productName,
      };
    }
    if (!graph.inTarget) {
      const currentProducts = strictStringArray(parts.targetObject, "packageProductDependencies")!;
      parts.targetObject.packageProductDependencies = [...currentProducts, productId];
      actions.push(`Add ${productName} to the selected target's package products.`);
    }
    const missingPlatforms = supportedPlatforms.filter((platform) => !graph.buildFileIds[platform]);
    if (missingPlatforms.length > 0) {
      if (!frameworkPhaseId) {
        return blocked(
          options,
          root,
          projectPath,
          "unsupported-project",
          `A Frameworks phase could not be created for ${productName}.`,
          source,
        );
      }
      const phase = parts.objects[frameworkPhaseId]!;
      if (!graph.hasAnyBuildFile) {
        const buildFileId = stableObjectId(
          parts.objects,
          `${parts.projectObjectId}:${options.targetId}:build-file:${productId}`,
        );
        parts.objects[buildFileId] = {
          isa: "PBXBuildFile",
          productRef: productId,
        };
        const currentFiles = strictStringArray(phase, "files")!;
        phase.files = [...currentFiles, buildFileId];
        actions.push(`Link ${productName} in the selected target's Frameworks phase.`);
      } else {
        for (const missingPlatform of missingPlatforms) {
          const buildFileId = stableObjectId(
            parts.objects,
            `${parts.projectObjectId}:${options.targetId}:build-file:${productId}:${missingPlatform}`,
          );
          parts.objects[buildFileId] = {
            isa: "PBXBuildFile",
            productRef: productId,
            platformFilter: missingPlatform,
          };
          const currentFiles = strictStringArray(phase, "files")!;
          phase.files = [...currentFiles, buildFileId];
          actions.push(
            `Link ${productName} for ${
              missingPlatform === "macos" ? "macOS" : "iOS"
            } in the selected target's Frameworks phase.`,
          );
        }
      }
    }
  }

  if (actions.length === 0) {
    return {
      ...source,
      plan: makePlan(options, root, projectPath, "satisfied", {
        expectedPbxprojHash: originalHash,
      }),
    };
  }
  if (generator) {
    return blocked(
      options,
      root,
      projectPath,
      "generated-project",
      `This is a ${
        generator === "xcodegen" ? "XcodeGen" : "Tuist"
      } project; update its source manifest instead of generated project.pbxproj output.`,
      source,
    );
  }

  let candidate: string;
  let reparsed: ReturnType<typeof parsePbxProject>;
  try {
    candidate = buildPbxProject(model);
    reparsed = parsePbxProject(candidate);
  } catch {
    return blocked(
      options,
      root,
      projectPath,
      "unsupported-project",
      "The proposed Xcode project could not be serialized and reparsed safely.",
      source,
    );
  }
  if (!isDeepStrictEqual(reparsed, model)) {
    return blocked(
      options,
      root,
      projectPath,
      "unsupported-project",
      "Serializing this Xcode project would change unsupported object-graph data.",
      source,
    );
  }
  const candidateParts = projectParts(reparsed, options.targetId);
  if (
    !candidateParts ||
    !validateCandidateGraph(candidateParts, selectedPackage.id, products, supportedPlatforms)
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "unsupported-project",
      "The proposed Xcode project did not pass package-linkage validation.",
      source,
    );
  }

  const candidateBytes = new TextEncoder().encode(candidate);
  return {
    ...source,
    candidateBytes,
    candidateHash: hashIOSFileBytes(candidateBytes),
    plan: makePlan(options, root, projectPath, "ready", {
      actions,
      expectedPbxprojHash: originalHash,
    }),
  };
}

/** @internal Postcondition for a combined PBX project and Swift source transaction. */
export async function validateIOSSDKInstallPostcondition(
  plan: IOSSDKInstallPlan,
): Promise<boolean> {
  const absoluteProjectPath = resolve(plan.root, plan.projectPath);
  const pbxprojPath = resolve(absoluteProjectPath, "project.pbxproj");
  if (!(await pathIsSafelyWithinIOSRoot(plan.root, pbxprojPath))) return false;
  let parsed: ReturnType<typeof parsePbxProject>;
  try {
    parsed = parsePbxProject(await readFile(pbxprojPath, "utf8"));
  } catch {
    return false;
  }
  const parts = projectParts(parsed, plan.targetId);
  if (!parts) return false;
  const packages = await verifiedPackages(plan.root, absoluteProjectPath, parts.objects);
  const selectedPackage = packages[0];
  if (
    packages.length !== 1 ||
    !selectedPackage ||
    !validateCandidateGraph(parts, selectedPackage.id, plan.products, plan.supportedPlatforms)
  ) {
    return false;
  }

  const inspection = await inspectIOSProject(plan.root, {
    target: plan.targetId,
    exhaustiveContainerDiscovery: true,
    platform: plan.platform,
  });
  if (hasIncompleteIOSContainerDiscovery(inspection)) return false;
  if (inspection.generatedProject || (await generatedProjectKind(plan.root, absoluteProjectPath))) {
    return false;
  }
  if (
    inspection.selection.state !== "selected" ||
    inspection.selection.targetId !== plan.targetId ||
    inspection.selection.projectPath !== plan.projectPath ||
    inspection.selection.platform !== plan.platform
  ) {
    return false;
  }
  if (
    (await sdkProductCompatibilityBlocker(
      plan.root,
      plan.projectPath,
      inspection,
      selectedPackage,
      parts.objects,
      plan.products,
      plan.requirePrebuiltAuthCompatibility === true,
    )) != null
  ) {
    return false;
  }
  const target = inspection.appTargets.find(
    (item) => item.id === plan.targetId && item.projectPath === plan.projectPath,
  );
  if (
    !target?.platformEvidenceComplete ||
    !["remote", "local"].includes(target.packages.package) ||
    canonicalPlatforms(target.supportedPlatforms).join(",") !== plan.supportedPlatforms.join(",")
  ) {
    return false;
  }
  for (const platform of plan.supportedPlatforms) {
    const platformInspection =
      platform === plan.platform
        ? inspection
        : await inspectIOSProject(plan.root, {
            target: plan.targetId,
            exhaustiveContainerDiscovery: true,
            platform,
          });
    if (
      hasIncompleteIOSContainerDiscovery(platformInspection) ||
      platformInspection.selection.state !== "selected" ||
      platformInspection.selection.targetId !== plan.targetId ||
      platformInspection.selection.projectPath !== plan.projectPath ||
      platformInspection.selection.platform !== platform
    ) {
      return false;
    }
    const platformTarget = platformInspection.appTargets.find(
      (item) => item.id === plan.targetId && item.projectPath === plan.projectPath,
    );
    if (
      !platformTarget?.platformEvidenceComplete ||
      !plan.products.every((productName) =>
        productName === "ClerkKit"
          ? platformTarget.packages.clerkKit === "linked"
          : platformTarget.packages.clerkKitUI === "linked",
      )
    ) {
      return false;
    }
  }
  return true;
}

export async function planIOSSDKInstall(options: IOSSDKInstallOptions): Promise<IOSSDKInstallPlan> {
  return (await prepareInstall(options)).plan;
}

/**
 * An internal SDK preparation result for a larger iOS file transaction. The
 * ready case contains candidate PBX bytes and must not be logged or serialized.
 *
 * @internal
 */
export type PreparedIOSSDKInstallMutation =
  | { status: "blocked"; plan: IOSSDKInstallPlan }
  | { status: "stale"; plan: IOSSDKInstallPlan }
  | { status: "satisfied"; plan: IOSSDKInstallPlan }
  | {
      status: "ready";
      plan: IOSSDKInstallPlan;
      mutation: IOSExistingFileMutation;
    };

/**
 * Reprepares a serialized SDK plan and exposes its PBX mutation without writing
 * it so a caller can combine it with Swift source mutations.
 *
 * @internal The ready result contains candidate bytes.
 */
export async function prepareIOSSDKInstallMutation(
  plan: IOSSDKInstallPlan,
): Promise<PreparedIOSSDKInstallMutation> {
  if (plan.status === "blocked") return { status: "blocked", plan };

  const prepared = await prepareInstall({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    platform: plan.platform,
    supportedPlatforms: plan.supportedPlatforms,
    includeClerkKitUI: plan.products.includes("ClerkKitUI"),
    minimumVersion: plan.minimumVersion,
    requirePrebuiltAuthCompatibility: plan.requirePrebuiltAuthCompatibility,
  });
  if (!plan.expectedPbxprojHash || prepared.originalHash !== plan.expectedPbxprojHash) {
    return { status: "stale", plan };
  }
  if (prepared.plan.status === "blocked") {
    return { status: "blocked", plan: prepared.plan };
  }
  if (prepared.plan.status === "satisfied") {
    return { status: "satisfied", plan: prepared.plan };
  }
  if (
    !prepared.pbxprojPath ||
    !prepared.boundary ||
    !prepared.originalBytes ||
    !prepared.candidateBytes ||
    !prepared.candidateHash ||
    prepared.mode == null
  ) {
    return {
      status: "blocked",
      plan: makePlan(
        {
          root: plan.root,
          projectPath: plan.projectPath,
          targetId: plan.targetId,
          platform: plan.platform,
          supportedPlatforms: plan.supportedPlatforms,
          includeClerkKitUI: plan.products.includes("ClerkKitUI"),
          minimumVersion: plan.minimumVersion,
          requirePrebuiltAuthCompatibility: plan.requirePrebuiltAuthCompatibility,
        },
        plan.root,
        plan.projectPath,
        "blocked",
        {
          blockers: [
            {
              code: "unsupported-project",
              message: "The prepared install did not contain a validated candidate project.",
            },
          ],
        },
      ),
    };
  }

  const result = {
    status: "ready" as const,
    plan: prepared.plan,
  } as Extract<PreparedIOSSDKInstallMutation, { status: "ready" }>;
  Object.defineProperty(result, "mutation", {
    value: {
      path: prepared.pbxprojPath,
      boundary: prepared.boundary,
      originalBytes: prepared.originalBytes,
      originalHash: prepared.originalHash,
      candidateBytes: prepared.candidateBytes,
      candidateHash: prepared.candidateHash,
      mode: prepared.mode,
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

export async function applyIOSSDKInstall(
  plan: IOSSDKInstallPlan,
): Promise<IOSSDKInstallApplyResult> {
  const prepared = await prepareIOSSDKInstallMutation(plan);
  if (prepared.status === "stale") {
    return {
      status: "stale",
      plan,
      message: "The Xcode project changed after the install plan was created.",
    };
  }
  if (prepared.status === "blocked") {
    return { status: "blocked", plan: prepared.plan };
  }
  if (prepared.status === "satisfied") {
    return { status: "satisfied", plan: prepared.plan };
  }

  const writeResult = await applyIOSExistingFileTransaction(
    [prepared.mutation],
    [async () => validateIOSSDKInstallPostcondition(prepared.plan)],
  );
  if (writeResult.status === "stale") {
    return {
      status: "stale",
      plan,
      message: "The Xcode project changed while the install was being applied.",
    };
  }
  return writeResult.status === "applied"
    ? { status: "applied", plan: prepared.plan }
    : {
        status: "rolled-back",
        plan: prepared.plan,
        message:
          "The proposed Xcode change failed post-write validation and was restored byte-for-byte.",
      };
}

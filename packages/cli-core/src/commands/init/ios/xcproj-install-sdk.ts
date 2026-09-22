import { dirname, resolve } from "node:path";
import semver from "semver";
import { pathIsSafelyWithinIOSRoot } from "./discovery.ts";
import { localClerkIOSPackageIsStructurallyValid } from "./local-package.ts";
import { isClerkIOSRepository } from "./pbx.ts";
import type { IOSNativePlatform } from "./types.ts";
import {
  applyXCProjValue,
  parseXCProjSource,
  type XCProjBuildPhase,
  type XCProjRecord,
  type XCProjSwiftPackage,
  type XCProjTarget,
  xcprojPackages,
  xcprojRecord,
  resolveXCProjTargetBuildPhaseReference,
  xcprojString,
  xcprojStringArray,
  xcprojTargets,
} from "./xcproj.ts";

const APP_PRODUCT_TYPES = new Set(["application", "com.apple.product-type.application"]);
const CLERK_REPOSITORY = "https://github.com/clerk/clerk-ios";
const PRODUCT_NAMES = new Set(["ClerkKit", "ClerkKitUI"]);
const RECOGNIZED_PLATFORM_FILTERS = new Set([
  "ios",
  "macos",
  "maccatalyst",
  "tvos",
  "watchos",
  "xros",
  "visionos",
]);

export type XCProjSDKProduct = "ClerkKit" | "ClerkKitUI";

export type XCProjSDKInstallBlockerCode =
  | "target-not-found"
  | "ambiguous-target"
  | "ambiguous-package"
  | "external-path"
  | "duplicate-product"
  | "unattributed-product"
  | "wrong-package"
  | "ambiguous-frameworks-phase"
  | "incompatible-sdk"
  | "unsupported-project";

export interface XCProjSDKInstallOptions {
  root: string;
  /** Absolute path to the selected .xcodeproj wrapper. */
  projectPath: string;
  source: Uint8Array;
  targetId: string;
  products: XCProjSDKProduct[];
  supportedPlatforms: IOSNativePlatform[];
  minimumVersion: string;
  requiredCompatibilityVersion: string;
  requirePrebuiltAuthCompatibility: boolean;
  resolvedClerkVersions: { versions: string[]; unreadable: boolean };
}

export type XCProjSDKInstallPreparation =
  | {
      status: "blocked";
      blocker: { code: XCProjSDKInstallBlockerCode; message: string };
    }
  | { status: "satisfied" }
  | { status: "ready"; actions: string[]; candidateBytes: Uint8Array };

type VerifiedXCProjPackage =
  | {
      index: number;
      kind: "remote";
      identity: string;
      value: Extract<XCProjSwiftPackage, { kind: "remote" }>;
    }
  | {
      index: number;
      kind: "local";
      identity: string;
      value: Extract<XCProjSwiftPackage, { kind: "local" }>;
    };

interface ProductMember {
  index: number;
  product: XCProjSDKProduct;
  packageIdentity?: string;
  platforms?: string[];
}

function blocked(code: XCProjSDKInstallBlockerCode, message: string): XCProjSDKInstallPreparation {
  return { status: "blocked", blocker: { code, message } };
}

function packageIdentity(value: XCProjSwiftPackage): string {
  const source = value.kind === "remote" ? value.repository : value.path;
  const normalized = source.replaceAll("\\", "/").replace(/\/+$/, "");
  return (normalized.split("/").at(-1) ?? "").replace(/\.git$/i, "").toLowerCase();
}

async function verifiedPackages(options: XCProjSDKInstallOptions): Promise<{
  verified: VerifiedXCProjPackage[];
  unsafeLocalIdentity?: string;
}> {
  const packages = xcprojPackages(parseXCProjSource(options.source).root);
  const verified: VerifiedXCProjPackage[] = [];
  let unsafeLocalIdentity: string | undefined;
  for (const [index, item] of packages.entries()) {
    const identity = packageIdentity(item);
    if (item.kind === "remote") {
      if (isClerkIOSRepository(item.repository)) {
        verified.push({ index, kind: "remote", identity, value: item });
      }
      continue;
    }
    const absolutePackagePath = resolve(dirname(options.projectPath), item.path);
    if (!(await pathIsSafelyWithinIOSRoot(options.root, absolutePackagePath))) {
      if (identity === "clerk-ios" || identity === "clerk") unsafeLocalIdentity = identity;
      continue;
    }
    if (await localClerkIOSPackageIsStructurallyValid(options.root, absolutePackagePath)) {
      verified.push({ index, kind: "local", identity, value: item });
    }
  }
  return { verified, unsafeLocalIdentity };
}

type RequirementProof = "compatible" | "incompatible" | "needs-resolution";

function requirementProof(version: XCProjRecord | undefined, required: string): RequirementProof {
  if (!version) return "needs-resolution";
  const exact = typeof version.version === "string" ? version.version : undefined;
  if (exact) {
    return semver.valid(exact) && semver.gte(exact, required) ? "compatible" : "incompatible";
  }

  const major =
    typeof version["up-to-next-major-version"] === "string"
      ? version["up-to-next-major-version"]
      : undefined;
  const minor =
    typeof version["up-to-next-minor-version"] === "string"
      ? version["up-to-next-minor-version"]
      : undefined;
  const minimum = major ?? minor;
  if (minimum) {
    const parsed = semver.parse(minimum);
    if (!parsed) return "incompatible";
    if (semver.gte(minimum, required)) return "compatible";
    const maximum = major ? `${parsed.major + 1}.0.0` : `${parsed.major}.${parsed.minor + 1}.0`;
    return semver.lt(required, maximum) ? "needs-resolution" : "incompatible";
  }

  const compactRange =
    typeof version["version-range"] === "string" ? version["version-range"] : undefined;
  const compactBounds = compactRange?.split("..<", 2);
  const rangeMinimum =
    typeof version["version-range-min"] === "string"
      ? version["version-range-min"]
      : compactBounds?.length === 2
        ? compactBounds[0]
        : undefined;
  const rangeMaximum =
    typeof version["version-range-max"] === "string"
      ? version["version-range-max"]
      : compactBounds?.length === 2
        ? compactBounds[1]
        : undefined;
  if (rangeMinimum && rangeMaximum) {
    if (!semver.valid(rangeMinimum) || !semver.valid(rangeMaximum)) return "incompatible";
    if (semver.gte(rangeMinimum, required)) return "compatible";
    return semver.lt(required, rangeMaximum) ? "needs-resolution" : "incompatible";
  }

  // Branches, revisions, and any future range spelling need Package.resolved
  // evidence before this writer may add modern Clerk products.
  return "needs-resolution";
}

function requirementAllowsVersion(version: XCProjRecord | undefined, resolved: string): boolean {
  if (!version || !semver.valid(resolved)) return false;
  const exact = typeof version.version === "string" ? version.version : undefined;
  if (exact) return semver.valid(exact) != null && semver.eq(exact, resolved);
  const major =
    typeof version["up-to-next-major-version"] === "string"
      ? version["up-to-next-major-version"]
      : undefined;
  const minor =
    typeof version["up-to-next-minor-version"] === "string"
      ? version["up-to-next-minor-version"]
      : undefined;
  const minimum = major ?? minor;
  if (minimum) {
    const parsed = semver.parse(minimum);
    if (!parsed || semver.lt(resolved, minimum)) return false;
    const maximum = major ? `${parsed.major + 1}.0.0` : `${parsed.major}.${parsed.minor + 1}.0`;
    return semver.lt(resolved, maximum);
  }
  const compactRange =
    typeof version["version-range"] === "string" ? version["version-range"] : undefined;
  const compactBounds = compactRange?.split("..<", 2);
  const rangeMinimum =
    typeof version["version-range-min"] === "string"
      ? version["version-range-min"]
      : compactBounds?.length === 2
        ? compactBounds[0]
        : undefined;
  const rangeMaximum =
    typeof version["version-range-max"] === "string"
      ? version["version-range-max"]
      : compactBounds?.length === 2
        ? compactBounds[1]
        : undefined;
  return Boolean(
    rangeMinimum &&
    rangeMaximum &&
    semver.valid(rangeMinimum) &&
    semver.valid(rangeMaximum) &&
    semver.gte(resolved, rangeMinimum) &&
    semver.lt(resolved, rangeMaximum),
  );
}

function compatibilityBlocker(
  selectedPackage: VerifiedXCProjPackage,
  options: XCProjSDKInstallOptions,
): XCProjSDKInstallPreparation | undefined {
  const prefix = options.requirePrebuiltAuthCompatibility
    ? `ClerkKitUI's documented native components require clerk-ios ${options.requiredCompatibilityVersion} or newer.`
    : `${options.products.join(" and ")} ${options.products.length === 1 ? "requires" : "require"} clerk-ios ${options.requiredCompatibilityVersion} or newer.`;
  if (selectedPackage.kind === "local") {
    if (!options.requirePrebuiltAuthCompatibility) return undefined;
    return blocked(
      "incompatible-sdk",
      `${prefix} A local package's compiled target membership cannot be proven without executing its Package.swift manifest, so no source was changed. Use a compatible remote clerk-ios package or integrate AuthView manually.`,
    );
  }
  const proof = requirementProof(
    selectedPackage.value.version,
    options.requiredCompatibilityVersion,
  );
  if (proof === "compatible") return undefined;
  if (proof === "incompatible") {
    return blocked(
      "incompatible-sdk",
      `${prefix} The existing remote package requirement excludes that version, so no source was changed. Update the package requirement and rerun clerk init.`,
    );
  }
  const resolved = options.resolvedClerkVersions;
  if (
    !resolved.unreadable &&
    resolved.versions.length > 0 &&
    resolved.versions.every(
      (version) =>
        semver.gte(version, options.requiredCompatibilityVersion) &&
        requirementAllowsVersion(selectedPackage.value.version, version),
    )
  ) {
    return undefined;
  }
  return blocked(
    "incompatible-sdk",
    `${prefix} Neither the existing remote requirement nor a canonical Package.resolved file proves a compatible version, so no source was changed. Require or resolve clerk-ios ${options.requiredCompatibilityVersion} or newer, then rerun clerk init.`,
  );
}

function productMembers(target: XCProjTarget): ProductMember[] | XCProjSDKInstallPreparation {
  const rawMembers = target.raw["package-product-members"];
  if (rawMembers === undefined) return [];
  if (!Array.isArray(rawMembers)) {
    return blocked("unsupported-project", "The selected target has malformed package products.");
  }
  const result: ProductMember[] = [];
  for (const [index, value] of rawMembers.entries()) {
    const member = xcprojRecord(value);
    const productName = xcprojString(member["product-name"]);
    if (!PRODUCT_NAMES.has(productName)) continue;
    const packageValue = member.package;
    const buildPhase = xcprojRecord(member["build-phase"]);
    const phase = resolveXCProjTargetBuildPhaseReference(target, buildPhase["build-phase"]);
    if (!phase || phase.kind !== "frameworks") {
      return blocked(
        "ambiguous-frameworks-phase",
        `${productName} is attached to an unresolved or non-Frameworks build phase.`,
      );
    }
    const platforms =
      buildPhase.platforms === undefined
        ? undefined
        : xcprojStringArray(buildPhase.platforms).map((item) => item.toLowerCase());
    if (platforms?.some((item) => !RECOGNIZED_PLATFORM_FILTERS.has(item))) {
      return blocked(
        "unsupported-project",
        `${productName} has an unrecognized platform filter in the selected target's Frameworks phase.`,
      );
    }
    result.push({
      index,
      product: productName as XCProjSDKProduct,
      packageIdentity:
        packageValue === undefined ? undefined : xcprojString(packageValue).toLowerCase(),
      platforms,
    });
  }
  return result;
}

function appliesToPlatform(member: ProductMember, platform: IOSNativePlatform): boolean {
  return (
    member.platforms === undefined ||
    member.platforms.length === 0 ||
    member.platforms.includes(platform)
  );
}

function validateProductMembers(
  members: ProductMember[],
  selectedPackage: VerifiedXCProjPackage,
  platforms: IOSNativePlatform[],
): XCProjSDKInstallPreparation | undefined {
  for (const member of members) {
    if (member.packageIdentity && member.packageIdentity !== selectedPackage.identity) {
      return blocked(
        "wrong-package",
        `${member.product} points to a package other than the verified clerk-ios reference.`,
      );
    }
  }
  for (const product of PRODUCT_NAMES) {
    for (const platform of platforms) {
      if (
        members.filter(
          (member) => member.product === product && appliesToPlatform(member, platform),
        ).length > 1
      ) {
        return blocked(
          "duplicate-product",
          `The selected target links ${product} more than once for ${platform === "macos" ? "macOS" : "iOS"}.`,
        );
      }
    }
  }
  return undefined;
}

function memberValue(
  packageIdentity: string,
  product: XCProjSDKProduct,
  missingPlatforms: IOSNativePlatform[],
  allPlatforms: IOSNativePlatform[],
  buildPhaseReference: string,
): XCProjRecord {
  const buildPhase: XCProjRecord = { "build-phase": buildPhaseReference };
  if (missingPlatforms.length !== allPlatforms.length) buildPhase.platforms = missingPlatforms;
  return {
    package: packageIdentity,
    "product-name": product,
    "build-phase": buildPhase,
  };
}

function targetBuildPhaseReferenceValue(phase: XCProjBuildPhase): string {
  // Prefer object identity. When no ID exists, Xcode resolves the bare kind
  // only when that kind is unique; the caller proves that before writing.
  return phase.id ? `id:${phase.id}` : phase.kind;
}

/**
 * Plans the format-specific part of the Clerk SDK mutation for project.xcproj.
 * The caller owns target/platform inspection plus transactional installation.
 */
export async function prepareXCProjSDKInstall(
  options: XCProjSDKInstallOptions,
): Promise<XCProjSDKInstallPreparation> {
  const parsed = parseXCProjSource(options.source);
  const targets = xcprojTargets(parsed.root);
  const matches = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => target.id === options.targetId);
  if (matches.length > 1) {
    return blocked("ambiguous-target", `Target object ID ${options.targetId} is ambiguous.`);
  }
  const selected = matches[0];
  if (
    !selected ||
    !selected.target.productType ||
    !APP_PRODUCT_TYPES.has(selected.target.productType)
  ) {
    return blocked(
      "target-not-found",
      `The selected object ${options.targetId} is not an application target.`,
    );
  }

  const packages = xcprojPackages(parsed.root);
  const packageScan = await verifiedPackages(options);
  if (packageScan.verified.length > 1) {
    return blocked(
      "ambiguous-package",
      "More than one verified clerk-ios package reference exists in this Xcode project.",
    );
  }
  let selectedPackage = packageScan.verified[0];
  let candidate = parsed.source;
  const actions: string[] = [];
  if (!selectedPackage) {
    if (packageScan.unsafeLocalIdentity) {
      return blocked(
        "external-path",
        "A clerk-ios local package reference cannot be verified safely inside the project root.",
      );
    }
    const packageValue: XCProjRecord = {
      kind: "remote",
      repository: CLERK_REPOSITORY,
      version: { "up-to-next-major-version": options.minimumVersion },
    };
    candidate = applyXCProjValue(candidate, ["packages", packages.length], packageValue);
    selectedPackage = {
      index: packages.length,
      kind: "remote",
      identity: "clerk-ios",
      value: {
        kind: "remote",
        repository: CLERK_REPOSITORY,
        version: packageValue.version as XCProjRecord,
        traits: [],
        raw: packageValue,
      },
    };
    actions.push(`Add clerk-ios ${options.minimumVersion} or newer as a Swift package reference.`);
  } else {
    const compatibility = compatibilityBlocker(selectedPackage, options);
    if (compatibility) return compatibility;
  }

  const membersResult = productMembers(selected.target);
  if (!Array.isArray(membersResult)) return membersResult;
  const memberBlocker = validateProductMembers(
    membersResult,
    selectedPackage,
    options.supportedPlatforms,
  );
  if (memberBlocker) return memberBlocker;

  const missingProducts = options.products.map((product) => {
    const existing = membersResult.filter((member) => member.product === product);
    return {
      product,
      missingPlatforms: options.supportedPlatforms.filter(
        (platform) => !existing.some((member) => appliesToPlatform(member, platform)),
      ),
    };
  });
  const needsProductLink = missingProducts.some((item) => item.missingPlatforms.length > 0);
  let buildPhaseReference: string | undefined;
  const frameworksPhases = selected.target.buildPhases.filter(
    (phase) => phase.kind === "frameworks",
  );
  if (needsProductLink && frameworksPhases.length === 0) {
    const rawPhases = selected.target.raw["build-phases"];
    if (!Array.isArray(rawPhases)) {
      return blocked(
        "ambiguous-frameworks-phase",
        "The selected target's build phases could not be updated safely.",
      );
    }
    candidate = applyXCProjValue(
      candidate,
      ["targets", selected.index, "build-phases", rawPhases.length],
      "frameworks",
    );
    actions.push("Create a Frameworks build phase for the selected target.");
    buildPhaseReference = "frameworks";
  } else if (needsProductLink && frameworksPhases.length === 1) {
    buildPhaseReference = targetBuildPhaseReferenceValue(frameworksPhases[0]!);
  } else if (needsProductLink) {
    return blocked(
      "ambiguous-frameworks-phase",
      "The selected target has more than one Frameworks build phase, so Clerk cannot choose where to link the SDK safely.",
    );
  }

  let memberCount = Array.isArray(selected.target.raw["package-product-members"])
    ? selected.target.raw["package-product-members"].length
    : 0;
  for (const { product, missingPlatforms } of missingProducts) {
    if (missingPlatforms.length === 0) continue;
    if (!buildPhaseReference) {
      return blocked(
        "ambiguous-frameworks-phase",
        "The selected target's Frameworks build phase could not be referenced safely.",
      );
    }
    const value = memberValue(
      selectedPackage.identity,
      product,
      missingPlatforms,
      options.supportedPlatforms,
      buildPhaseReference,
    );
    if (memberCount === 0 && selected.target.raw["package-product-members"] === undefined) {
      candidate = applyXCProjValue(
        candidate,
        ["targets", selected.index, "package-product-members"],
        [value],
      );
    } else {
      candidate = applyXCProjValue(
        candidate,
        ["targets", selected.index, "package-product-members", memberCount],
        value,
      );
    }
    memberCount += 1;
    actions.push(`Add and link ${product} in the selected target's Frameworks phase.`);
  }

  if (actions.length === 0) return { status: "satisfied" };
  const candidateBytes = new TextEncoder().encode(candidate);
  if (
    !validateXCProjSDKInstallPostcondition(candidateBytes, {
      targetId: options.targetId,
      products: options.products,
      supportedPlatforms: options.supportedPlatforms,
      packageIdentity: selectedPackage.identity,
    })
  ) {
    return blocked(
      "unsupported-project",
      "The proposed Xcode project did not pass package-linkage validation.",
    );
  }
  return { status: "ready", actions, candidateBytes };
}

export function validateXCProjSDKInstallPostcondition(
  source: string | Uint8Array,
  options: {
    targetId: string;
    products: XCProjSDKProduct[];
    supportedPlatforms: IOSNativePlatform[];
    packageIdentity?: string;
  },
): boolean {
  try {
    const parsed = parseXCProjSource(source);
    const targets = xcprojTargets(parsed.root).filter((target) => target.id === options.targetId);
    if (
      targets.length !== 1 ||
      !targets[0] ||
      !APP_PRODUCT_TYPES.has(targets[0].productType ?? "")
    ) {
      return false;
    }
    const membersResult = productMembers(targets[0]);
    if (!Array.isArray(membersResult)) return false;
    const packages = xcprojPackages(parsed.root);
    const referencedIdentities = new Set(
      membersResult
        .flatMap((member) => (member.packageIdentity ? [member.packageIdentity] : []))
        .map((item) => item.toLowerCase()),
    );
    const clerkPackages = packages.filter((item) => {
      const identity = packageIdentity(item);
      if (options.packageIdentity) return identity === options.packageIdentity.toLowerCase();
      return (
        (item.kind === "remote" && isClerkIOSRepository(item.repository)) ||
        (item.kind === "local" && referencedIdentities.has(identity))
      );
    });
    if (clerkPackages.length !== 1) return false;
    const selectedPackage = clerkPackages[0]!;
    const identity = packageIdentity(selectedPackage);
    const verifiedPackage: VerifiedXCProjPackage =
      selectedPackage.kind === "remote"
        ? { index: 0, kind: "remote", identity, value: selectedPackage }
        : { index: 0, kind: "local", identity, value: selectedPackage };
    if (validateProductMembers(membersResult, verifiedPackage, options.supportedPlatforms)) {
      return false;
    }
    if (!targets[0].buildPhases.some((phase) => phase.kind === "frameworks")) return false;
    return options.products.every((product) =>
      options.supportedPlatforms.every((platform) =>
        membersResult.some(
          (member) => member.product === product && appliesToPlatform(member, platform),
        ),
      ),
    );
  } catch {
    return false;
  }
}

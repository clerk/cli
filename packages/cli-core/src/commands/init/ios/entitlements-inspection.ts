import { bundleIdentifiersEqual } from "../../../lib/apple-native-identity.ts";
import { resolveEntitlementsAbsolutePath, type EntitlementBuildContext } from "./build-settings.ts";
import { readBoundedRegularFile } from "./bounded-file.ts";
import { pathIsSafelyWithinIOSRoot, relativeIOSPath } from "./discovery.ts";
import { asString, isRecord } from "./pbx.ts";
import { parseIOSPlist } from "./plist.ts";
import type {
  IOSBuildConfiguration,
  IOSDiagnostic,
  IOSEntitlementsInspection,
  IOSNativePlatform,
  IOSSourceEvidence,
} from "./types.ts";

const APPLE_SIGN_IN_KEY = "com.apple.developer.applesignin";
const MAX_ENTITLEMENTS_BYTES = 2_000_000;

function appleEntitlementState(
  parsed: Record<string, unknown>,
): IOSEntitlementsInspection["signInWithAppleState"] {
  if (!Object.hasOwn(parsed, APPLE_SIGN_IN_KEY)) return "absent";
  const value = parsed[APPLE_SIGN_IN_KEY];
  return Array.isArray(value) && value.length === 1 && value[0] === "Default" ? "exact" : "invalid";
}

export async function inspectEntitlements(
  root: string,
  absolutePath: string,
  platform: IOSNativePlatform,
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
    const applicationIdentifier = asString(
      parsed[platform === "macos" ? "com.apple.application-identifier" : "application-identifier"],
    );
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

export async function attachEntitlements(
  root: string,
  projectPath: string,
  platform: IOSNativePlatform,
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
          platform,
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

export function expandEntitlementDomain(
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

import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import { pathIsSafelyWithinIOSRoot, relativeIOSPath } from "./discovery.ts";
import {
  hashIOSFileBytes,
  identitiesMatch,
  readRegularFileIdentity,
  type FileIdentity,
} from "./file-transaction.ts";
import { inspectIOSProject } from "./inspect.ts";
import { parseIOSPlist } from "./plist.ts";
import type { IOSAppTarget } from "./types.ts";

const LOCAL_SECRETS_FILENAME = "LocalSecrets.plist";
const MAX_LOCAL_SECRETS_BYTES = 1_000_000;
const PUBLISHABLE_KEY = "CLERK_PUBLISHABLE_KEY";

/**
 * The one legacy compatibility shape that Clerk can prove without changing the
 * user's source: the selected target's exact Quickstart-style LocalSecrets.plist
 * runtime sink.
 */
export interface IOSRuntimeKeyVerificationOptions {
  root: string;
  /** Project-root-relative path selected by the iOS inspector. */
  projectPath: string;
  targetId: string;
  /** Optional exact path copied from a previous inspection result. */
  localSecretsPath?: string;
}

export type IOSRuntimeKeyBlockerCode =
  | "invalid-selection"
  | "external-path"
  | "target-not-found"
  | "missing-local-secrets"
  | "unreadable-local-secrets"
  | "malformed-local-secrets"
  | "invalid-publishable-key"
  | "production-publishable-key"
  | "unproven-runtime-wiring";

export interface IOSRuntimeKeyBlocker {
  code: IOSRuntimeKeyBlockerCode;
  message: string;
}

/**
 * A read-only, serializable proof of which legacy runtime sink should be
 * compared after Clerk application linking. It never contains the locally
 * stored publishable key or plist bytes.
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

interface LocalSecretsSnapshot {
  path: string;
  identity: FileIdentity;
  hash: string;
  publishableKey: string;
  frontendApiHost: string;
  instanceType: "development" | "production";
}

interface PreparedRuntimeKeyVerification {
  plan: IOSRuntimeKeyVerificationPlan;
  snapshot?: LocalSecretsSnapshot;
}

function normalizedRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function resolveRelativePath(root: string, path: string): string {
  return resolve(root, ...normalizedRelativePath(path).split("/"));
}

function makePlan(
  options: IOSRuntimeKeyVerificationOptions,
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

function blocked(
  options: IOSRuntimeKeyVerificationOptions,
  root: string,
  projectPath: string,
  code: IOSRuntimeKeyBlockerCode,
  message: string,
  source: Partial<PreparedRuntimeKeyVerification> = {},
): PreparedRuntimeKeyVerification {
  return {
    plan: makePlan(options, root, projectPath, "blocked", {
      localSecretsPath: source.plan?.localSecretsPath,
      expectedLocalSecretsHash: source.plan?.expectedLocalSecretsHash,
      blockers: [{ code, message }],
    }),
  };
}

function blockedResult(
  plan: IOSRuntimeKeyVerificationPlan,
  code: IOSRuntimeKeyBlockerCode,
  message: string,
): IOSRuntimeKeyVerificationResult {
  return {
    status: "blocked",
    plan: {
      schemaVersion: 1,
      kind: "clerk-ios-runtime-key-verification",
      status: "blocked",
      root: plan.root,
      projectPath: plan.projectPath,
      targetId: plan.targetId,
      localSecretsPath: plan.localSecretsPath,
      expectedLocalSecretsHash: plan.expectedLocalSecretsHash,
      blockers: [{ code, message }],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeUTF8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parseLocalSecrets(bytes: Uint8Array): Record<string, unknown> | undefined {
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

function validatePublishableKey(value: unknown):
  | {
      value: string;
      frontendApiHost: string;
      instanceType: "development" | "production";
    }
  | undefined {
  if (typeof value !== "string" || value === "" || value.trim() !== value) return undefined;
  try {
    const decoded = decodePublishableKey(value);
    return {
      value,
      frontendApiHost: decoded.fapiHost,
      instanceType: decoded.instanceType,
    };
  } catch {
    return undefined;
  }
}

async function readLocalSecretsSnapshot(path: string): Promise<LocalSecretsSnapshot | undefined> {
  try {
    const beforeRead = await readRegularFileIdentity(path);
    const info = await lstat(path);
    if (
      !beforeRead ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_LOCAL_SECRETS_BYTES
    ) {
      return undefined;
    }

    const bytes = new Uint8Array(await readFile(path));
    const afterRead = await readRegularFileIdentity(path);
    if (!afterRead || !identitiesMatch(beforeRead, afterRead)) return undefined;

    const plist = parseLocalSecrets(bytes);
    const decodedKey = validatePublishableKey(plist?.[PUBLISHABLE_KEY]);
    if (!decodedKey || plist?.[PUBLISHABLE_KEY] !== decodedKey.value) return undefined;

    return {
      path,
      identity: afterRead,
      hash: hashIOSFileBytes(bytes),
      publishableKey: decodedKey.value,
      frontendApiHost: decodedKey.frontendApiHost,
      instanceType: decodedKey.instanceType,
    };
  } catch {
    return undefined;
  }
}

async function fileIsReadableXMLPlist(path: string): Promise<boolean> {
  try {
    const beforeRead = await readRegularFileIdentity(path);
    const info = await lstat(path);
    if (
      !beforeRead ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_LOCAL_SECRETS_BYTES
    ) {
      return false;
    }
    const bytes = new Uint8Array(await readFile(path));
    const afterRead = await readRegularFileIdentity(path);
    return Boolean(
      afterRead && identitiesMatch(beforeRead, afterRead) && parseLocalSecrets(bytes) !== undefined,
    );
  } catch {
    return false;
  }
}

async function snapshotStillMatches(snapshot: LocalSecretsSnapshot): Promise<boolean> {
  const current = await readLocalSecretsSnapshot(snapshot.path);
  return Boolean(
    current &&
    identitiesMatch(snapshot.identity, current.identity) &&
    current.hash === snapshot.hash,
  );
}

function hasProvenQuickstartWiring(target: IOSAppTarget | undefined): target is IOSAppTarget {
  if (!target || !target.swift.evidenceComplete) return false;
  const entryPoint = target.swift.entryPoints[0];
  const configureCall = target.swift.configureCalls[0];
  const sink = target.runtimeKeySinks[0];
  return (
    target.swift.entryPoints.length === 1 &&
    target.swift.configureCalls.length === 1 &&
    configureCall?.publishableKeyWiring === "local-secrets-loader" &&
    configureCall.localSecretsRuntimeBinding === "proven" &&
    configureCall.startupBinding === "app-init" &&
    configureCall.path === entryPoint?.path &&
    target.swift.localSecretsRuntimeBindings.length === 1 &&
    target.runtimeKeySinks.length === 1 &&
    sink?.kind === "local-secrets-plist" &&
    basename(normalizedRelativePath(sink.path)) === LOCAL_SECRETS_FILENAME
  );
}

async function prepareRuntimeKeyVerification(
  options: IOSRuntimeKeyVerificationOptions,
): Promise<PreparedRuntimeKeyVerification> {
  const root = resolve(options.root);
  const suppliedProjectPath = normalizedRelativePath(options.projectPath);
  const suppliedLocalSecretsPath =
    options.localSecretsPath == null ? undefined : normalizedRelativePath(options.localSecretsPath);

  if (
    !options.targetId ||
    !suppliedProjectPath ||
    isAbsolute(options.projectPath) ||
    isAbsolute(suppliedProjectPath) ||
    !suppliedProjectPath.endsWith(".xcodeproj") ||
    (suppliedLocalSecretsPath != null &&
      (isAbsolute(options.localSecretsPath!) ||
        isAbsolute(suppliedLocalSecretsPath) ||
        basename(suppliedLocalSecretsPath) !== LOCAL_SECRETS_FILENAME))
  ) {
    return blocked(
      options,
      root,
      suppliedProjectPath,
      "invalid-selection",
      "A root-relative Xcode project, application target, and optional exact LocalSecrets.plist path are required.",
    );
  }

  const absoluteProjectPath = resolveRelativePath(root, suppliedProjectPath);
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

  const inspection = await inspectIOSProject(root, {
    target: options.targetId,
    exhaustiveContainerDiscovery: true,
  });
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
  if (!hasProvenQuickstartWiring(selectedTarget)) {
    return blocked(
      options,
      root,
      projectPath,
      "unproven-runtime-wiring",
      "Read-only compatibility requires the exact Quickstart LocalSecrets.plist loader and one proven startup configure call.",
    );
  }

  const localSecretsRelativePath = normalizedRelativePath(selectedTarget.runtimeKeySinks[0]!.path);
  const absoluteLocalSecretsPath = resolveRelativePath(root, localSecretsRelativePath);
  const redactedSource = {
    plan: makePlan(options, root, projectPath, "ready", {
      localSecretsPath: localSecretsRelativePath,
    }),
  };

  if (
    basename(localSecretsRelativePath) !== LOCAL_SECRETS_FILENAME ||
    (suppliedLocalSecretsPath != null &&
      resolveRelativePath(root, suppliedLocalSecretsPath) !== absoluteLocalSecretsPath)
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "missing-local-secrets",
      "The selected target does not use the exact supported LocalSecrets.plist runtime sink.",
      redactedSource,
    );
  }
  if (!(await pathIsSafelyWithinIOSRoot(root, absoluteLocalSecretsPath))) {
    return blocked(
      options,
      root,
      projectPath,
      "external-path",
      "LocalSecrets.plist resolves outside the project root.",
      redactedSource,
    );
  }

  const snapshot = await readLocalSecretsSnapshot(absoluteLocalSecretsPath);
  if (!snapshot) {
    const code = (await fileIsReadableXMLPlist(absoluteLocalSecretsPath))
      ? "invalid-publishable-key"
      : "malformed-local-secrets";
    return blocked(
      options,
      root,
      projectPath,
      code,
      code === "invalid-publishable-key"
        ? "The proven LocalSecrets.plist sink does not contain one canonical publishable key that can be verified."
        : "LocalSecrets.plist must be an existing, regular, readable XML property-list dictionary.",
      redactedSource,
    );
  }

  const inspectedKey = inspection.localPublishableKey;
  if (
    !inspectedKey.evidenceComplete ||
    !inspectedKey.found ||
    inspectedKey.conflict ||
    inspectedKey.source !== localSecretsRelativePath ||
    inspectedKey.frontendApiHost !== snapshot.frontendApiHost ||
    inspectedKey.instanceType !== snapshot.instanceType
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "invalid-publishable-key",
      "The proven LocalSecrets.plist sink is not the one unambiguous runtime publishable-key source for the selected target.",
      redactedSource,
    );
  }

  return {
    plan: makePlan(options, root, projectPath, "ready", {
      localSecretsPath: localSecretsRelativePath,
      expectedLocalSecretsHash: snapshot.hash,
    }),
    snapshot,
  };
}

/**
 * Recognizes the existing Quickstart LocalSecrets pattern for post-link
 * comparison. This function never proposes a plist or .gitignore write.
 */
export async function planIOSRuntimeKeyVerification(
  options: IOSRuntimeKeyVerificationOptions,
): Promise<IOSRuntimeKeyVerificationPlan> {
  return (await prepareRuntimeKeyVerification(options)).plan;
}

/** Compares an already linked development key without retaining either key. */
export async function verifyIOSRuntimeKey(
  plan: IOSRuntimeKeyVerificationPlan,
  linkedPublishableKey: string,
): Promise<IOSRuntimeKeyVerificationResult> {
  if (plan.status === "blocked") return { status: "blocked", plan };
  if (
    plan.schemaVersion !== 1 ||
    plan.kind !== "clerk-ios-runtime-key-verification" ||
    !plan.localSecretsPath ||
    basename(normalizedRelativePath(plan.localSecretsPath)) !== LOCAL_SECRETS_FILENAME ||
    !plan.expectedLocalSecretsHash
  ) {
    return blockedResult(
      plan,
      "invalid-selection",
      "The runtime-key verification plan is incomplete or unsupported.",
    );
  }

  const linkedKey = validatePublishableKey(linkedPublishableKey);
  if (!linkedKey || linkedKey.value !== linkedPublishableKey) {
    return blockedResult(plan, "invalid-publishable-key", "A valid publishable key is required.");
  }
  if (linkedKey.instanceType !== "development") {
    return blockedResult(
      plan,
      "production-publishable-key",
      "Runtime-key verification accepts a development-instance key only.",
    );
  }

  const root = resolve(plan.root);
  const absoluteLocalSecretsPath = resolveRelativePath(root, plan.localSecretsPath);
  if (!(await pathIsSafelyWithinIOSRoot(root, absoluteLocalSecretsPath))) {
    return blockedResult(
      plan,
      "external-path",
      "LocalSecrets.plist resolves outside the project root.",
    );
  }
  const currentSnapshot = await readLocalSecretsSnapshot(absoluteLocalSecretsPath);
  if (!currentSnapshot || currentSnapshot.hash !== plan.expectedLocalSecretsHash) {
    return { status: "stale", plan };
  }

  const prepared = await prepareRuntimeKeyVerification({
    root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    localSecretsPath: plan.localSecretsPath,
  });
  if (prepared.plan.status === "blocked" || !prepared.snapshot) {
    return { status: "blocked", plan: prepared.plan };
  }
  if (
    prepared.plan.expectedLocalSecretsHash !== plan.expectedLocalSecretsHash ||
    !(await snapshotStillMatches(prepared.snapshot))
  ) {
    return { status: "stale", plan };
  }

  return {
    status: prepared.snapshot.publishableKey === linkedKey.value ? "matched" : "mismatched",
    plan,
  };
}

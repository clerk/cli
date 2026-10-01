import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  entitlementsBaseMutations,
  prepareEntitlementsFileMutations,
  sameEntitlementsPlanFiles,
  withHiddenEntitlementsMutations,
} from "./entitlements-mutations.ts";
import {
  bytesWithOptionalBOM,
  newEntitlementsBytes,
  appendEntitlementsEntry,
  literalKeyCount,
  decodeEntitlementsXML,
} from "./entitlements-xml.ts";
import { selectedIOSAppTarget as selectedTarget } from "./project-selection.ts";
import { selectIOSEntitlementsFiles } from "./entitlements-files.ts";
import { readBoundedRegularFile } from "./bounded-file.ts";
import { pathIsSafelyWithinIOSRoot, relativeIOSPath } from "./discovery.ts";
import {
  applyIOSFileTransaction,
  hashIOSFileBytes,
  type IOSFileMutation,
} from "./file-transaction.ts";
import {
  planIOSMissingEntitlementsSettings,
  validateIOSMissingEntitlementsSettingsPostcondition,
  type IOSMissingEntitlementsSettingsPlan,
} from "./entitlements-settings.ts";
import { inspectIOSProject } from "./inspect.ts";
import type { IOSValueResolution } from "./types.ts";

const APP_SANDBOX_KEY = "com.apple.security.app-sandbox";
const NETWORK_CLIENT_KEY = "com.apple.security.network.client";
const MAX_ENTITLEMENTS_BYTES = 1_000_000;

export type MacOSNetworkCapabilityBlockerCode =
  | "invalid-selection"
  | "unsupported-platform"
  | "unresolved-platform"
  | "unresolved-sandbox-setting"
  | "conflicting-sandbox-setting"
  | "unresolved-network-setting"
  | "conflicting-network-setting"
  | "missing-entitlements"
  | "unsafe-entitlements"
  | "unreadable-entitlements"
  | "unsupported-entitlements"
  | "conflicting-entitlement"
  | "stale-entitlements"
  | "invalid-plan";

export interface MacOSNetworkCapabilityBlocker {
  code: MacOSNetworkCapabilityBlockerCode;
  message: string;
}

export interface MacOSNetworkCapabilityPlanFile {
  /** Invocation-root-relative path. */
  path: string;
  operation: "create" | "modify";
  expectedHash?: string;
}

export interface MacOSNetworkCapabilityPlan {
  schemaVersion: 1;
  kind: "clerk-macos-network-capability";
  status: "ready" | "satisfied" | "blocked";
  root: string;
  projectPath: string;
  targetId: string;
  targetName?: string;
  files: MacOSNetworkCapabilityPlanFile[];
  missingEntitlementsSettings?: IOSMissingEntitlementsSettingsPlan;
  actions: string[];
  blockers: MacOSNetworkCapabilityBlocker[];
}

export interface MacOSNetworkCapabilityPlanOptions {
  root: string;
  /** Invocation-root-relative selected .xcodeproj path. */
  projectPath: string;
  targetId: string;
  /** Allows a synchronized app root to receive a new macOS entitlements file. */
  allowMissingEntitlementsCreation?: boolean;
}

export interface MacOSNetworkCapabilityPrepareOptions {
  /** Previously prepared candidates to compose with without exposing their bytes. */
  baseMutations?: readonly IOSFileMutation[];
}

export type PreparedMacOSNetworkCapabilityMutation =
  | { status: "satisfied"; plan: MacOSNetworkCapabilityPlan }
  | { status: "blocked"; plan: MacOSNetworkCapabilityPlan }
  | { status: "stale"; plan: MacOSNetworkCapabilityPlan }
  | {
      status: "ready";
      plan: MacOSNetworkCapabilityPlan;
      /** @internal Candidate bytes must never be serialized into output or telemetry. */
      mutations: IOSFileMutation[];
      /** Absolute caller-supplied candidates consumed by this preparation. */
      consumedBaseMutationPaths: string[];
    };

interface EntitlementsDocument {
  absolutePath: string;
  relativePath: string;
  bytes: Uint8Array;
  hash: string;
  mode: number;
  source: string;
  bom: boolean;
  appSandbox: BooleanEntitlementState;
  networkClient: BooleanEntitlementState;
}

type BooleanEntitlementState = "absent" | "true" | "false" | "invalid";

type EntitlementsInspection =
  | { status: "safe"; document: EntitlementsDocument }
  | { status: "blocked"; blocker: MacOSNetworkCapabilityBlocker };

type BooleanBuildSettingState = "missing" | "true" | "false" | "invalid";

function blocker(
  code: MacOSNetworkCapabilityBlockerCode,
  message: string,
): MacOSNetworkCapabilityBlocker {
  return { code, message };
}

function planBase(options: MacOSNetworkCapabilityPlanOptions) {
  return {
    schemaVersion: 1 as const,
    kind: "clerk-macos-network-capability" as const,
    root: resolve(options.root),
    projectPath: options.projectPath.replaceAll("\\", "/"),
    targetId: options.targetId,
  };
}

function blockedPlan(
  options: MacOSNetworkCapabilityPlanOptions,
  blockers: MacOSNetworkCapabilityBlocker[],
  targetName?: string,
): MacOSNetworkCapabilityPlan {
  return {
    ...planBase(options),
    status: "blocked",
    ...(targetName ? { targetName } : {}),
    files: [],
    actions: [],
    blockers,
  };
}

function blockPrepared(
  plan: MacOSNetworkCapabilityPlan,
  code: MacOSNetworkCapabilityBlockerCode,
  message: string,
): Extract<PreparedMacOSNetworkCapabilityMutation, { status: "blocked" }> {
  return {
    status: "blocked",
    plan: {
      ...plan,
      status: "blocked",
      files: [],
      actions: [],
      blockers: [blocker(code, message)],
    },
  };
}

function booleanBuildSetting(resolution: IOSValueResolution | undefined): BooleanBuildSettingState {
  if (!resolution || resolution.state === "missing") return "missing";
  if (resolution.state === "unresolved") return "invalid";
  const value = resolution.value.trim().toUpperCase();
  if (value === "YES") return "true";
  if (value === "NO") return "false";
  return "invalid";
}

function uniqueStates(states: readonly BooleanBuildSettingState[]): Set<BooleanBuildSettingState> {
  return new Set(states);
}

function booleanEntitlementState(
  source: string,
  parsed: Record<string, unknown>,
  key: string,
): BooleanEntitlementState {
  const present = Object.hasOwn(parsed, key);
  const count = literalKeyCount(source, key);
  if ((present && count !== 1) || (!present && count !== 0)) return "invalid";
  if (!present) return "absent";
  const value = parsed[key];
  if (value === true) return "true";
  if (value === false) return "false";
  return "invalid";
}

function inspectEntitlementsBytes(
  root: string,
  absolutePath: string,
  bytes: Uint8Array,
  mode: number,
): EntitlementsInspection {
  const relativePath = relativeIOSPath(root, absolutePath);
  try {
    if (bytes.byteLength > MAX_ENTITLEMENTS_BYTES) throw new Error("too large");
    if (new TextDecoder().decode(bytes.slice(0, 8)).startsWith("bplist")) {
      return {
        status: "blocked",
        blocker: blocker(
          "unsupported-entitlements",
          `${relativePath} must be a UTF-8 XML plist before automatic setup.`,
        ),
      };
    }
    const { source, bom, values: parsed } = decodeEntitlementsXML(bytes);
    const appSandbox = booleanEntitlementState(source, parsed, APP_SANDBOX_KEY);
    const networkClient = booleanEntitlementState(source, parsed, NETWORK_CLIENT_KEY);
    if (appSandbox === "invalid" || networkClient === "invalid") {
      return {
        status: "blocked",
        blocker: blocker(
          "unsupported-entitlements",
          `${relativePath} has malformed or non-literal macOS sandbox entitlements.`,
        ),
      };
    }
    return {
      status: "safe",
      document: {
        absolutePath,
        relativePath,
        bytes,
        hash: hashIOSFileBytes(bytes),
        mode,
        source,
        bom,
        appSandbox,
        networkClient,
      },
    };
  } catch {
    return {
      status: "blocked",
      blocker: blocker(
        "unreadable-entitlements",
        `${relativePath} could not be read as a bounded UTF-8 XML plist dictionary.`,
      ),
    };
  }
}

async function inspectEntitlementsFile(
  root: string,
  absolutePath: string,
): Promise<EntitlementsInspection> {
  if (!(await pathIsSafelyWithinIOSRoot(root, absolutePath))) {
    return {
      status: "blocked",
      blocker: blocker(
        "unsafe-entitlements",
        `${relativeIOSPath(root, absolutePath)} resolves outside the inspected project root.`,
      ),
    };
  }
  const read = await readBoundedRegularFile(absolutePath, MAX_ENTITLEMENTS_BYTES);
  if (read.status !== "ok") {
    return {
      status: "blocked",
      blocker: blocker(
        read.status === "too-large" ? "unsupported-entitlements" : "unreadable-entitlements",
        `${relativeIOSPath(root, absolutePath)} must be a regular XML plist no larger than 1 MB.`,
      ),
    };
  }
  try {
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsupported file");
    return inspectEntitlementsBytes(root, absolutePath, read.bytes, info.mode & 0o7777);
  } catch {
    return {
      status: "blocked",
      blocker: blocker(
        "unreadable-entitlements",
        `${relativeIOSPath(root, absolutePath)} could not be inspected safely.`,
      ),
    };
  }
}

function addBooleanEntitlement(source: string, key: string): string | undefined {
  if (literalKeyCount(source, key) !== 0) return undefined;
  return appendEntitlementsEntry(source, [`<key>${key}</key>`, "<true/>"]);
}

function preparedWithHiddenMutations(
  plan: MacOSNetworkCapabilityPlan,
  mutations: IOSFileMutation[],
  consumedBaseMutationPaths: string[],
): Extract<PreparedMacOSNetworkCapabilityMutation, { status: "ready" }> {
  return withHiddenEntitlementsMutations(
    {
      status: "ready" as const,
      plan,
      consumedBaseMutationPaths: [...consumedBaseMutationPaths].sort(),
    },
    mutations,
  );
}

function candidateWithNetwork(
  root: string,
  document: EntitlementsDocument,
  ensureAppSandbox: boolean,
): Uint8Array | undefined {
  if (document.networkClient === "false" || document.networkClient === "invalid") return undefined;
  if (document.appSandbox === "false" || document.appSandbox === "invalid") return undefined;
  let source = document.source;
  if (ensureAppSandbox && document.appSandbox === "absent") {
    const next = addBooleanEntitlement(source, APP_SANDBOX_KEY);
    if (!next) return undefined;
    source = next;
  }
  if (document.networkClient === "absent") {
    const next = addBooleanEntitlement(source, NETWORK_CLIENT_KEY);
    if (!next) return undefined;
    source = next;
  }
  const bytes = bytesWithOptionalBOM(source, document.bom);
  const inspected = inspectEntitlementsBytes(root, document.absolutePath, bytes, document.mode);
  return inspected.status === "safe" &&
    inspected.document.networkClient === "true" &&
    (!ensureAppSandbox || inspected.document.appSandbox === "true")
    ? bytes
    : undefined;
}

/** Plans only the outgoing-network requirement for a sandboxed native macOS target. */
export async function planMacOSNetworkCapability(
  options: MacOSNetworkCapabilityPlanOptions,
): Promise<MacOSNetworkCapabilityPlan> {
  const normalized = { ...options, root: resolve(options.root) };
  const inspection = await inspectIOSProject(normalized.root, {
    target: normalized.targetId,
    exhaustiveContainerDiscovery: true,
    platform: "macos",
  });
  const target = selectedTarget(inspection, normalized.projectPath, normalized.targetId);
  if (!target) {
    return blockedPlan(normalized, [
      blocker(
        "invalid-selection",
        "The selected native application target could not be resolved exactly.",
      ),
    ]);
  }
  if (!target.supportedPlatforms.includes("macos")) {
    return blockedPlan(
      normalized,
      [blocker("unsupported-platform", "The selected target does not support macOS.")],
      target.name,
    );
  }
  if (!target.platformEvidenceComplete || target.platform !== "macos") {
    return blockedPlan(
      normalized,
      [
        blocker(
          "unresolved-platform",
          "Resolve SDKROOT and SUPPORTED_PLATFORMS consistently across every selected-target build configuration before changing macOS capabilities.",
        ),
      ],
      target.name,
    );
  }
  if (target.configurations.length === 0) {
    return blockedPlan(
      normalized,
      [
        blocker(
          "unresolved-sandbox-setting",
          "The selected target has no inspectable build configurations.",
        ),
      ],
      target.name,
    );
  }

  const sandboxStates = target.configurations.map((configuration) =>
    booleanBuildSetting(configuration.appSandbox),
  );
  const sandboxSet = uniqueStates(sandboxStates);
  if (sandboxSet.has("invalid")) {
    return blockedPlan(
      normalized,
      [
        blocker(
          "unresolved-sandbox-setting",
          "ENABLE_APP_SANDBOX could not be resolved to YES, NO, or absence for every macOS build context.",
        ),
      ],
      target.name,
    );
  }
  if (sandboxSet.has("true") && sandboxSet.size > 1) {
    return blockedPlan(
      normalized,
      [
        blocker(
          "conflicting-sandbox-setting",
          "ENABLE_APP_SANDBOX differs across the selected target's build configurations.",
        ),
      ],
      target.name,
    );
  }

  const resolvedPaths = target.configurations.flatMap((configuration) =>
    configuration.entitlementsPath.state === "resolved"
      ? [configuration.entitlementsPath.value]
      : [],
  );
  const allEntitlementsMissing = target.configurations.every(
    (configuration) => configuration.entitlementsPath.state === "missing",
  );
  if (!allEntitlementsMissing && resolvedPaths.length !== target.configurations.length) {
    return blockedPlan(
      normalized,
      [
        blocker(
          "missing-entitlements",
          "macOS entitlements paths are mixed, unresolved, or only partially configured across build configurations.",
        ),
      ],
      target.name,
    );
  }

  let files: MacOSNetworkCapabilityPlanFile[] = [];
  let documents: EntitlementsDocument[] = [];
  if (!allEntitlementsMissing) {
    for (const configuredPath of new Set(resolvedPaths)) {
      const absolutePath = resolve(normalized.root, normalized.projectPath, "..", configuredPath);
      const inspected = await inspectEntitlementsFile(normalized.root, absolutePath);
      if (inspected.status === "blocked") {
        return blockedPlan(normalized, [inspected.blocker], target.name);
      }
      documents.push(inspected.document);
    }
    documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    files = documents.map((document) => ({
      path: document.relativePath,
      operation: "modify" as const,
      expectedHash: document.hash,
    }));
  }

  const hasExplicitSandboxNo = sandboxSet.has("false");
  const allSandboxBuildSettingsYes = sandboxSet.size === 1 && sandboxSet.has("true");
  const entitlementSandboxStates = new Set(documents.map((document) => document.appSandbox));
  if (
    entitlementSandboxStates.has("invalid") ||
    (entitlementSandboxStates.has("true") && entitlementSandboxStates.has("false")) ||
    (!allSandboxBuildSettingsYes &&
      entitlementSandboxStates.has("true") &&
      entitlementSandboxStates.has("absent"))
  ) {
    return blockedPlan(
      normalized,
      [
        blocker(
          "conflicting-entitlement",
          "The App Sandbox entitlement is malformed or differs across active macOS entitlements files.",
        ),
      ],
      target.name,
    );
  }
  if (allSandboxBuildSettingsYes && entitlementSandboxStates.has("false")) {
    return blockedPlan(
      normalized,
      [
        blocker(
          "conflicting-sandbox-setting",
          "ENABLE_APP_SANDBOX is YES but an active entitlement explicitly disables App Sandbox.",
        ),
      ],
      target.name,
    );
  }
  if (hasExplicitSandboxNo && entitlementSandboxStates.has("true")) {
    return blockedPlan(
      normalized,
      [
        blocker(
          "conflicting-sandbox-setting",
          "ENABLE_APP_SANDBOX is NO while an active entitlement enables App Sandbox.",
        ),
      ],
      target.name,
    );
  }

  const sandboxed = allSandboxBuildSettingsYes || entitlementSandboxStates.has("true");
  if (!sandboxed) {
    return {
      ...planBase(normalized),
      status: "satisfied",
      targetName: target.name,
      files: [],
      actions: [],
      blockers: [],
    };
  }

  const outgoingStates = target.configurations.map((configuration) =>
    booleanBuildSetting(configuration.outgoingNetworkConnections),
  );
  const outgoingSet = uniqueStates(outgoingStates);
  if (outgoingSet.has("invalid")) {
    return blockedPlan(
      normalized,
      [
        blocker(
          "unresolved-network-setting",
          "ENABLE_OUTGOING_NETWORK_CONNECTIONS could not be resolved to YES, NO, or absence for every macOS build context.",
        ),
      ],
      target.name,
    );
  }

  if (outgoingSet.has("false")) {
    return blockedPlan(
      normalized,
      [
        blocker(
          "conflicting-network-setting",
          "Outgoing network access is explicitly disabled in a sandboxed macOS configuration.",
        ),
      ],
      target.name,
    );
  }
  if (documents.some((document) => document.networkClient === "false")) {
    return blockedPlan(
      normalized,
      [
        blocker(
          "conflicting-entitlement",
          "An active entitlements file explicitly disables outgoing network access.",
        ),
      ],
      target.name,
    );
  }
  if (
    (outgoingSet.size === 1 && outgoingSet.has("true")) ||
    (documents.length > 0 && documents.every((document) => document.networkClient === "true"))
  ) {
    return {
      ...planBase(normalized),
      status: "satisfied",
      targetName: target.name,
      files,
      actions: [],
      blockers: [],
    };
  }

  if (allEntitlementsMissing) {
    if (!options.allowMissingEntitlementsCreation) {
      return blockedPlan(
        normalized,
        [
          blocker(
            "missing-entitlements",
            "The sandboxed macOS target has no entitlements file to receive outgoing network access.",
          ),
        ],
        target.name,
      );
    }
    const settingsPlan = await planIOSMissingEntitlementsSettings({
      root: normalized.root,
      projectPath: normalized.projectPath,
      targetId: normalized.targetId,
      platform: "macos",
    });
    if (settingsPlan.status !== "ready" || !settingsPlan.entitlementsPath) {
      return blockedPlan(
        normalized,
        settingsPlan.blockers.length > 0
          ? settingsPlan.blockers.map((item) => blocker("missing-entitlements", item.message))
          : [
              blocker(
                "missing-entitlements",
                "A safe macOS entitlements destination could not be prepared.",
              ),
            ],
        target.name,
      );
    }
    files = [{ path: settingsPlan.entitlementsPath, operation: "create" }];
    return {
      ...planBase(normalized),
      status: "ready",
      targetName: target.name,
      files,
      missingEntitlementsSettings: settingsPlan,
      actions: [
        `Create and attach ${settingsPlan.entitlementsPath} for macOS with App Sandbox and outgoing network access enabled.`,
      ],
      blockers: [],
    };
  }

  // Reuse this call's macOS settings view, as the domain planner does. File
  // ownership is still read here; preparation and postconditions replan afresh.
  const ownershipProbe = await selectIOSEntitlementsFiles(
    {
      root: normalized.root,
      projectPath: normalized.projectPath,
      targetId: normalized.targetId,
      platform: "macos",
    },
    inspection,
  );
  if (ownershipProbe.status === "blocked") {
    return blockedPlan(
      normalized,
      ownershipProbe.blockers.map((item) =>
        blocker(
          item.code === "shared-entitlements" ? "unsafe-entitlements" : "unsupported-entitlements",
          item.message,
        ),
      ),
      target.name,
    );
  }
  files = ownershipProbe.files.map((file) => ({
    path: file.path,
    operation: "modify" as const,
    ...(file.expectedHash ? { expectedHash: file.expectedHash } : {}),
  }));

  return {
    ...planBase(normalized),
    status: "ready",
    targetName: target.name,
    files,
    actions: ["Enable outgoing network access in every active macOS entitlements file."],
    blockers: [],
  };
}

export async function prepareMacOSNetworkCapabilityMutation(
  plan: MacOSNetworkCapabilityPlan,
  options: MacOSNetworkCapabilityPrepareOptions = {},
): Promise<PreparedMacOSNetworkCapabilityMutation> {
  if (plan.status === "blocked") return { status: "blocked", plan };
  if (
    plan.schemaVersion !== 1 ||
    plan.kind !== "clerk-macos-network-capability" ||
    resolve(plan.root) !== plan.root ||
    !plan.projectPath ||
    !plan.targetId
  ) {
    return blockPrepared(plan, "invalid-plan", "The serialized macOS network plan is incomplete.");
  }

  const baseByPath = await entitlementsBaseMutations(plan.root, options.baseMutations);
  if (!baseByPath) {
    return blockPrepared(
      plan,
      "invalid-plan",
      "A base mutation is invalid, duplicated, or outside the invocation root.",
    );
  }

  const replanned = await planMacOSNetworkCapability({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    allowMissingEntitlementsCreation: plan.missingEntitlementsSettings != null,
  });
  if (replanned.status === "blocked") return { status: "blocked", plan: replanned };
  if (
    replanned.status !== plan.status ||
    !sameEntitlementsPlanFiles(plan.files, replanned.files) ||
    Boolean(replanned.missingEntitlementsSettings) !== Boolean(plan.missingEntitlementsSettings)
  ) {
    return { status: "stale", plan };
  }
  if (plan.status === "satisfied") return { status: "satisfied", plan: replanned };

  const prepared = await prepareEntitlementsFileMutations<
    EntitlementsDocument,
    MacOSNetworkCapabilityBlocker
  >(plan, baseByPath, {
    inspectFile: inspectEntitlementsFile,
    inspectBytes: inspectEntitlementsBytes,
    newBytes: () =>
      newEntitlementsBytes([
        `<key>${APP_SANDBOX_KEY}</key>`,
        "<true/>",
        `<key>${NETWORK_CLIENT_KEY}</key>`,
        "<true/>",
      ]),
    edit(source, current, path) {
      const bytes = candidateWithNetwork(plan.root, source, current === undefined);
      return bytes
        ? { bytes }
        : {
            blocker: blocker(
              "conflicting-entitlement",
              current
                ? `${path} has a conflicting macOS sandbox capability.`
                : "The composed entitlements candidate conflicts with the required macOS sandbox capabilities.",
            ),
          };
    },
  });
  if (prepared.status === "invalid") {
    if (prepared.reason === "destination") return { status: "stale", plan };
    const messages = {
      creation: "The missing-entitlements macOS network plan is inconsistent.",
      project: "The selected Xcode project document is missing.",
      "base-project": "The base Xcode mutation must replace an existing project file.",
      settings: "The macOS entitlements build setting could not be prepared safely.",
      file: "A planned macOS entitlements file is invalid.",
    };
    return blockPrepared(plan, "invalid-plan", messages[prepared.reason]);
  }
  if (prepared.status === "blocked") {
    return blockPrepared(plan, prepared.blocker.code, prepared.blocker.message);
  }
  if (prepared.status !== "ready") return { status: prepared.status, plan };
  return preparedWithHiddenMutations(plan, prepared.mutations, prepared.consumedBaseMutationPaths);
}

export async function validatePreparedMacOSNetworkCapability(
  prepared: Extract<PreparedMacOSNetworkCapabilityMutation, { status: "ready" }>,
): Promise<boolean> {
  if (
    prepared.plan.missingEntitlementsSettings &&
    !(await validateIOSMissingEntitlementsSettingsPostcondition(
      prepared.plan.missingEntitlementsSettings,
    ))
  ) {
    return false;
  }
  const current = await planMacOSNetworkCapability({
    root: prepared.plan.root,
    projectPath: prepared.plan.projectPath,
    targetId: prepared.plan.targetId,
  });
  return current.status === "satisfied";
}

export async function applyMacOSNetworkCapability(plan: MacOSNetworkCapabilityPlan): Promise<{
  status: "applied" | "satisfied" | "blocked" | "stale" | "rolled-back";
  plan: MacOSNetworkCapabilityPlan;
}> {
  const prepared = await prepareMacOSNetworkCapabilityMutation(plan);
  if (prepared.status !== "ready") return { status: prepared.status, plan: prepared.plan };
  const result = await applyIOSFileTransaction(prepared.mutations, [
    async () => validatePreparedMacOSNetworkCapability(prepared),
  ]);
  return { status: result.status, plan: prepared.plan };
}

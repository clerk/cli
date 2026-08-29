import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { planIOSAssociatedDomain } from "./associated-domain.ts";
import { readBoundedRegularFile } from "./bounded-file.ts";
import { pathIsSafelyWithinIOSRoot, relativeIOSPath } from "./discovery.ts";
import {
  applyIOSFileTransaction,
  hashIOSFileBytes,
  prepareIOSFileMutationBoundary,
  type IOSCreateFileMutation,
  type IOSExistingFileMutation,
  type IOSFileMutation,
} from "./file-transaction.ts";
import {
  planIOSMissingEntitlementsSettings,
  prepareIOSMissingEntitlementsSettingsMutation,
  validateIOSMissingEntitlementsSettingsPostcondition,
  type IOSMissingEntitlementsSettingsPlan,
} from "./entitlements-settings.ts";
import { inspectIOSProject } from "./inspect.ts";
import { isRecord } from "./pbx.ts";
import { parseIOSPlist } from "./plist.ts";
import type { IOSAppTarget, IOSValueResolution } from "./types.ts";

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

function selectedTarget(
  inspection: Awaited<ReturnType<typeof inspectIOSProject>>,
  projectPath: string,
  targetId: string,
): IOSAppTarget | undefined {
  if (
    inspection.selection.state !== "selected" ||
    inspection.selection.projectPath !== projectPath ||
    inspection.selection.targetId !== targetId
  ) {
    return undefined;
  }
  return inspection.appTargets.find(
    (target) => target.projectPath === projectPath && target.id === targetId,
  );
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

function stripXMLCommentsPreservingOffsets(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length));
}

function literalKeyCount(source: string, key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...stripXMLCommentsPreservingOffsets(source).matchAll(
      new RegExp(`<key\\b[^>]*>\\s*${escaped}\\s*</key>`, "g"),
    ),
  ].length;
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
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.slice(3) : bytes);
    const parsed = parseIOSPlist(source);
    if (!isRecord(parsed)) throw new Error("plist root is not a dictionary");
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

function lineIndentAt(source: string, index: number): string {
  const start = source.lastIndexOf("\n", index - 1) + 1;
  return /^[\t ]*/.exec(source.slice(start, index))?.[0] ?? "";
}

function addBooleanEntitlement(source: string, key: string): string | undefined {
  if (literalKeyCount(source, key) !== 0) return undefined;
  const structural = stripXMLCommentsPreservingOffsets(source);
  const dictClose = structural.lastIndexOf("</dict>");
  if (dictClose < 0) return undefined;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const closingIndent = lineIndentAt(source, dictClose);
  const insertionPoint = dictClose - closingIndent.length;
  const firstKey = /<key\b/.exec(structural);
  const childIndent =
    firstKey?.index == null ? `${closingIndent}\t` : lineIndentAt(source, firstKey.index);
  const prefix = source.slice(0, insertionPoint).endsWith("\n") ? "" : newline;
  const insertion = `${prefix}${childIndent}<key>${key}</key>${newline}${childIndent}<true/>${newline}`;
  return `${source.slice(0, insertionPoint)}${insertion}${closingIndent}${source.slice(dictClose)}`;
}

function bytesWithOptionalBOM(source: string, bom: boolean): Uint8Array {
  const encoded = new TextEncoder().encode(source);
  if (!bom) return encoded;
  const bytes = new Uint8Array(encoded.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(encoded, 3);
  return bytes;
}

function newEntitlementsBytes(): Uint8Array {
  return new TextEncoder().encode(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `\t<key>${APP_SANDBOX_KEY}</key>`,
      "\t<true/>",
      `\t<key>${NETWORK_CLIENT_KEY}</key>`,
      "\t<true/>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
}

function isCreateMutation(mutation: IOSFileMutation): mutation is IOSCreateFileMutation {
  return "kind" in mutation && mutation.kind === "create";
}

function validBaseMutation(mutation: IOSFileMutation): boolean {
  return (
    isAbsolute(mutation.path) &&
    Number.isInteger(mutation.mode) &&
    mutation.mode >= 0 &&
    mutation.mode <= 0o7777 &&
    hashIOSFileBytes(mutation.candidateBytes) === mutation.candidateHash &&
    (isCreateMutation(mutation) ||
      hashIOSFileBytes(mutation.originalBytes) === mutation.originalHash)
  );
}

function preparedWithHiddenMutations(
  plan: MacOSNetworkCapabilityPlan,
  mutations: IOSFileMutation[],
  consumedBaseMutationPaths: string[],
): Extract<PreparedMacOSNetworkCapabilityMutation, { status: "ready" }> {
  const result = {
    status: "ready" as const,
    plan,
    consumedBaseMutationPaths: [...consumedBaseMutationPaths].sort(),
  } as Extract<PreparedMacOSNetworkCapabilityMutation, { status: "ready" }>;
  Object.defineProperty(result, "mutations", {
    value: mutations,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

function samePlanFiles(
  left: readonly MacOSNetworkCapabilityPlanFile[],
  right: readonly MacOSNetworkCapabilityPlanFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) =>
        file.path === right[index]?.path &&
        file.operation === right[index]?.operation &&
        file.expectedHash === right[index]?.expectedHash,
    )
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
  if (!target.platformEvidenceComplete) {
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
  if (target.platform !== "macos") {
    return blockedPlan(
      normalized,
      [
        blocker(
          "unsupported-platform",
          "The selected target is not a pure macOS application target.",
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
    const probe = await planIOSAssociatedDomain({
      root: normalized.root,
      projectPath: normalized.projectPath,
      targetId: normalized.targetId,
      deferToPublishableKey: true,
    });
    if (probe.status === "blocked") {
      return blockedPlan(
        normalized,
        probe.blockers.map((item) =>
          blocker(
            item.code === "shared-entitlements"
              ? "unsafe-entitlements"
              : "unsupported-entitlements",
            item.message,
          ),
        ),
        target.name,
      );
    }
    files = probe.files.map((file) => ({
      path: file.path,
      operation: "modify" as const,
      ...(file.expectedHash ? { expectedHash: file.expectedHash } : {}),
    }));
    for (const file of files) {
      const inspected = await inspectEntitlementsFile(
        normalized.root,
        resolve(normalized.root, file.path),
      );
      if (inspected.status === "blocked") {
        return blockedPlan(normalized, [inspected.blocker], target.name);
      }
      if (inspected.document.hash !== file.expectedHash) {
        return blockedPlan(
          normalized,
          [blocker("stale-entitlements", `${file.path} changed while setup was inspected.`)],
          target.name,
        );
      }
      documents.push(inspected.document);
    }
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

  const baseByPath = new Map<string, IOSFileMutation>();
  for (const mutation of options.baseMutations ?? []) {
    const path = resolve(mutation.path);
    if (
      path !== mutation.path ||
      baseByPath.has(path) ||
      !(await pathIsSafelyWithinIOSRoot(plan.root, path)) ||
      !validBaseMutation(mutation)
    ) {
      return blockPrepared(
        plan,
        "invalid-plan",
        "A base mutation is invalid, duplicated, or outside the invocation root.",
      );
    }
    baseByPath.set(path, mutation);
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
    !samePlanFiles(plan.files, replanned.files) ||
    Boolean(replanned.missingEntitlementsSettings) !== Boolean(plan.missingEntitlementsSettings)
  ) {
    return { status: "stale", plan };
  }
  if (plan.status === "satisfied") return { status: "satisfied", plan: replanned };

  const createFile = plan.files.find((file) => file.operation === "create");
  if (createFile) {
    if (
      plan.files.length !== 1 ||
      !plan.missingEntitlementsSettings ||
      createFile.path !== plan.missingEntitlementsSettings.entitlementsPath
    ) {
      return blockPrepared(
        plan,
        "invalid-plan",
        "The missing-entitlements macOS network plan is inconsistent.",
      );
    }
    const entitlementsPath = resolve(plan.root, createFile.path);
    const pbxprojPath = resolve(plan.root, plan.projectPath, "project.pbxproj");
    const baseEntitlements = baseByPath.get(entitlementsPath);
    const basePbx = baseByPath.get(pbxprojPath);
    if (baseEntitlements && !isCreateMutation(baseEntitlements)) return { status: "stale", plan };
    if (basePbx && isCreateMutation(basePbx)) {
      return blockPrepared(
        plan,
        "invalid-plan",
        "The base Xcode mutation must replace an existing project file.",
      );
    }
    const preparedSettings = await prepareIOSMissingEntitlementsSettingsMutation(
      plan.missingEntitlementsSettings,
      basePbx as IOSExistingFileMutation | undefined,
    );
    if (preparedSettings.status === "stale") return { status: "stale", plan };
    if (preparedSettings.status !== "ready") {
      return blockPrepared(
        plan,
        "invalid-plan",
        "The macOS entitlements build setting could not be prepared safely.",
      );
    }
    const boundary = await prepareIOSFileMutationBoundary(plan.root, entitlementsPath);
    const expectedParent = plan.missingEntitlementsSettings.expectedSynchronizedRootIdentity;
    const synchronizedRoot = plan.missingEntitlementsSettings.synchronizedRootPath;
    if (
      !boundary ||
      !expectedParent ||
      !synchronizedRoot ||
      dirname(entitlementsPath) !== resolve(plan.root, synchronizedRoot) ||
      boundary.parentIdentity.device !== expectedParent.device ||
      boundary.parentIdentity.inode !== expectedParent.inode
    ) {
      return { status: "stale", plan };
    }
    let createMutation: IOSCreateFileMutation;
    if (baseEntitlements) {
      if (!isDeepStrictEqual(baseEntitlements.boundary, boundary)) return { status: "stale", plan };
      const inspected = inspectEntitlementsBytes(
        plan.root,
        entitlementsPath,
        baseEntitlements.candidateBytes,
        baseEntitlements.mode,
      );
      if (inspected.status === "blocked")
        return blockPrepared(plan, inspected.blocker.code, inspected.blocker.message);
      const candidateBytes = candidateWithNetwork(plan.root, inspected.document, true);
      if (!candidateBytes) {
        return blockPrepared(
          plan,
          "conflicting-entitlement",
          "The composed entitlements candidate conflicts with the required macOS sandbox capabilities.",
        );
      }
      createMutation = {
        ...baseEntitlements,
        candidateBytes,
        candidateHash: hashIOSFileBytes(candidateBytes),
      };
    } else {
      const candidateBytes = newEntitlementsBytes();
      createMutation = {
        kind: "create",
        path: entitlementsPath,
        boundary,
        candidateBytes,
        candidateHash: hashIOSFileBytes(candidateBytes),
        mode: 0o644,
      };
    }
    return preparedWithHiddenMutations(
      plan,
      [createMutation, preparedSettings.mutation],
      [...(baseEntitlements ? [entitlementsPath] : []), ...(basePbx ? [pbxprojPath] : [])],
    );
  }

  const mutations: IOSExistingFileMutation[] = [];
  const consumed: string[] = [];
  for (const file of plan.files) {
    if (file.operation !== "modify" || !file.expectedHash) {
      return blockPrepared(plan, "invalid-plan", "A planned macOS entitlements file is invalid.");
    }
    const absolutePath = resolve(plan.root, file.path);
    const current = await inspectEntitlementsFile(plan.root, absolutePath);
    if (current.status === "blocked" || current.document.hash !== file.expectedHash) {
      return { status: "stale", plan };
    }
    const base = baseByPath.get(absolutePath);
    if (base && isCreateMutation(base)) return { status: "stale", plan };
    const boundary = await prepareIOSFileMutationBoundary(plan.root, absolutePath);
    if (!boundary || (base && !isDeepStrictEqual(base.boundary, boundary))) {
      return { status: "stale", plan };
    }
    if (
      base &&
      (base.originalHash !== file.expectedHash ||
        base.mode !== current.document.mode ||
        hashIOSFileBytes(base.originalBytes) !== current.document.hash)
    ) {
      return { status: "stale", plan };
    }
    const source = base
      ? inspectEntitlementsBytes(plan.root, absolutePath, base.candidateBytes, base.mode)
      : current;
    if (source.status === "blocked")
      return blockPrepared(plan, source.blocker.code, source.blocker.message);
    const candidateBytes = candidateWithNetwork(plan.root, source.document, false);
    if (!candidateBytes) {
      return blockPrepared(
        plan,
        "conflicting-entitlement",
        `${file.path} has a conflicting macOS sandbox capability.`,
      );
    }
    if (hashIOSFileBytes(candidateBytes) === current.document.hash && !base) continue;
    mutations.push({
      path: absolutePath,
      boundary: base?.boundary ?? boundary,
      originalBytes: base?.originalBytes ?? current.document.bytes,
      originalHash: base?.originalHash ?? current.document.hash,
      candidateBytes,
      candidateHash: hashIOSFileBytes(candidateBytes),
      mode: base?.mode ?? current.document.mode,
    });
    if (base) consumed.push(absolutePath);
  }
  if (mutations.length === 0) return { status: "satisfied", plan };
  return preparedWithHiddenMutations(plan, mutations, consumed);
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

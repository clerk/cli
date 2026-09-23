import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import {
  bytesWithOptionalBOM,
  newEntitlementsBytes,
  lineIndentAt,
  stripXMLCommentsPreservingOffsets,
  entitlementKeyStructure,
} from "./entitlements-xml.ts";
import { selectedIOSAppTarget as selectedTarget } from "./project-selection.ts";
import { readBoundedRegularFile } from "./bounded-file.ts";
import { relativeIOSPath } from "./discovery.ts";
import {
  applyIOSFileTransaction,
  hashIOSFileBytes,
  prepareIOSFileMutationBoundary,
  type IOSCreateFileMutation,
  type IOSExistingFileMutation,
  type IOSFileMutation,
} from "./file-transaction.ts";
import {
  prepareIOSMissingEntitlementsSettingsMutation,
  validateIOSMissingEntitlementsSettingsPostcondition,
  type IOSMissingEntitlementsSettingsPlan,
} from "./entitlements-settings.ts";
import { hasIncompleteIOSContainerDiscovery, inspectIOSProject } from "./inspect.ts";
import type { IOSAppTarget, IOSNativePlatform, IOSProjectInspectionResult } from "./types.ts";

import {
  inspectIOSEntitlementsFile,
  selectIOSEntitlementsFiles,
  type IOSEntitlementsFile,
  type IOSEntitlementsFileBlockerCode,
} from "./entitlements-files.ts";

const ASSOCIATED_DOMAINS_KEY = "com.apple.developer.associated-domains";
const MAX_ENTITLEMENTS_BYTES = 1_000_000;

export type IOSAssociatedDomainBlockerCode =
  | IOSEntitlementsFileBlockerCode
  | "runtime-key-unproven";

export interface IOSAssociatedDomainBlocker {
  code: IOSAssociatedDomainBlockerCode;
  message: string;
}

export interface IOSAssociatedDomainPlanFile {
  /** Invocation-root-relative path. */
  path: string;
  operation: "create" | "modify";
  expectedHash?: string;
}

export interface IOSAssociatedDomainPlan {
  schemaVersion: 1;
  kind: "clerk-ios-associated-domain";
  status: "ready" | "satisfied" | "blocked";
  root: string;
  projectPath: string;
  targetId: string;
  platform: IOSNativePlatform;
  targetName?: string;
  /** Public Frontend API hostname only. A publishable key is never retained. */
  expectedDomain?: string;
  /** True when the exact domain will be derived from the in-memory development key after auth. */
  requiresPublishableKey: boolean;
  files: IOSAssociatedDomainPlanFile[];
  /** PBX settings needed only when the target has no entitlements file yet. */
  missingEntitlementsSettings?: IOSMissingEntitlementsSettingsPlan;
  actions: string[];
  blockers: IOSAssociatedDomainBlocker[];
}

export interface IOSAssociatedDomainPlanOptions {
  root: string;
  /** Invocation-root-relative selected .xcodeproj path. */
  projectPath: string;
  targetId: string;
  /** Defaults to iOS. */
  platform?: IOSNativePlatform;
  /** A separately proven direct Swift configuration will supply the runtime key after auth. */
  deferToPublishableKey?: boolean;
  /** Allows the strict synchronized-root planner to create and attach a new file. */
  allowMissingEntitlementsCreation?: boolean;
  /** Capability planners may allow one selected target to share a file across its platforms. */
  allowSelectedTargetPlatformSharing?: boolean;
}

export type PreparedIOSAssociatedDomainMutation =
  | {
      status: "satisfied";
      plan: IOSAssociatedDomainPlan;
      expectedDomain: string;
    }
  | { status: "blocked"; plan: IOSAssociatedDomainPlan }
  | { status: "stale"; plan: IOSAssociatedDomainPlan }
  | {
      status: "ready";
      plan: IOSAssociatedDomainPlan;
      expectedDomain: string;
      /** @internal Candidate bytes must never be serialized into output or telemetry. */
      mutations: IOSFileMutation[];
      /** True when mutations contains the caller's PBX candidate after semantic composition. */
      consumesBasePbxMutation: boolean;
    };

export interface IOSAssociatedDomainApplyResult {
  status: "applied" | "satisfied" | "blocked" | "stale" | "rolled-back";
  plan: IOSAssociatedDomainPlan;
  message?: string;
}

interface EntitlementsFile extends IOSEntitlementsFile {
  domains: string[];
}

function blocker(
  code: IOSAssociatedDomainBlockerCode,
  message: string,
): IOSAssociatedDomainBlocker {
  return { code, message };
}

function blockedPlan(
  options: IOSAssociatedDomainPlanOptions,
  blockers: IOSAssociatedDomainBlocker[],
  targetName?: string,
): IOSAssociatedDomainPlan {
  return {
    schemaVersion: 1,
    kind: "clerk-ios-associated-domain",
    status: "blocked",
    root: resolve(options.root),
    projectPath: options.projectPath,
    targetId: options.targetId,
    platform: options.platform ?? "ios",
    ...(targetName ? { targetName } : {}),
    requiresPublishableKey: options.deferToPublishableKey === true,
    files: [],
    actions: [],
    blockers,
  };
}

function runtimeFrontendHost(
  inspection: IOSProjectInspectionResult,
  target: IOSAppTarget,
): string | undefined {
  const key = inspection.localPublishableKey;
  if (key.state !== "valid") return undefined;
  const source = key.source;
  const connected = target.swift.configureCalls.some(
    (call) =>
      call.startupBinding === "app-init" &&
      call.publishableKeyWiring === "inline-literal" &&
      call.path === source &&
      call.inlinePublishableKey?.state === "valid",
  );
  return connected ? key.frontendApiHost : undefined;
}

function hasUnresolvedDomain(value: string): boolean {
  return /\$\([^)]+\)|\$\{[^}]+\}/.test(value);
}

async function inspectEntitlementsFile(
  root: string,
  absolutePath: string,
): Promise<{ file?: EntitlementsFile; blocker?: IOSAssociatedDomainBlocker }> {
  const inspected = await inspectIOSEntitlementsFile(root, absolutePath);
  if (!inspected.file) return { blocker: inspected.blocker };
  const { file } = inspected;
  const source = file.source;
  const parsed = file.values;
  const rawDomains = parsed[ASSOCIATED_DOMAINS_KEY];
  const semanticKeyStructure = entitlementKeyStructure(source, ASSOCIATED_DOMAINS_KEY);
  const structuralKeyCount = semanticKeyStructure.literalCount;
  if (
    rawDomains !== undefined &&
    (!Array.isArray(rawDomains) || rawDomains.some((value) => typeof value !== "string"))
  ) {
    return {
      blocker: blocker(
        "unsupported-entitlements",
        `${relativeIOSPath(root, absolutePath)} has a non-string Associated Domains value.`,
      ),
    };
  }
  if (
    !semanticKeyStructure.safelyDecoded ||
    semanticKeyStructure.semanticCount > 1 ||
    structuralKeyCount > 1 ||
    (rawDomains !== undefined &&
      (structuralKeyCount !== 1 || semanticKeyStructure.semanticCount !== 1)) ||
    (rawDomains === undefined &&
      (structuralKeyCount !== 0 || semanticKeyStructure.semanticCount !== 0))
  ) {
    return {
      blocker: blocker(
        "unsupported-entitlements",
        `${relativeIOSPath(
          root,
          absolutePath,
        )} does not contain one safely editable literal Associated Domains key.`,
      ),
    };
  }
  const domains = (rawDomains as string[] | undefined) ?? [];
  if (domains.some(hasUnresolvedDomain)) {
    return {
      blocker: blocker(
        "unresolved-entitlements",
        `${relativeIOSPath(
          root,
          absolutePath,
        )} contains Associated Domains entries with unresolved build settings.`,
      ),
    };
  }
  return { file: { ...file, domains } };
}

export function associatedDomainMatches(actual: string, expected: string): boolean {
  const actualSeparator = actual.indexOf(":");
  const expectedSeparator = expected.indexOf(":");
  if (actualSeparator < 0 || expectedSeparator < 0) return false;

  const actualService = actual.slice(0, actualSeparator);
  const expectedService = expected.slice(0, expectedSeparator);
  if (actualService !== expectedService) return false;

  const splitHost = (value: string): [host: string, suffix: string] => {
    const suffixStart = value.search(/[/?#]/);
    return suffixStart < 0 ? [value, ""] : [value.slice(0, suffixStart), value.slice(suffixStart)];
  };
  const [actualHost, actualSuffix] = splitHost(actual.slice(actualSeparator + 1));
  const [expectedHost, expectedSuffix] = splitHost(expected.slice(expectedSeparator + 1));
  return actualHost.toLowerCase() === expectedHost.toLowerCase() && actualSuffix === expectedSuffix;
}

function exactDomainPresent(domains: readonly string[], expectedDomain: string): boolean {
  return domains.some((domain) => associatedDomainMatches(domain, expectedDomain));
}

/** Plans only the Associated Domains value after capability-neutral file selection. */
export async function planIOSAssociatedDomain(
  options: IOSAssociatedDomainPlanOptions,
): Promise<IOSAssociatedDomainPlan> {
  const root = resolve(options.root);
  const platform = options.platform ?? "ios";
  const inspection = await inspectIOSProject(root, {
    target: options.targetId,
    exhaustiveContainerDiscovery: true,
    platform,
  });
  const selection = await selectIOSEntitlementsFiles(options, inspection);
  if (selection.status === "blocked") {
    return blockedPlan(options, selection.blockers, selection.targetName);
  }
  const target = selectedTarget(inspection, options.projectPath, options.targetId)!;
  const host = runtimeFrontendHost(inspection, target);
  if (!host && !options.deferToPublishableKey) {
    return blockedPlan(
      options,
      [
        blocker(
          "runtime-key-unproven",
          "The exact Frontend API host is not connected to a proven selected-target runtime key.",
        ),
      ],
      target.name,
    );
  }
  const expectedDomain = host ? `webcredentials:${host}` : undefined;
  const files: EntitlementsFile[] = [];
  for (const selected of selection.files) {
    if (selected.operation === "create") continue;
    const inspected = await inspectEntitlementsFile(root, resolve(root, selected.path));
    if (inspected.blocker) return blockedPlan(options, [inspected.blocker], target.name);
    if (!inspected.file || inspected.file.hash !== selected.expectedHash) {
      return blockedPlan(
        options,
        [blocker("stale-entitlements", `${selected.path} changed while setup was inspected.`)],
        target.name,
      );
    }
    files.push(inspected.file);
  }
  const satisfied =
    expectedDomain != null &&
    selection.files.every((file) => file.operation === "modify") &&
    files.every((file) => exactDomainPresent(file.domains, expectedDomain));
  const settingsPlan = selection.missingEntitlementsSettings;
  return {
    schemaVersion: 1,
    kind: "clerk-ios-associated-domain",
    status: satisfied ? "satisfied" : "ready",
    root,
    projectPath: options.projectPath,
    targetId: options.targetId,
    platform,
    targetName: target.name,
    ...(expectedDomain ? { expectedDomain } : {}),
    requiresPublishableKey: expectedDomain == null,
    files: selection.files,
    ...(settingsPlan ? { missingEntitlementsSettings: settingsPlan } : {}),
    actions: satisfied
      ? []
      : settingsPlan
        ? [
            expectedDomain
              ? `Create ${settingsPlan.entitlementsPath} with ${expectedDomain}.`
              : `Create ${settingsPlan.entitlementsPath} with the linked development instance's exact webcredentials host (resolved after authentication).`,
            platform === "macos"
              ? `Attach ${settingsPlan.entitlementsPath} only to macOS SDK builds for every selected-target configuration.`
              : `Attach ${settingsPlan.entitlementsPath} only to iPhone and iPad SDK builds for every selected-target configuration.`,
          ]
        : [
            expectedDomain
              ? `Add ${expectedDomain} to every selected-target entitlements configuration.`
              : "Add the linked development instance's exact webcredentials host to every selected-target entitlements configuration (host resolved after authentication).",
          ],
    blockers: [],
  };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function addDomainToXML(source: string, expectedDomain: string): string | undefined {
  const structural = stripXMLCommentsPreservingOffsets(source);
  const keyMatches = [
    ...structural.matchAll(/<key\b[^>]*>\s*com\.apple\.developer\.associated-domains\s*<\/key>/g),
  ];
  if (keyMatches.length > 1) return undefined;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const encoded = xmlEscape(expectedDomain);

  const keyMatch = keyMatches[0];
  if (!keyMatch || keyMatch.index == null) {
    const dictClose = structural.lastIndexOf("</dict>");
    if (dictClose < 0) return undefined;
    const closingIndent = lineIndentAt(source, dictClose);
    const firstKey = /<key\b/.exec(structural);
    const childIndent =
      firstKey?.index == null ? `${closingIndent}\t` : lineIndentAt(source, firstKey.index);
    const startsOnOwnLine = source.slice(0, dictClose).endsWith("\n");
    const prefix = startsOnOwnLine ? "" : newline;
    const insertion = `${prefix}${childIndent}<key>${ASSOCIATED_DOMAINS_KEY}</key>${newline}${childIndent}<array>${newline}${childIndent}\t<string>${encoded}</string>${newline}${childIndent}</array>${newline}`;
    return `${source.slice(0, dictClose)}${insertion}${source.slice(dictClose)}`;
  }

  const afterKey = keyMatch.index + keyMatch[0].length;
  const tail = structural.slice(afterKey);
  const selfClosing = /^(\s*)(<array\b[^>]*\/\s*>)/.exec(tail);
  if (selfClosing) {
    const leading = selfClosing[1];
    const tag = selfClosing[2];
    if (leading == null || tag == null) return undefined;
    const start = afterKey + leading.length;
    const end = start + tag.length;
    const arrayIndent = lineIndentAt(source, start);
    const replacement = `<array>${newline}${arrayIndent}\t<string>${encoded}</string>${newline}${arrayIndent}</array>`;
    return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
  }
  const open = /^\s*<array\b[^>]*>/.exec(tail);
  if (!open) return undefined;
  const arrayStart = afterKey + (open.index ?? 0);
  const contentStart = arrayStart + open[0].length;
  const closeOffset = structural.slice(contentStart).indexOf("</array>");
  if (closeOffset < 0) return undefined;
  const close = contentStart + closeOffset;
  const arrayIndent = lineIndentAt(source, arrayStart);
  const existingContent = source.slice(contentStart, close);
  const closingLine = /\r?\n[\t ]*$/.exec(existingContent);
  if (closingLine?.index != null) {
    const insertionIndex = contentStart + closingLine.index;
    const insertion = `${newline}${arrayIndent}\t<string>${encoded}</string>`;
    return `${source.slice(0, insertionIndex)}${insertion}${source.slice(insertionIndex)}`;
  }
  // Preserve compact arrays as compact rather than moving their closing tag.
  const insertion = `<string>${encoded}</string>`;
  return `${source.slice(0, close)}${insertion}${source.slice(close)}`;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function preparedWithHiddenMutations(
  plan: IOSAssociatedDomainPlan,
  expectedDomain: string,
  mutations: IOSFileMutation[],
  consumesBasePbxMutation: boolean,
): Extract<PreparedIOSAssociatedDomainMutation, { status: "ready" }> {
  const result = {
    status: "ready" as const,
    plan,
    expectedDomain,
    consumesBasePbxMutation,
  } as Extract<PreparedIOSAssociatedDomainMutation, { status: "ready" }>;
  Object.defineProperty(result, "mutations", {
    value: mutations,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

export async function prepareIOSAssociatedDomainMutation(
  plan: IOSAssociatedDomainPlan,
  publishableKey?: string,
  options: { basePbxMutation?: IOSExistingFileMutation } = {},
): Promise<PreparedIOSAssociatedDomainMutation> {
  if (plan.status === "blocked") return { status: "blocked", plan };
  let expectedDomain = plan.expectedDomain;
  if (publishableKey) {
    try {
      const decoded = decodePublishableKey(publishableKey);
      if (decoded.instanceType !== "development") return { status: "blocked", plan };
      const fromKey = `webcredentials:${decoded.fapiHost}`;
      if (expectedDomain && expectedDomain !== fromKey) return { status: "blocked", plan };
      expectedDomain = fromKey;
    } catch {
      return { status: "blocked", plan };
    }
  }
  if (!expectedDomain || (plan.requiresPublishableKey && !publishableKey)) {
    return { status: "blocked", plan };
  }

  // Compare the exact authorized bytes before reparsing them. A concurrent
  // edit that also makes the plist malformed is still a stale plan, not a new
  // structural blocker, and the newer bytes must remain untouched.
  for (const plannedFile of plan.files) {
    const absolutePath = resolve(plan.root, plannedFile.path);
    if (plannedFile.operation === "create") {
      try {
        await lstat(absolutePath);
        return { status: "stale", plan };
      } catch (error) {
        if (!isMissingFileError(error)) return { status: "stale", plan };
      }
      continue;
    }
    if (!plannedFile.expectedHash) return { status: "blocked", plan };
    const current = await readBoundedRegularFile(absolutePath, MAX_ENTITLEMENTS_BYTES);
    if (current.status !== "ok" || hashIOSFileBytes(current.bytes) !== plannedFile.expectedHash) {
      return { status: "stale", plan };
    }
  }

  const replanned = await planIOSAssociatedDomain({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    platform: plan.platform,
    deferToPublishableKey: plan.requiresPublishableKey,
    allowMissingEntitlementsCreation: plan.missingEntitlementsSettings != null,
  });
  if (replanned.status === "blocked") return { status: "blocked", plan: replanned };
  if (
    replanned.status !== plan.status ||
    replanned.expectedDomain !== plan.expectedDomain ||
    replanned.requiresPublishableKey !== plan.requiresPublishableKey ||
    replanned.files.length !== plan.files.length ||
    replanned.files.some(
      (file, index) =>
        file.path !== plan.files[index]?.path ||
        file.operation !== plan.files[index]?.operation ||
        file.expectedHash !== plan.files[index]?.expectedHash,
    )
  ) {
    return { status: "stale", plan };
  }

  if (plan.missingEntitlementsSettings) {
    const plannedFile = plan.files[0];
    if (
      plan.files.length !== 1 ||
      plannedFile?.operation !== "create" ||
      plannedFile.path !== plan.missingEntitlementsSettings.entitlementsPath
    ) {
      return { status: "blocked", plan };
    }
    const preparedSettings = await prepareIOSMissingEntitlementsSettingsMutation(
      plan.missingEntitlementsSettings,
      options.basePbxMutation,
    );
    if (preparedSettings.status === "stale") return { status: "stale", plan };
    if (preparedSettings.status !== "ready") return { status: "blocked", plan };
    const expectedParentIdentity =
      plan.missingEntitlementsSettings.expectedSynchronizedRootIdentity;
    const synchronizedRootPath = plan.missingEntitlementsSettings.synchronizedRootPath;
    const createPath = resolve(plan.root, plannedFile.path);
    if (
      !expectedParentIdentity ||
      !synchronizedRootPath ||
      dirname(createPath) !== resolve(plan.root, synchronizedRootPath)
    ) {
      return { status: "blocked", plan };
    }
    const boundary = await prepareIOSFileMutationBoundary(plan.root, createPath);
    if (
      !boundary ||
      boundary.parentIdentity.device !== expectedParentIdentity.device ||
      boundary.parentIdentity.inode !== expectedParentIdentity.inode
    ) {
      return { status: "stale", plan };
    }
    const candidateBytes = newEntitlementsBytes([
      `<key>${ASSOCIATED_DOMAINS_KEY}</key>`,
      "<array>",
      `\t<string>${xmlEscape(expectedDomain)}</string>`,
      "</array>",
    ]);
    const createMutation: IOSCreateFileMutation = {
      kind: "create",
      path: createPath,
      boundary,
      candidateBytes,
      candidateHash: hashIOSFileBytes(candidateBytes),
      mode: 0o644,
    };
    return preparedWithHiddenMutations(
      plan,
      expectedDomain,
      // Commit the harmless new plist before project.pbxproj starts pointing
      // at it. The aggregate transaction still rolls both back on failure.
      [createMutation, preparedSettings.mutation],
      options.basePbxMutation != null,
    );
  }

  const mutations: IOSExistingFileMutation[] = [];
  for (const plannedFile of plan.files) {
    if (plannedFile.operation !== "modify" || !plannedFile.expectedHash) {
      return { status: "blocked", plan };
    }
    const absolutePath = resolve(plan.root, plannedFile.path);
    const inspected = await inspectEntitlementsFile(plan.root, absolutePath);
    if (!inspected.file || inspected.file.hash !== plannedFile.expectedHash) {
      return { status: "stale", plan };
    }
    if (exactDomainPresent(inspected.file.domains, expectedDomain)) continue;
    const candidateSource = addDomainToXML(inspected.file.source, expectedDomain);
    if (!candidateSource) return { status: "blocked", plan };
    const candidateBytes = bytesWithOptionalBOM(candidateSource, inspected.file.bom);
    const boundary = await prepareIOSFileMutationBoundary(plan.root, inspected.file.absolutePath);
    if (!boundary) return { status: "stale", plan };
    mutations.push({
      path: inspected.file.absolutePath,
      boundary,
      originalBytes: inspected.file.bytes,
      originalHash: inspected.file.hash,
      candidateBytes,
      candidateHash: hashIOSFileBytes(candidateBytes),
      mode: inspected.file.mode,
    });
  }
  if (mutations.length === 0) return { status: "satisfied", plan, expectedDomain };
  return preparedWithHiddenMutations(plan, expectedDomain, mutations, false);
}

export async function validatePreparedIOSAssociatedDomain(
  prepared: Extract<PreparedIOSAssociatedDomainMutation, { status: "ready" | "satisfied" }>,
): Promise<boolean> {
  if (
    prepared.plan.missingEntitlementsSettings &&
    !(await validateIOSMissingEntitlementsSettingsPostcondition(
      prepared.plan.missingEntitlementsSettings,
    ))
  ) {
    return false;
  }
  const inspection = await inspectIOSProject(prepared.plan.root, {
    target: prepared.plan.targetId,
    exhaustiveContainerDiscovery: true,
    platform: prepared.plan.platform,
  });
  if (hasIncompleteIOSContainerDiscovery(inspection)) return false;
  const target = selectedTarget(inspection, prepared.plan.projectPath, prepared.plan.targetId);
  if (!target?.platformEvidenceComplete) return false;
  const expectedHost = prepared.expectedDomain.slice("webcredentials:".length);
  if (
    !prepared.plan.requiresPublishableKey &&
    runtimeFrontendHost(inspection, target) !== expectedHost
  ) {
    return false;
  }
  const selection = await selectIOSEntitlementsFiles(
    {
      root: prepared.plan.root,
      projectPath: prepared.plan.projectPath,
      targetId: prepared.plan.targetId,
      platform: prepared.plan.platform,
    },
    inspection,
  );
  if (selection.status === "blocked") return false;
  // Other capabilities may change bytes, but not the approved domain's file set.
  if (JSON.stringify(selection.files.map((file) => file.path).sort()) !==
      JSON.stringify(prepared.plan.files.map((file) => file.path).sort())) return false;
  for (const file of selection.files) {
    const inspected = await inspectEntitlementsFile(
      prepared.plan.root,
      resolve(prepared.plan.root, file.path),
    );
    if (
      !inspected.file ||
      inspected.file.hash !== file.expectedHash ||
      !exactDomainPresent(inspected.file.domains, prepared.expectedDomain)
    )
      return false;
  }
  return true;
}

export async function applyIOSAssociatedDomain(
  plan: IOSAssociatedDomainPlan,
  publishableKey?: string,
): Promise<IOSAssociatedDomainApplyResult> {
  const prepared = await prepareIOSAssociatedDomainMutation(plan, publishableKey);
  if (prepared.status === "blocked") return { status: "blocked", plan: prepared.plan };
  if (prepared.status === "stale") return { status: "stale", plan: prepared.plan };
  if (prepared.status === "satisfied") return { status: "satisfied", plan: prepared.plan };
  const result = await applyIOSFileTransaction(prepared.mutations, [
    async () => validatePreparedIOSAssociatedDomain(prepared),
  ]);
  return { status: result.status, plan: prepared.plan };
}

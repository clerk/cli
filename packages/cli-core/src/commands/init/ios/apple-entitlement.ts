import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  planIOSAssociatedDomain,
  type IOSAssociatedDomainBlockerCode,
} from "./associated-domain.ts";
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
  prepareIOSMissingEntitlementsSettingsMutation,
  validateIOSMissingEntitlementsSettingsPostcondition,
  type IOSMissingEntitlementsSettingsPlan,
} from "./entitlements-settings.ts";
import { isRecord } from "./pbx.ts";
import { parseIOSPlist } from "./plist.ts";

const APPLE_SIGN_IN_KEY = "com.apple.developer.applesignin";
const APPLE_SIGN_IN_VALUE = "Default";
const MAX_ENTITLEMENTS_BYTES = 1_000_000;

export type IOSAppleEntitlementBlockerCode =
  | IOSAssociatedDomainBlockerCode
  | "conflicting-apple-entitlement"
  | "invalid-plan";

export interface IOSAppleEntitlementBlocker {
  code: IOSAppleEntitlementBlockerCode;
  message: string;
}

export interface IOSAppleEntitlementPlanFile {
  /** Invocation-root-relative path. */
  path: string;
  operation: "create" | "modify";
  expectedHash?: string;
}

export interface IOSAppleEntitlementPlan {
  schemaVersion: 1;
  kind: "clerk-ios-sign-in-with-apple-entitlement";
  status: "ready" | "satisfied" | "blocked";
  root: string;
  projectPath: string;
  targetId: string;
  targetName?: string;
  files: IOSAppleEntitlementPlanFile[];
  /** PBX settings needed only when the target has no entitlements file yet. */
  missingEntitlementsSettings?: IOSMissingEntitlementsSettingsPlan;
  actions: string[];
  blockers: IOSAppleEntitlementBlocker[];
}

export interface IOSAppleEntitlementPlanOptions {
  root: string;
  /** Invocation-root-relative selected .xcodeproj path. */
  projectPath: string;
  targetId: string;
  /** Allows the strict synchronized-root planner to create and attach a new file. */
  allowMissingEntitlementsCreation?: boolean;
}

export interface IOSAppleEntitlementPrepareOptions {
  /**
   * Previously prepared file candidates to compose with. Candidate bytes remain
   * private and must never be serialized into output or telemetry.
   */
  baseMutations?: readonly IOSFileMutation[];
}

export type PreparedIOSAppleEntitlementMutation =
  | { status: "satisfied"; plan: IOSAppleEntitlementPlan }
  | { status: "blocked"; plan: IOSAppleEntitlementPlan }
  | { status: "stale"; plan: IOSAppleEntitlementPlan }
  | {
      status: "ready";
      plan: IOSAppleEntitlementPlan;
      /** @internal Candidate bytes must never be serialized into output or telemetry. */
      mutations: IOSFileMutation[];
      /** Absolute paths whose caller-supplied candidates were semantically composed. */
      consumedBaseMutationPaths: string[];
    };

export interface IOSAppleEntitlementApplyResult {
  status: "applied" | "satisfied" | "blocked" | "stale" | "rolled-back";
  plan: IOSAppleEntitlementPlan;
}

interface EntitlementsDocument {
  absolutePath: string;
  relativePath: string;
  bytes: Uint8Array;
  hash: string;
  mode: number;
  source: string;
  bom: boolean;
  appleState: "absent" | "exact";
}

type EntitlementsInspection =
  | { status: "safe"; document: EntitlementsDocument }
  | { status: "blocked"; blocker: IOSAppleEntitlementBlocker };

function blocker(
  code: IOSAppleEntitlementBlockerCode,
  message: string,
): IOSAppleEntitlementBlocker {
  return { code, message };
}

function planBase(options: IOSAppleEntitlementPlanOptions) {
  return {
    schemaVersion: 1 as const,
    kind: "clerk-ios-sign-in-with-apple-entitlement" as const,
    root: resolve(options.root),
    projectPath: options.projectPath.replaceAll("\\", "/"),
    targetId: options.targetId,
  };
}

function blockedPlan(
  options: IOSAppleEntitlementPlanOptions,
  blockers: IOSAppleEntitlementBlocker[],
  targetName?: string,
): IOSAppleEntitlementPlan {
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
  plan: IOSAppleEntitlementPlan,
  code: IOSAppleEntitlementBlockerCode,
  message: string,
): Extract<PreparedIOSAppleEntitlementMutation, { status: "blocked" }> {
  return {
    status: "blocked",
    plan: {
      ...plan,
      status: "blocked",
      actions: [],
      blockers: [blocker(code, message)],
    },
  };
}

function stripXMLCommentsPreservingOffsets(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length));
}

function decodeXMLText(value: string): string | undefined {
  if (/[<>]/.test(value)) return undefined;
  let unsupported = false;
  const decoded = value.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi,
    (_entity, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (named === "amp") return "&";
      if (named === "lt") return "<";
      if (named === "gt") return ">";
      if (named === "quot") return '"';
      if (named === "apos") return "'";
      unsupported = true;
      return "";
    },
  );
  if (unsupported || /&[^;\s]*;/.test(decoded)) return undefined;
  return decoded;
}

function appleKeyStructure(source: string): {
  literalCount: number;
  semanticCount: number;
  safelyDecoded: boolean;
} {
  const structural = stripXMLCommentsPreservingOffsets(source);
  const literalCount = [
    ...structural.matchAll(/<key\b[^>]*>\s*com\.apple\.developer\.applesignin\s*<\/key>/g),
  ].length;
  let semanticCount = 0;
  let safelyDecoded = true;
  for (const match of structural.matchAll(/<key\b[^>]*>([\s\S]*?)<\/key>/g)) {
    const decoded = decodeXMLText(match[1] ?? "");
    if (decoded == null) {
      safelyDecoded = false;
      continue;
    }
    if (decoded.trim() === APPLE_SIGN_IN_KEY) semanticCount += 1;
  }
  return { literalCount, semanticCount, safelyDecoded };
}

function inspectEntitlementsBytes(
  root: string,
  absolutePath: string,
  bytes: Uint8Array,
  mode: number,
): EntitlementsInspection {
  const relativePath = relativeIOSPath(root, absolutePath);
  try {
    if (bytes.byteLength > MAX_ENTITLEMENTS_BYTES) {
      return {
        status: "blocked",
        blocker: blocker(
          "unsupported-entitlements",
          `${relativePath} must be an XML plist no larger than 1 MB.`,
        ),
      };
    }
    if (new TextDecoder().decode(bytes.slice(0, 8)).startsWith("bplist")) {
      return {
        status: "blocked",
        blocker: blocker(
          "unsupported-entitlements",
          `${relativePath} is a binary plist. Save it as XML before automatic setup.`,
        ),
      };
    }
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.slice(3) : bytes);
    const parsed = parseIOSPlist(source);
    if (!isRecord(parsed)) throw new Error("plist root is not a dictionary");
    const rawValue = parsed[APPLE_SIGN_IN_KEY];
    const structure = appleKeyStructure(source);
    if (
      !structure.safelyDecoded ||
      structure.literalCount > 1 ||
      structure.semanticCount > 1 ||
      (rawValue !== undefined && (structure.literalCount !== 1 || structure.semanticCount !== 1)) ||
      (rawValue === undefined && (structure.literalCount !== 0 || structure.semanticCount !== 0))
    ) {
      return {
        status: "blocked",
        blocker: blocker(
          "unsupported-entitlements",
          `${relativePath} does not contain one safely editable literal Sign in with Apple key.`,
        ),
      };
    }
    if (rawValue !== undefined) {
      if (
        !Array.isArray(rawValue) ||
        rawValue.length !== 1 ||
        rawValue[0] !== APPLE_SIGN_IN_VALUE
      ) {
        return {
          status: "blocked",
          blocker: blocker(
            "conflicting-apple-entitlement",
            `${relativePath} has a conflicting Sign in with Apple entitlement; expected exactly ["Default"].`,
          ),
        };
      }
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
        appleState: rawValue === undefined ? "absent" : "exact",
      },
    };
  } catch {
    return {
      status: "blocked",
      blocker: blocker(
        "unreadable-entitlements",
        `${relativePath} could not be read as a UTF-8 XML plist dictionary.`,
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
  const file = await readBoundedRegularFile(absolutePath, MAX_ENTITLEMENTS_BYTES);
  if (file.status === "not-regular" || file.status === "too-large") {
    return {
      status: "blocked",
      blocker: blocker(
        "unsupported-entitlements",
        `${relativeIOSPath(root, absolutePath)} must be a regular, non-symlink XML plist no larger than 1 MB.`,
      ),
    };
  }
  if (file.status !== "ok") {
    return {
      status: "blocked",
      blocker: blocker(
        "unreadable-entitlements",
        `${relativeIOSPath(root, absolutePath)} could not be read as a UTF-8 XML plist dictionary.`,
      ),
    };
  }
  return inspectEntitlementsBytes(root, absolutePath, file.bytes, file.mode);
}

function lineIndentAt(source: string, index: number): string {
  const start = source.lastIndexOf("\n", index - 1) + 1;
  return /^[\t ]*/.exec(source.slice(start, index))?.[0] ?? "";
}

function addAppleEntitlementToXML(source: string): string | undefined {
  const structural = stripXMLCommentsPreservingOffsets(source);
  if (appleKeyStructure(source).semanticCount !== 0) return undefined;
  const dictClose = structural.lastIndexOf("</dict>");
  if (dictClose < 0) return undefined;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const closingIndent = lineIndentAt(source, dictClose);
  const insertionPoint = dictClose - closingIndent.length;
  const firstKey = /<key\b/.exec(structural);
  const childIndent =
    firstKey?.index == null ? `${closingIndent}\t` : lineIndentAt(source, firstKey.index);
  const prefix = source.slice(0, insertionPoint).endsWith("\n") ? "" : newline;
  const insertion = [
    `${prefix}${childIndent}<key>${APPLE_SIGN_IN_KEY}</key>`,
    `${childIndent}<array>`,
    `${childIndent}\t<string>${APPLE_SIGN_IN_VALUE}</string>`,
    `${childIndent}</array>`,
    "",
  ].join(newline);
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
      `\t<key>${APPLE_SIGN_IN_KEY}</key>`,
      "\t<array>",
      `\t\t<string>${APPLE_SIGN_IN_VALUE}</string>`,
      "\t</array>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
}

function isCreateMutation(mutation: IOSFileMutation): mutation is IOSCreateFileMutation {
  return "kind" in mutation && mutation.kind === "create";
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function validBaseMutation(mutation: IOSFileMutation): boolean {
  return (
    Number.isInteger(mutation.mode) &&
    mutation.mode >= 0 &&
    mutation.mode <= 0o7777 &&
    hashIOSFileBytes(mutation.candidateBytes) === mutation.candidateHash &&
    (isCreateMutation(mutation) ||
      hashIOSFileBytes(mutation.originalBytes) === mutation.originalHash)
  );
}

function preparedWithHiddenMutations(
  plan: IOSAppleEntitlementPlan,
  mutations: IOSFileMutation[],
  consumedBaseMutationPaths: string[],
): Extract<PreparedIOSAppleEntitlementMutation, { status: "ready" }> {
  const result = {
    status: "ready" as const,
    plan,
    consumedBaseMutationPaths: [...consumedBaseMutationPaths].sort(),
  } as Extract<PreparedIOSAppleEntitlementMutation, { status: "ready" }>;
  Object.defineProperty(result, "mutations", {
    value: mutations,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

function samePlanFiles(
  left: readonly IOSAppleEntitlementPlanFile[],
  right: readonly IOSAppleEntitlementPlanFile[],
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

function candidateWithApple(root: string, document: EntitlementsDocument): Uint8Array | undefined {
  if (document.appleState === "exact") return document.bytes;
  const source = addAppleEntitlementToXML(document.source);
  if (!source) return undefined;
  const bytes = bytesWithOptionalBOM(source, document.bom);
  const inspected = inspectEntitlementsBytes(root, document.absolutePath, bytes, document.mode);
  return inspected.status === "safe" && inspected.document.appleState === "exact"
    ? bytes
    : undefined;
}

/**
 * Plans the exact native Sign in with Apple entitlement across every selected
 * target entitlements variant. No Apple or Clerk credentials are retained.
 */
export async function planIOSAppleEntitlement(
  options: IOSAppleEntitlementPlanOptions,
): Promise<IOSAppleEntitlementPlan> {
  const normalized = { ...options, root: resolve(options.root) };
  const entitlementProbe = await planIOSAssociatedDomain({
    root: normalized.root,
    projectPath: normalized.projectPath,
    targetId: normalized.targetId,
    deferToPublishableKey: true,
    allowMissingEntitlementsCreation: normalized.allowMissingEntitlementsCreation,
  });
  if (entitlementProbe.status === "blocked") {
    return blockedPlan(
      normalized,
      entitlementProbe.blockers.map((item) => blocker(item.code, item.message)),
      entitlementProbe.targetName,
    );
  }

  const files: IOSAppleEntitlementPlanFile[] = entitlementProbe.files.map((file) => ({
    path: file.path,
    operation: file.operation,
    ...(file.expectedHash ? { expectedHash: file.expectedHash } : {}),
  }));
  let allExact = files.length > 0 && files.every((file) => file.operation === "modify");
  for (const file of files) {
    if (file.operation === "create") {
      allExact = false;
      continue;
    }
    const inspected = await inspectEntitlementsFile(
      normalized.root,
      resolve(normalized.root, file.path),
    );
    if (inspected.status === "blocked") {
      return blockedPlan(normalized, [inspected.blocker], entitlementProbe.targetName);
    }
    if (inspected.document.hash !== file.expectedHash) {
      return blockedPlan(
        normalized,
        [blocker("stale-entitlements", `${file.path} changed while setup was inspected.`)],
        entitlementProbe.targetName,
      );
    }
    if (inspected.document.appleState !== "exact") allExact = false;
  }

  return {
    ...planBase(normalized),
    status: allExact ? "satisfied" : "ready",
    ...(entitlementProbe.targetName ? { targetName: entitlementProbe.targetName } : {}),
    files,
    ...(entitlementProbe.missingEntitlementsSettings
      ? { missingEntitlementsSettings: entitlementProbe.missingEntitlementsSettings }
      : {}),
    actions: allExact
      ? []
      : [
          files.some((file) => file.operation === "create")
            ? "Create and attach an iOS entitlements file with the Sign in with Apple entitlement set to Default."
            : "Set the Sign in with Apple entitlement to Default in every selected-target iOS entitlements configuration.",
        ],
    blockers: [],
  };
}

export async function prepareIOSAppleEntitlementMutation(
  plan: IOSAppleEntitlementPlan,
  options: IOSAppleEntitlementPrepareOptions = {},
): Promise<PreparedIOSAppleEntitlementMutation> {
  if (plan.status === "blocked") return { status: "blocked", plan };
  if (
    plan.schemaVersion !== 1 ||
    plan.kind !== "clerk-ios-sign-in-with-apple-entitlement" ||
    resolve(plan.root) !== plan.root ||
    !plan.projectPath ||
    !plan.targetId ||
    plan.files.length === 0
  ) {
    return blockPrepared(
      plan,
      "invalid-plan",
      "The serialized Apple entitlement plan is incomplete.",
    );
  }

  const baseByPath = new Map<string, IOSFileMutation>();
  for (const mutation of options.baseMutations ?? []) {
    const path = resolve(mutation.path);
    if (
      !isAbsolute(mutation.path) ||
      path !== mutation.path ||
      baseByPath.has(path) ||
      !(await pathIsSafelyWithinIOSRoot(plan.root, path)) ||
      !validBaseMutation(mutation)
    ) {
      return blockPrepared(
        plan,
        "invalid-plan",
        "A caller-supplied base mutation is invalid, duplicated, or outside the invocation root.",
      );
    }
    baseByPath.set(path, mutation);
  }

  // Compare the exact authorized bytes before reparsing. A concurrent edit
  // that also makes the plist malformed is stale input, not a new structural
  // blocker, and its newer bytes must remain untouched.
  for (const file of plan.files) {
    const absolutePath = resolve(plan.root, file.path);
    if (!(await pathIsSafelyWithinIOSRoot(plan.root, absolutePath))) {
      return blockPrepared(
        plan,
        "invalid-plan",
        "A planned entitlements path no longer resolves safely inside the invocation root.",
      );
    }
    if (file.operation === "create") {
      try {
        await lstat(absolutePath);
        return { status: "stale", plan };
      } catch (error) {
        if (!isMissingFileError(error)) return { status: "stale", plan };
      }
      continue;
    }
    if (!file.expectedHash)
      return blockPrepared(plan, "invalid-plan", "A planned file hash is missing.");
    const current = await readBoundedRegularFile(absolutePath, MAX_ENTITLEMENTS_BYTES);
    if (current.status !== "ok" || hashIOSFileBytes(current.bytes) !== file.expectedHash) {
      return { status: "stale", plan };
    }
  }

  const replanned = await planIOSAppleEntitlement({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    allowMissingEntitlementsCreation: plan.missingEntitlementsSettings != null,
  });
  if (replanned.status === "blocked") return { status: "blocked", plan: replanned };
  if (!samePlanFiles(plan.files, replanned.files)) return { status: "stale", plan };
  if (plan.status === "satisfied") {
    return replanned.status === "satisfied"
      ? { status: "satisfied", plan: replanned }
      : { status: "stale", plan };
  }
  if (replanned.status !== "ready") return { status: "stale", plan };

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
        "The missing-entitlements Apple plan is internally inconsistent.",
      );
    }
    const entitlementsPath = resolve(plan.root, createFile.path);
    const pbxprojPath = resolve(plan.root, plan.projectPath, "project.pbxproj");
    const baseEntitlements = baseByPath.get(entitlementsPath);
    const basePbx = baseByPath.get(pbxprojPath);
    if (baseEntitlements && !isCreateMutation(baseEntitlements)) {
      return { status: "stale", plan };
    }
    if (basePbx && isCreateMutation(basePbx)) {
      return blockPrepared(
        plan,
        "invalid-plan",
        "The base Xcode mutation must replace an existing file.",
      );
    }
    const settings = await prepareIOSMissingEntitlementsSettingsMutation(
      plan.missingEntitlementsSettings,
      basePbx as IOSExistingFileMutation | undefined,
    );
    if (settings.status === "stale") return { status: "stale", plan };
    if (settings.status !== "ready") {
      return blockPrepared(
        plan,
        "invalid-plan",
        "The iOS entitlements build settings could not be prepared safely.",
      );
    }

    const expectedParentIdentity =
      plan.missingEntitlementsSettings.expectedSynchronizedRootIdentity;
    const synchronizedRootPath = plan.missingEntitlementsSettings.synchronizedRootPath;
    const boundary = await prepareIOSFileMutationBoundary(plan.root, entitlementsPath);
    if (
      !expectedParentIdentity ||
      !synchronizedRootPath ||
      dirname(entitlementsPath) !== resolve(plan.root, synchronizedRootPath)
    ) {
      return blockPrepared(
        plan,
        "invalid-plan",
        "The entitlements destination no longer matches its synchronized target root.",
      );
    }
    if (
      !boundary ||
      boundary.parentIdentity.device !== expectedParentIdentity.device ||
      boundary.parentIdentity.inode !== expectedParentIdentity.inode
    ) {
      return { status: "stale", plan };
    }

    let createMutation: IOSCreateFileMutation;
    if (baseEntitlements) {
      if (!isDeepStrictEqual(baseEntitlements.boundary, boundary)) {
        return { status: "stale", plan };
      }
      const inspected = inspectEntitlementsBytes(
        plan.root,
        entitlementsPath,
        baseEntitlements.candidateBytes,
        baseEntitlements.mode,
      );
      if (inspected.status === "blocked") {
        return blockPrepared(plan, inspected.blocker.code, inspected.blocker.message);
      }
      const candidateBytes = candidateWithApple(plan.root, inspected.document);
      if (!candidateBytes) {
        return blockPrepared(
          plan,
          "unsupported-entitlements",
          "The composed entitlements candidate could not be updated safely.",
        );
      }
      createMutation = {
        ...baseEntitlements,
        boundary: baseEntitlements.boundary,
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
      [createMutation, settings.mutation],
      [...(baseEntitlements ? [entitlementsPath] : []), ...(basePbx ? [pbxprojPath] : [])],
    );
  }

  const mutations: IOSExistingFileMutation[] = [];
  const consumed: string[] = [];
  for (const file of plan.files) {
    if (file.operation !== "modify" || !file.expectedHash) {
      return blockPrepared(
        plan,
        "invalid-plan",
        "The Apple entitlement plan has an invalid file entry.",
      );
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
    if (source.status === "blocked") {
      return blockPrepared(plan, source.blocker.code, source.blocker.message);
    }
    if (source.document.appleState === "exact") {
      if (base && current.document.appleState !== "exact") {
        mutations.push(base);
        consumed.push(absolutePath);
      }
      continue;
    }
    const candidateBytes = candidateWithApple(plan.root, source.document);
    if (!candidateBytes) {
      return blockPrepared(
        plan,
        "unsupported-entitlements",
        `${file.path} could not be updated without rewriting unrelated plist content.`,
      );
    }
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

export async function validatePreparedIOSAppleEntitlement(
  prepared: Extract<PreparedIOSAppleEntitlementMutation, { status: "ready" }>,
): Promise<boolean> {
  if (
    prepared.plan.missingEntitlementsSettings &&
    !(await validateIOSMissingEntitlementsSettingsPostcondition(
      prepared.plan.missingEntitlementsSettings,
    ))
  ) {
    return false;
  }
  const current = await planIOSAppleEntitlement({
    root: prepared.plan.root,
    projectPath: prepared.plan.projectPath,
    targetId: prepared.plan.targetId,
  });
  const expectedPaths = prepared.plan.files.map((file) => file.path).sort();
  return (
    current.status === "satisfied" &&
    current.files
      .map((file) => file.path)
      .sort()
      .every((path, index) => path === expectedPaths[index]) &&
    current.files.length === expectedPaths.length
  );
}

export async function applyIOSAppleEntitlement(
  plan: IOSAppleEntitlementPlan,
): Promise<IOSAppleEntitlementApplyResult> {
  const prepared = await prepareIOSAppleEntitlementMutation(plan);
  if (prepared.status === "blocked") return { status: "blocked", plan: prepared.plan };
  if (prepared.status === "stale") return { status: "stale", plan: prepared.plan };
  if (prepared.status === "satisfied") return { status: "satisfied", plan: prepared.plan };
  const result = await applyIOSFileTransaction(prepared.mutations, [
    async () => validatePreparedIOSAppleEntitlement(prepared),
  ]);
  return { status: result.status, plan: prepared.plan };
}

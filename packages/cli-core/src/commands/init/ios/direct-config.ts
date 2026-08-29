import { lstat, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import { pathIsSafelyWithinIOSRoot, relativeIOSPath } from "./discovery.ts";
import {
  applyIOSExistingFileTransaction,
  IOSFileTransactionError,
  prepareIOSFileMutationBoundary,
  type IOSExistingFileMutation,
  type IOSFileMutationBoundary,
} from "./file-transaction.ts";
import {
  hasIncompleteIOSContainerDiscovery,
  inspectIOSProject,
  inspectIOSSourceMembership,
} from "./inspect.ts";
import {
  inspectSwiftUIAppRoot,
  inspectSwiftUIAppRootWithStatus,
  type SwiftUIAppRootStructure,
  type SwiftUIRootExpression,
} from "./swift-app-root.ts";
import { sanitizeSwiftSourceWithStatus } from "./swift.ts";
import type { IOSNativePlatform } from "./types.ts";

const MAX_SWIFT_FILE_BYTES = 1_000_000;

export interface IOSDirectConfigPlanOptions {
  root: string;
  /** Project-root-relative path selected by the iOS inspector. */
  projectPath: string;
  targetId: string;
  platform?: IOSNativePlatform;
  /** Low-level escape hatch. The aggregate init flow also checks every local mutation. */
  allowDirty?: boolean;
}

export type IOSDirectConfigBlockerCode =
  | "invalid-selection"
  | "external-path"
  | "generated-project"
  | "target-not-found"
  | "incomplete-source-membership"
  | "shared-source"
  | "ambiguous-entry-point"
  | "unreadable-source"
  | "unsupported-encoding"
  | "unsupported-line-endings"
  | "unsupported-app-structure"
  | "unsupported-initializer"
  | "unsupported-scene"
  | "conflicting-configuration"
  | "conflicting-environment"
  | "preinitialization-clerk-access"
  | "invalid-inline-publishable-key"
  | "production-inline-publishable-key"
  | "dirty-source"
  | "git-state-unknown"
  | "invalid-publishable-key"
  | "production-publishable-key"
  | "different-inline-publishable-key";

export interface IOSDirectConfigBlocker {
  code: IOSDirectConfigBlockerCode;
  message: string;
}

export interface IOSDirectConfigChanges {
  clerkKitImport: "insert" | "satisfied";
  configuration: "insert-initializer" | "insert-statement" | "verify-existing";
  environment: "insert" | "satisfied";
}

/**
 * A redacted, serializable plan. It deliberately contains neither a key nor
 * candidate source bytes. A direct literal remains verification-required
 * until prepare/apply receives the selected application's development key.
 */
export interface IOSDirectConfigPlan {
  schemaVersion: 1;
  kind: "clerk-ios-direct-config";
  status: "ready" | "blocked";
  root: string;
  projectPath: string;
  targetId: string;
  platform: IOSNativePlatform;
  allowDirty: boolean;
  sourcePath?: string;
  /** SHA-256 of the exact source bytes inspected by this plan. */
  expectedSourceHash?: string;
  changes?: IOSDirectConfigChanges;
  /** Semantic, publishable-key-redacted preview. */
  actions: string[];
  blockers: IOSDirectConfigBlocker[];
}

export interface IOSDirectConfigApplyResult {
  status: "applied" | "satisfied" | "blocked" | "stale" | "rolled-back";
  plan: IOSDirectConfigPlan;
  message?: string;
}

/** @internal A key-bearing in-memory mutation for a multi-file transaction coordinator. */
export interface IOSDirectConfigFileMutation {
  absolutePath: string;
  boundary: IOSFileMutationBoundary;
  expectedHash: string;
  candidateHash: string;
  mode: number;
  /** Non-enumerable at runtime so ordinary JSON serialization cannot emit source/key bytes. */
  originalBytes: Uint8Array;
  /** Non-enumerable at runtime so ordinary JSON serialization cannot emit source/key bytes. */
  candidateBytes: Uint8Array;
}

/**
 * @internal Transaction-oriented preparation result. `mutation` is
 * non-enumerable and may contain the raw publishable key in candidate bytes.
 */
export type IOSDirectConfigPreparedMutation =
  | {
      status: "ready";
      plan: IOSDirectConfigPlan;
      mutation: IOSDirectConfigFileMutation;
    }
  | {
      status: "satisfied" | "blocked" | "stale";
      plan: IOSDirectConfigPlan;
      message?: string;
      mutation?: undefined;
    };

/** @internal Test-only fault injection for the standalone atomic writer. */
export interface IOSDirectConfigApplyOptions {
  beforeCommit?: () => void | Promise<void>;
  beforeCommitInstall?: () => void | Promise<void>;
  beforePostWriteValidation?: () => void | Promise<void>;
  forcePostWriteValidationFailure?: boolean;
}

interface FileSnapshot {
  absolutePath: string;
  relativePath: string;
  bytes: Uint8Array;
  source: string;
  hash: string;
  mode: number;
  device: number;
  inode: number;
}

interface Range {
  start: number;
  end: number;
}

interface AppStructure {
  source: string;
  sanitized: string;
  newline: "\n" | "\r\n";
  appType: SwiftUIAppRootStructure["appType"];
  initializer?: Range & { openingBrace: number; closingBrace: number };
  body: SwiftUIAppRootStructure["body"];
  root: SwiftUIAppRootStructure["root"];
  hasClerkKitImport: boolean;
  importInsertion: number;
  existingPublishableKey?: string;
  hasEnvironment: boolean;
  configurationInsertion:
    | {
        kind: "new-initializer";
        index: number;
        memberIndent: string;
        statementIndent: string;
      }
    | {
        kind: "existing-initializer";
        index: number;
        statementIndent: string;
        multiline: boolean;
      }
    | { kind: "existing-literal" };
  environmentInsertion?: { index: number; textBeforeKey: string };
}

interface PreparedDirectConfig {
  plan: IOSDirectConfigPlan;
  snapshot?: FileSnapshot;
  structure?: AppStructure;
}

interface SourceEdit {
  index: number;
  text: string;
}

const preparedValidators = new WeakMap<IOSDirectConfigPreparedMutation, () => Promise<boolean>>();

function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function makePlan(
  options: IOSDirectConfigPlanOptions,
  root: string,
  projectPath: string,
  status: IOSDirectConfigPlan["status"],
  details: Partial<
    Pick<
      IOSDirectConfigPlan,
      "sourcePath" | "expectedSourceHash" | "changes" | "actions" | "blockers"
    >
  > = {},
): IOSDirectConfigPlan {
  return {
    schemaVersion: 1,
    kind: "clerk-ios-direct-config",
    status,
    root,
    projectPath,
    targetId: options.targetId,
    platform: options.platform ?? "ios",
    allowDirty: options.allowDirty === true,
    sourcePath: details.sourcePath,
    expectedSourceHash: details.expectedSourceHash,
    changes: details.changes,
    actions: details.actions ?? [],
    blockers: details.blockers ?? [],
  };
}

function blocked(
  options: IOSDirectConfigPlanOptions,
  root: string,
  projectPath: string,
  code: IOSDirectConfigBlockerCode,
  message: string,
  source: Partial<PreparedDirectConfig> = {},
): PreparedDirectConfig {
  return {
    ...source,
    plan: makePlan(options, root, projectPath, "blocked", {
      sourcePath: source.plan?.sourcePath,
      expectedSourceHash: source.plan?.expectedSourceHash,
      blockers: [{ code, message }],
    }),
  };
}

function skipWhitespace(source: string, start: number, end = source.length): number {
  let cursor = start;
  while (cursor < end && /\s/.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function matchingDelimiter(
  source: string,
  opening: number,
  openCharacter: "(" | "[" | "{",
  closeCharacter: ")" | "]" | "}",
): number | undefined {
  if (source[opening] !== openCharacter) return undefined;
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === openCharacter) depth += 1;
    if (source[index] !== closeCharacter) continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return undefined;
}

function matchingBrace(source: string, opening: number): number | undefined {
  return matchingDelimiter(source, opening, "{", "}");
}

function matchingParenthesis(source: string, opening: number): number | undefined {
  return matchingDelimiter(source, opening, "(", ")");
}

interface SwiftStructuralIndex {
  braceDepth: Int32Array;
  conditionalRanges: Range[];
}

function buildSwiftStructuralIndex(source: string): SwiftStructuralIndex {
  const braceDepth = new Int32Array(source.length + 1);
  for (let position = 0; position < source.length; position += 1) {
    braceDepth[position + 1] =
      braceDepth[position]! + (source[position] === "{" ? 1 : source[position] === "}" ? -1 : 0);
  }

  const conditionalRanges: Range[] = [];
  const directive = /^[\t ]*#(if|elseif|else|endif)\b/gm;
  let depth = 0;
  let rangeStart: number | undefined;
  let match: RegExpExecArray | null;
  while ((match = directive.exec(source)) !== null) {
    if (match[1] === "if") {
      if (depth === 0) rangeStart = match.index;
      depth += 1;
    }
    if (match[1] === "endif" && depth > 0) {
      depth -= 1;
      if (depth === 0 && rangeStart != null) {
        conditionalRanges.push({ start: rangeStart, end: match.index });
        rangeStart = undefined;
      }
    }
  }
  if (rangeStart != null) conditionalRanges.push({ start: rangeStart, end: source.length });
  return { braceDepth, conditionalRanges };
}

function braceDepthAt(index: SwiftStructuralIndex, openingBrace: number, position: number): number {
  return index.braceDepth[position]! - index.braceDepth[openingBrace]!;
}

function isInsideConditionalCompilation(index: SwiftStructuralIndex, position: number): boolean {
  let low = 0;
  let high = index.conditionalRanges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = index.conditionalRanges[middle]!;
    if (position < range.start) high = middle - 1;
    else if (position >= range.end) low = middle + 1;
    else return true;
  }
  return false;
}

function lineStart(source: string, position: number): number {
  const newline = source.lastIndexOf("\n", Math.max(0, position - 1));
  return newline === -1 ? 0 : newline + 1;
}

function lineEnd(source: string, position: number): number {
  const newline = source.indexOf("\n", position);
  if (newline === -1) return source.length;
  return source[newline - 1] === "\r" ? newline - 1 : newline;
}

function lineIndent(source: string, position: number): string {
  const start = lineStart(source, position);
  return /^[\t ]*/.exec(source.slice(start, position))?.[0] ?? "";
}

function indentationUnit(parentIndent: string, childIndent: string): string {
  if (childIndent.startsWith(parentIndent) && childIndent.length > parentIndent.length) {
    return childIndent.slice(parentIndent.length);
  }
  if (childIndent.includes("\t")) return "\t";
  return "  ";
}

function newlineStyle(source: string): "\n" | "\r\n" | undefined {
  if (/\r(?!\n)/.test(source)) return undefined;
  const hasCRLF = source.includes("\r\n");
  const hasBareLF = /(^|[^\r])\n/.test(source);
  if (hasCRLF && hasBareLF) return undefined;
  return hasCRLF ? "\r\n" : "\n";
}

function decodeUTF8(bytes: Uint8Array): string | undefined {
  try {
    // ignoreBOM retains a leading U+FEFF so re-encoding preserves exact bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function sourceSnapshot(
  root: string,
  relativePath: string,
): Promise<FileSnapshot | undefined> {
  const absolutePath = resolve(root, relativePath);
  if (!(await pathIsSafelyWithinIOSRoot(root, absolutePath))) return undefined;
  try {
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SWIFT_FILE_BYTES) {
      return undefined;
    }
    const bytes = new Uint8Array(await readFile(absolutePath));
    const source = decodeUTF8(bytes);
    if (source == null || source.includes("\0")) return undefined;
    return {
      absolutePath,
      relativePath,
      bytes,
      source,
      hash: sha256(bytes),
      mode: info.mode & 0o7777,
      device: info.dev,
      inode: info.ino,
    };
  } catch {
    return undefined;
  }
}

type EntrySourceOwnership = "exclusive" | "shared" | "incomplete";

function sourceOwnerKey(projectPath: string, targetId: string): string {
  return `${projectPath}\0${targetId}`;
}

async function entrySourceOwnership(
  root: string,
  projectPath: string,
  targetId: string,
  snapshot: FileSnapshot,
): Promise<EntrySourceOwnership> {
  const memberships = await inspectIOSSourceMembership(root);
  const selectedMembership = memberships.find(
    (membership) => membership.projectPath === projectPath && membership.targetId === targetId,
  );
  if (!selectedMembership?.complete || memberships.some((membership) => !membership.complete)) {
    return "incomplete";
  }

  const owners = new Set<string>();
  try {
    for (const membership of memberships) {
      let ownsSource = false;
      for (const file of membership.files) {
        const info = await lstat(file.absolutePath);
        if (!info.isFile() || info.isSymbolicLink()) return "incomplete";
        if (info.dev === snapshot.device && info.ino === snapshot.inode) ownsSource = true;
      }
      if (ownsSource) owners.add(sourceOwnerKey(membership.projectPath, membership.targetId));
    }
  } catch {
    return "incomplete";
  }

  const selectedOwner = sourceOwnerKey(projectPath, targetId);
  if (!owners.has(selectedOwner)) return "incomplete";
  return owners.size === 1 ? "exclusive" : "shared";
}

async function generatedProjectKind(
  root: string,
  absoluteProjectPath: string,
): Promise<"xcodegen" | "tuist" | null> {
  let directory = dirname(absoluteProjectPath);
  while (await pathIsSafelyWithinIOSRoot(root, directory)) {
    for (const [markerPath, kind] of [
      ["project.yml", "xcodegen"],
      ["Project.swift", "tuist"],
      ["Workspace.swift", "tuist"],
      ["Tuist/ProjectDescriptionHelpers", "tuist"],
    ] as const) {
      const marker = resolve(directory, markerPath);
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

function plainClerkKitImports(sanitized: string, index: SwiftStructuralIndex): number[] {
  const imports: number[] = [];
  const pattern = /^[\t ]*import[\t ]+ClerkKit[\t ]*\r?$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sanitized)) !== null) {
    if (!isInsideConditionalCompilation(index, match.index)) imports.push(match.index);
  }
  return imports;
}

interface SwiftImportLine {
  start: number;
  end: number;
  moduleName: string;
  moduleEnd: number;
}

const IMPORT_DECLARATION_KINDS = new Set([
  "typealias",
  "struct",
  "class",
  "enum",
  "protocol",
  "actor",
  "let",
  "var",
  "func",
  "macro",
]);

function isHorizontalWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function skipHorizontalWhitespace(source: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && isHorizontalWhitespace(source[cursor])) cursor += 1;
  return cursor;
}

function swiftIdentifierEnd(source: string, start: number, end: number): number | undefined {
  if (!/[A-Za-z_]/.test(source[start] ?? "")) return undefined;
  let cursor = start + 1;
  while (cursor < end && /[A-Za-z0-9_]/.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

/**
 * Parses one sanitized Swift import line without a repeated, variable-width
 * attribute regex. Attribute arguments are balanced structurally so even a
 * hostile source line remains linear-time input.
 */
function parseSwiftImportLine(
  source: string,
  start: number,
  end: number,
): SwiftImportLine | undefined {
  let cursor = skipHorizontalWhitespace(source, start, end);
  while (source[cursor] === "@") {
    cursor += 1;
    const firstComponentEnd = swiftIdentifierEnd(source, cursor, end);
    if (firstComponentEnd == null) return undefined;
    cursor = firstComponentEnd;
    while (source[cursor] === ".") {
      const componentEnd = swiftIdentifierEnd(source, cursor + 1, end);
      if (componentEnd == null) return undefined;
      cursor = componentEnd;
    }
    if (source[cursor] === "(") {
      const closing = matchingParenthesis(source, cursor);
      if (closing == null || closing >= end) return undefined;
      cursor = closing + 1;
    }
    const whitespaceEnd = skipHorizontalWhitespace(source, cursor, end);
    if (whitespaceEnd === cursor) return undefined;
    cursor = whitespaceEnd;
  }

  if (source.slice(cursor, cursor + 6) !== "import") return undefined;
  cursor += 6;
  const importWhitespaceEnd = skipHorizontalWhitespace(source, cursor, end);
  if (importWhitespaceEnd === cursor) return undefined;
  cursor = importWhitespaceEnd;

  let moduleEnd = swiftIdentifierEnd(source, cursor, end);
  if (moduleEnd == null) return undefined;
  let moduleName = source.slice(cursor, moduleEnd);
  if (IMPORT_DECLARATION_KINDS.has(moduleName)) {
    const kindWhitespaceEnd = skipHorizontalWhitespace(source, moduleEnd, end);
    if (kindWhitespaceEnd === moduleEnd) return undefined;
    cursor = kindWhitespaceEnd;
    moduleEnd = swiftIdentifierEnd(source, cursor, end);
    if (moduleEnd == null) return undefined;
    moduleName = source.slice(cursor, moduleEnd);
  }

  return { start, end, moduleName, moduleEnd };
}

function swiftImportLines(sanitized: string): SwiftImportLine[] {
  const imports: SwiftImportLine[] = [];
  let start = 0;
  while (start <= sanitized.length) {
    const newline = sanitized.indexOf("\n", start);
    const end =
      newline === -1 ? sanitized.length : sanitized[newline - 1] === "\r" ? newline - 1 : newline;
    const importLine = parseSwiftImportLine(sanitized, start, end);
    if (importLine) imports.push(importLine);
    if (newline === -1) break;
    start = newline + 1;
  }
  return imports;
}

function anyClerkKitImports(sanitized: string): number[] {
  return swiftImportLines(sanitized)
    .filter(
      (line) =>
        line.moduleName === "ClerkKit" &&
        (sanitized[line.moduleEnd] === "." ||
          skipHorizontalWhitespace(sanitized, line.moduleEnd, line.end) === line.end),
    )
    .map((line) => line.start);
}

function importInsertionPosition(
  sanitized: string,
  index: SwiftStructuralIndex,
): number | undefined {
  const last = swiftImportLines(sanitized)
    .filter((line) => !isInsideConditionalCompilation(index, line.start))
    .at(-1);
  return last?.end;
}

interface InitializerCandidate {
  start: number;
  end: number;
  openingBrace: number;
  closingBrace: number;
  supported: boolean;
}

function initializerCandidates(
  sanitized: string,
  appType: AppStructure["appType"],
  index: SwiftStructuralIndex,
): InitializerCandidate[] {
  const candidates: InitializerCandidate[] = [];
  const pattern = /\binit\s*([?!])?\s*\(/g;
  pattern.lastIndex = appType.openingBrace + 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sanitized)) !== null && match.index < appType.closingBrace) {
    if (braceDepthAt(index, appType.openingBrace, match.index) !== 1) continue;
    const openingParenthesis = sanitized.indexOf("(", match.index);
    const closingParenthesis = matchingParenthesis(sanitized, openingParenthesis);
    if (closingParenthesis == null || closingParenthesis >= appType.closingBrace) {
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        openingBrace: -1,
        closingBrace: -1,
        supported: false,
      });
      continue;
    }
    const openingBrace = sanitized.indexOf("{", closingParenthesis + 1);
    const header = openingBrace === -1 ? "" : sanitized.slice(closingParenthesis + 1, openingBrace);
    const closingBrace = openingBrace === -1 ? undefined : matchingBrace(sanitized, openingBrace);
    const supported =
      match[1] == null &&
      sanitized.slice(openingParenthesis + 1, closingParenthesis).trim() === "" &&
      openingBrace !== -1 &&
      openingBrace < appType.closingBrace &&
      header.trim() === "" &&
      closingBrace != null &&
      closingBrace <= appType.closingBrace;
    candidates.push({
      start: match.index,
      end: (closingBrace ?? closingParenthesis) + 1,
      openingBrace,
      closingBrace: closingBrace ?? -1,
      supported,
    });
    if (closingBrace != null) pattern.lastIndex = closingBrace + 1;
  }
  return candidates;
}

/**
 * Proves the narrow SwiftUI starter root used by the optional AuthView
 * scaffold. This deliberately shares the direct-config parser's structural
 * ownership checks: the sole unconditional top-level `@main` declaration must
 * be a SwiftUI `App`, and its one `body: some Scene` must own the WindowGroup
 * whose direct root is ContentView.
 */
export function hasExactIOSSwiftUIAppContentRoot(source: string): boolean {
  const sanitization = sanitizeSwiftSourceWithStatus(source);
  if (!sanitization.complete) return false;
  const sanitized = sanitization.sanitizedSource;
  const root = inspectSwiftUIAppRoot(sanitized)?.root;
  if (!root) return false;

  const groupOpeningBrace = sanitized.lastIndexOf("{", root.start);
  if (groupOpeningBrace < root.containerStart) return false;
  const container = sanitized.slice(root.containerStart, groupOpeningBrace).replace(/\s+/g, "");
  if (container !== "WindowGroup") return false;

  const expression = sanitized.slice(root.start, root.end).replace(/\s+/g, "");
  return expression === "ContentView()" || expression === "ContentView().environment(Clerk.shared)";
}

function exactConfigureCall(
  source: string,
  sanitized: string,
  initializer: AppStructure["initializer"] | undefined,
  index: SwiftStructuralIndex,
): { key?: string; callIndex?: number; conflict: boolean } {
  const calls = [...sanitized.matchAll(/\bClerk\s*\.\s*configure\s*\(/g)];
  if (calls.length === 0) return { conflict: false };
  if (calls.length !== 1 || !initializer || calls[0]?.index == null) return { conflict: true };
  const callIndex = calls[0].index;
  if (
    callIndex <= initializer.openingBrace ||
    callIndex >= initializer.closingBrace ||
    braceDepthAt(index, initializer.openingBrace, callIndex) !== 1
  ) {
    return { conflict: true };
  }
  const openingParenthesis = sanitized.indexOf("(", callIndex);
  const closingParenthesis = matchingParenthesis(sanitized, openingParenthesis);
  if (closingParenthesis == null || closingParenthesis >= initializer.closingBrace) {
    return { conflict: true };
  }
  let before = callIndex - 1;
  while (sanitized[before] === " " || sanitized[before] === "\t") before -= 1;
  let after = closingParenthesis + 1;
  while (sanitized[after] === " " || sanitized[after] === "\t") after += 1;
  if (
    !["{", "}", ";", "\n", "\r"].includes(sanitized[before] ?? "") ||
    !["}", ";", "\n", "\r"].includes(sanitized[after] ?? "")
  ) {
    return { conflict: true };
  }
  const originalArguments = source.slice(openingParenthesis + 1, closingParenthesis);
  const literal = /^\s*publishableKey\s*:\s*"(pk_(?:test|live)_[A-Za-z0-9+/_=-]+)"\s*,?\s*$/.exec(
    originalArguments,
  )?.[1];
  return literal ? { key: literal, callIndex, conflict: false } : { conflict: true };
}

function validateInlineKey(value: string): "development" | "production" | undefined {
  try {
    return decodePublishableKey(value).instanceType;
  } catch {
    return undefined;
  }
}

function hasDirectStoredProperty(
  sanitized: string,
  appType: AppStructure["appType"],
  body: AppStructure["body"],
  index: SwiftStructuralIndex,
): boolean {
  const pattern = /\b(?:let|var)\s+[A-Za-z_][A-Za-z0-9_]*/g;
  pattern.lastIndex = appType.openingBrace + 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sanitized)) !== null && match.index < appType.closingBrace) {
    if (match.index === body.start) continue;
    if (braceDepthAt(index, appType.openingBrace, match.index) === 1) return true;
  }
  return false;
}

function bodyHasLeadingAttribute(source: string, body: AppStructure["body"]): boolean {
  let cursor = body.declarationStart;
  while (cursor > 0) {
    const previousEnd = cursor - 1;
    const previousStart = lineStart(source, previousEnd);
    const line = source.slice(previousStart, previousEnd + 1).trim();
    if (line === "") {
      cursor = previousStart;
      continue;
    }
    return line.startsWith("@");
  }
  return false;
}

function hasPreinitializationClerkSharedAccess(
  sanitized: string,
  appType: AppStructure["appType"],
  initializer: AppStructure["initializer"] | undefined,
  configureCallIndex: number | undefined,
  index: SwiftStructuralIndex,
): boolean {
  for (const match of sanitized.matchAll(/\bClerk\s*\.\s*shared\b/g)) {
    if (match.index == null) continue;
    const position = match.index;
    if (position < appType.start || position >= appType.end) {
      if (braceDepthAt(index, 0, position) === 0) return true;
      continue;
    }
    if (braceDepthAt(index, appType.openingBrace, position) === 1) return true;
    if (
      initializer &&
      configureCallIndex != null &&
      position > initializer.openingBrace &&
      position < configureCallIndex
    ) {
      return true;
    }
  }
  return false;
}

function environmentInsertion(
  source: string,
  newline: "\n" | "\r\n",
  root: SwiftUIRootExpression,
): AppStructure["environmentInsertion"] {
  const trailingLine = source.slice(root.end, lineEnd(source, root.end));
  const sharesLineWithComment = /\/\*|\/\//.test(trailingLine);
  const isCompact = !source.slice(root.start, root.end).includes("\n") && !sharesLineWithComment;
  if (isCompact || sharesLineWithComment) {
    return { index: root.end, textBeforeKey: ".environment(Clerk.shared)" };
  }
  const rootIndent = lineIndent(source, root.start);
  const lastModifier = root.modifierStarts.at(-1);
  const modifierIndent =
    lastModifier == null
      ? `${rootIndent}${indentationUnit(lineIndent(source, root.containerStart), rootIndent)}`
      : lineIndent(source, lastModifier);
  return {
    index: root.end,
    textBeforeKey: `${newline}${modifierIndent}.environment(Clerk.shared)`,
  };
}

function parseAppStructure(
  source: string,
): { structure: AppStructure } | { blocker: IOSDirectConfigBlocker } {
  const newline = newlineStyle(source);
  if (!newline) {
    return {
      blocker: {
        code: "unsupported-line-endings",
        message: "The Swift entry source uses mixed or unsupported line endings.",
      },
    };
  }
  const sanitization = sanitizeSwiftSourceWithStatus(source);
  if (!sanitization.complete) {
    return {
      blocker: {
        code: "unsupported-app-structure",
        message: "The Swift entry source contains syntax that could not be inspected safely.",
      },
    };
  }
  const sanitized = sanitization.sanitizedSource;
  const structuralIndex = buildSwiftStructuralIndex(sanitized);
  const appRootInspection = inspectSwiftUIAppRootWithStatus(sanitized);
  if (appRootInspection.status === "unsupported-app") {
    return {
      blocker: {
        code: "unsupported-app-structure",
        message: "The entry source is not one unconditional, safely editable @main SwiftUI App.",
      },
    };
  }
  if (appRootInspection.status === "unsupported-body") {
    return {
      blocker: {
        code: "unsupported-scene",
        message: "The @main App does not contain exactly one safely editable body: some Scene.",
      },
    };
  }
  if (appRootInspection.status === "unsupported-scene") {
    return {
      blocker: {
        code: "unsupported-scene",
        message:
          "The App scene is not one WindowGroup with one safely editable root view expression.",
      },
    };
  }
  const appRoot = appRootInspection.structure;
  const { appType, body, root } = appRoot;

  const initializerMatches = initializerCandidates(sanitized, appType, structuralIndex);
  if (
    initializerMatches.length > 1 ||
    initializerMatches.some((candidate) => !candidate.supported)
  ) {
    return {
      blocker: {
        code: "unsupported-initializer",
        message: "The @main App initializer is ambiguous or cannot be edited safely.",
      },
    };
  }
  const initializerCandidate = initializerMatches[0];
  const initializer = initializerCandidate
    ? {
        start: initializerCandidate.start,
        end: initializerCandidate.end,
        openingBrace: initializerCandidate.openingBrace,
        closingBrace: initializerCandidate.closingBrace,
      }
    : undefined;
  if (hasDirectStoredProperty(sanitized, appType, body, structuralIndex)) {
    return {
      blocker: {
        code: "unsupported-initializer",
        message:
          "The @main App has stored startup state whose initialization cannot be proven to occur after Clerk configuration.",
      },
    };
  }
  if (!initializer && bodyHasLeadingAttribute(source, body)) {
    return {
      blocker: {
        code: "unsupported-initializer",
        message:
          "The @main App has attributed startup state but no explicit initializer; add Clerk configuration manually or add a simple init() first.",
      },
    };
  }

  const configure = exactConfigureCall(source, sanitized, initializer, structuralIndex);
  if (configure.conflict) {
    return {
      blocker: {
        code: "conflicting-configuration",
        message:
          "An existing Clerk configuration call is not the exact supported inline initializer form.",
      },
    };
  }
  if (configure.key) {
    const instanceType = validateInlineKey(configure.key);
    if (!instanceType) {
      return {
        blocker: {
          code: "invalid-inline-publishable-key",
          message: "The existing inline Clerk publishable key is malformed and was preserved.",
        },
      };
    }
    if (instanceType === "production") {
      return {
        blocker: {
          code: "production-inline-publishable-key",
          message:
            "The existing inline production publishable key was preserved for manual review.",
        },
      };
    }
    if (
      !initializer ||
      configure.callIndex == null ||
      sanitized.slice(initializer.openingBrace + 1, configure.callIndex).trim() !== ""
    ) {
      return {
        blocker: {
          code: "preinitialization-clerk-access",
          message:
            "The existing Clerk configuration is not the first executable statement in the @main App initializer.",
        },
      };
    }
  }
  if (
    hasPreinitializationClerkSharedAccess(
      sanitized,
      appType,
      initializer,
      configure.callIndex,
      structuralIndex,
    )
  ) {
    return {
      blocker: {
        code: "preinitialization-clerk-access",
        message: "Clerk.shared is accessed before the proven App initializer configuration point.",
      },
    };
  }

  const environment = appRoot.clerkEnvironment;
  if (environment.conflicting) {
    return {
      blocker: {
        code: "conflicting-environment",
        message: "The WindowGroup root contains a conflicting Clerk environment modifier.",
      },
    };
  }
  const importInsertion = importInsertionPosition(sanitized, structuralIndex);
  if (importInsertion == null) {
    return {
      blocker: {
        code: "unsupported-app-structure",
        message: "The entry source has no unconditional top-level import section.",
      },
    };
  }
  const plainImports = plainClerkKitImports(sanitized, structuralIndex);
  const allClerkImports = anyClerkKitImports(sanitized);
  if (
    plainImports.length > 1 ||
    (allClerkImports.length > 0 &&
      (plainImports.length !== 1 || allClerkImports.length !== plainImports.length))
  ) {
    return {
      blocker: {
        code: "unsupported-app-structure",
        message: "The entry source contains conditional, scoped, or duplicate ClerkKit imports.",
      },
    };
  }

  const appIndent = lineIndent(source, appType.declarationStart);
  const bodyIndent = lineIndent(source, body.start);
  const unit = indentationUnit(appIndent, bodyIndent);
  let configurationInsertion: AppStructure["configurationInsertion"];
  if (configure.key) {
    configurationInsertion = { kind: "existing-literal" };
  } else if (initializer) {
    const bodyStart = initializer.openingBrace + 1;
    const firstContent = skipWhitespace(sanitized, bodyStart, initializer.closingBrace);
    configurationInsertion = {
      kind: "existing-initializer",
      index: bodyStart,
      statementIndent: `${lineIndent(source, initializer.start)}${unit}`,
      multiline: source.slice(bodyStart, firstContent).includes("\n"),
    };
  } else {
    configurationInsertion = {
      kind: "new-initializer",
      index: body.declarationStart,
      memberIndent: bodyIndent,
      statementIndent: `${bodyIndent}${unit}`,
    };
  }

  return {
    structure: {
      source,
      sanitized,
      newline,
      appType,
      initializer,
      body,
      root,
      hasClerkKitImport: plainImports.length === 1,
      importInsertion,
      existingPublishableKey: configure.key,
      hasEnvironment: environment.found,
      configurationInsertion,
      environmentInsertion: environment.found
        ? undefined
        : environmentInsertion(source, newline, root),
    },
  };
}

async function gitDirtyState(
  root: string,
  absolutePath: string,
): Promise<"clean" | "dirty" | "not-repository" | "unknown"> {
  try {
    const child = Bun.spawn(
      ["git", "status", "--porcelain=v1", "--untracked-files=all", "--", absolutePath],
      { cwd: root, stdout: "pipe", stderr: "ignore" },
    );
    const output = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    if (exitCode === 0) return output.trim() === "" ? "clean" : "dirty";
    const probe = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await probe.exited) === 0 ? "unknown" : "not-repository";
  } catch {
    return "unknown";
  }
}

function semanticActions(sourcePath: string, changes: IOSDirectConfigChanges): string[] {
  const actions: string[] = [];
  if (changes.clerkKitImport === "insert") {
    actions.push(`Add import ClerkKit to ${sourcePath}.`);
  }
  if (changes.configuration === "insert-initializer") {
    actions.push(
      `Add a simple @main App initializer in ${sourcePath} and configure Clerk with the selected development publishable key (redacted).`,
    );
  } else if (changes.configuration === "insert-statement") {
    actions.push(
      `Configure Clerk first in the existing @main App initializer in ${sourcePath} with the selected development publishable key (redacted).`,
    );
  } else {
    actions.push(
      `Verify the existing inline Clerk configuration in ${sourcePath} matches the selected development publishable key (redacted).`,
    );
  }
  if (changes.environment === "insert") {
    actions.push(`Inject Clerk.shared into the WindowGroup root environment in ${sourcePath}.`);
  }
  return actions;
}

async function prepareDirectConfig(
  options: IOSDirectConfigPlanOptions,
): Promise<PreparedDirectConfig> {
  const root = resolve(options.root);
  const absoluteProjectPath = resolve(root, options.projectPath);
  if (
    !options.targetId ||
    !options.projectPath ||
    resolve(root, relative(root, absoluteProjectPath)) !== absoluteProjectPath ||
    !(await pathIsSafelyWithinIOSRoot(root, absoluteProjectPath))
  ) {
    return blocked(
      options,
      root,
      options.projectPath,
      "invalid-selection",
      "The selected Xcode project or target is invalid.",
    );
  }
  const projectPath = relativeIOSPath(root, absoluteProjectPath);
  const inspection = await inspectIOSProject(root, {
    target: options.targetId,
    exhaustiveContainerDiscovery: true,
  });
  if (hasIncompleteIOSContainerDiscovery(inspection)) {
    return blocked(
      options,
      root,
      projectPath,
      "incomplete-source-membership",
      "Complete local Xcode container discovery could not be proven.",
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
      "The selected native Apple application target could not be proven.",
    );
  }
  const generator =
    inspection.generatedProject ?? (await generatedProjectKind(root, absoluteProjectPath));
  if (generator != null) {
    return blocked(
      options,
      root,
      projectPath,
      "generated-project",
      `This is a ${
        generator === "xcodegen" ? "XcodeGen" : "Tuist"
      } project; update its source manifest instead of generated Swift sources.`,
    );
  }
  const target = inspection.appTargets.find(
    (candidate) => candidate.id === options.targetId && candidate.projectPath === projectPath,
  );
  if (!target) {
    return blocked(
      options,
      root,
      projectPath,
      "target-not-found",
      "The selected native Apple application target disappeared during inspection.",
    );
  }
  if (options.platform && target.platform !== options.platform) {
    return blocked(
      options,
      root,
      projectPath,
      "target-not-found",
      "The selected application target changed platforms during inspection.",
    );
  }
  if (!target.swift.evidenceComplete) {
    return blocked(
      options,
      root,
      projectPath,
      "incomplete-source-membership",
      "The selected target's complete shipping Swift source membership could not be proven.",
    );
  }
  if (target.swift.entryPoints.length !== 1 || !target.swift.entryPoints[0]?.path) {
    return blocked(
      options,
      root,
      projectPath,
      "ambiguous-entry-point",
      "The selected target must contain exactly one shipping @main Swift entry point.",
    );
  }
  const sourcePath = target.swift.entryPoints[0].path;
  const snapshot = await sourceSnapshot(root, sourcePath);
  if (!snapshot) {
    return blocked(
      options,
      root,
      projectPath,
      "unreadable-source",
      "The selected @main Swift source is not a safe, readable in-root regular file.",
      { plan: makePlan(options, root, projectPath, "blocked", { sourcePath }) },
    );
  }
  const sourcePlan = makePlan(options, root, projectPath, "ready", {
    sourcePath,
    expectedSourceHash: snapshot.hash,
  });

  const ownership = await entrySourceOwnership(root, projectPath, options.targetId, snapshot);
  if (ownership === "incomplete") {
    return blocked(
      options,
      root,
      projectPath,
      "incomplete-source-membership",
      "Complete entry-source ownership across every local native target could not be proven.",
      { plan: sourcePlan, snapshot },
    );
  }
  if (ownership === "shared") {
    return blocked(
      options,
      root,
      projectPath,
      "shared-source",
      "The selected @main Swift source is shared, aliased, or not exclusively owned by the selected target.",
      { plan: sourcePlan, snapshot },
    );
  }

  const parsed = parseAppStructure(snapshot.source);
  if ("blocker" in parsed) {
    return blocked(options, root, projectPath, parsed.blocker.code, parsed.blocker.message, {
      plan: sourcePlan,
      snapshot,
    });
  }
  const structure = parsed.structure;

  const configureElsewhere = target.swift.configureCalls.some((call) => call.path !== sourcePath);
  if (
    configureElsewhere ||
    target.swift.configureCalls.length > (structure.existingPublishableKey ? 1 : 0)
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "conflicting-configuration",
      "Another target-owned Clerk configuration call exists outside the exact supported initializer binding.",
      { plan: sourcePlan, snapshot, structure },
    );
  }
  const environmentElsewhere = target.swift.environmentInjections.some(
    (evidence) => evidence.path !== sourcePath,
  );
  if (
    environmentElsewhere ||
    (target.swift.environmentInjections.length > 0 && !structure.hasEnvironment)
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "conflicting-environment",
      "Another Clerk environment injection exists outside the exact WindowGroup root binding.",
      { plan: sourcePlan, snapshot, structure },
    );
  }

  const changes: IOSDirectConfigChanges = {
    clerkKitImport: structure.hasClerkKitImport ? "satisfied" : "insert",
    configuration:
      structure.configurationInsertion.kind === "new-initializer"
        ? "insert-initializer"
        : structure.configurationInsertion.kind === "existing-initializer"
          ? "insert-statement"
          : "verify-existing",
    environment: structure.hasEnvironment ? "satisfied" : "insert",
  };
  const changesSource =
    changes.clerkKitImport === "insert" ||
    changes.configuration !== "verify-existing" ||
    changes.environment === "insert";
  if (changesSource && !options.allowDirty) {
    const dirty = await gitDirtyState(root, snapshot.absolutePath);
    if (dirty === "dirty") {
      return blocked(
        options,
        root,
        projectPath,
        "dirty-source",
        `The planned Swift source ${sourcePath} has existing Git changes; pass the explicit dirty-file override to include it.`,
        { plan: sourcePlan, snapshot, structure },
      );
    }
    if (dirty === "unknown") {
      return blocked(
        options,
        root,
        projectPath,
        "git-state-unknown",
        `Git state for the planned Swift source ${sourcePath} could not be verified.`,
        { plan: sourcePlan, snapshot, structure },
      );
    }
  }
  return {
    snapshot,
    structure,
    plan: makePlan(options, root, projectPath, "ready", {
      sourcePath,
      expectedSourceHash: snapshot.hash,
      changes,
      actions: semanticActions(sourcePath, changes),
    }),
  };
}

export async function planIOSDirectConfig(
  options: IOSDirectConfigPlanOptions,
): Promise<IOSDirectConfigPlan> {
  return (await prepareDirectConfig(options)).plan;
}

function validatedDevelopmentKey(value: string): string | undefined {
  if (value.trim() !== value || !/^pk_test_[A-Za-z0-9+/_=-]+$/.test(value)) return undefined;
  try {
    return decodePublishableKey(value).instanceType === "development" ? value : undefined;
  } catch {
    return undefined;
  }
}

function applyEdits(source: string, edits: SourceEdit[]): string {
  let candidate = source;
  for (const edit of [...edits].sort((a, b) => b.index - a.index)) {
    candidate = `${candidate.slice(0, edit.index)}${edit.text}${candidate.slice(edit.index)}`;
  }
  return candidate;
}

function directConfigCandidate(structure: AppStructure, publishableKey: string): string {
  const edits: SourceEdit[] = [];
  if (!structure.hasClerkKitImport) {
    edits.push({
      index: structure.importInsertion,
      text: `${structure.newline}import ClerkKit`,
    });
  }
  const statement = `Clerk.configure(publishableKey: "${publishableKey}")`;
  if (structure.configurationInsertion.kind === "new-initializer") {
    const insertion = structure.configurationInsertion;
    edits.push({
      index: insertion.index,
      text: `${insertion.memberIndent}init() {${structure.newline}${insertion.statementIndent}${statement}${structure.newline}${insertion.memberIndent}}${structure.newline}${structure.newline}`,
    });
  } else if (structure.configurationInsertion.kind === "existing-initializer") {
    const insertion = structure.configurationInsertion;
    edits.push({
      index: insertion.index,
      text: insertion.multiline
        ? `${structure.newline}${insertion.statementIndent}${statement}`
        : ` ${statement};`,
    });
  }
  if (!structure.hasEnvironment && structure.environmentInsertion) {
    edits.push({
      index: structure.environmentInsertion.index,
      text: structure.environmentInsertion.textBeforeKey,
    });
  }
  return applyEdits(structure.source, edits);
}

function redactedKeyBlocker(
  plan: IOSDirectConfigPlan,
  code: IOSDirectConfigBlockerCode,
  message: string,
): IOSDirectConfigPlan {
  return {
    ...plan,
    status: "blocked",
    actions: [],
    blockers: [{ code, message }],
  };
}

function mutationWithHiddenBytes(
  snapshot: Pick<FileSnapshot, "absolutePath" | "bytes" | "hash" | "mode">,
  candidateBytes: Uint8Array,
  boundary: IOSFileMutationBoundary,
): IOSDirectConfigFileMutation {
  const mutation = {
    absolutePath: snapshot.absolutePath,
    expectedHash: snapshot.hash,
    candidateHash: sha256(candidateBytes),
    mode: snapshot.mode,
  } as IOSDirectConfigFileMutation;
  Object.defineProperties(mutation, {
    boundary: { value: boundary, enumerable: false },
    originalBytes: { value: snapshot.bytes, enumerable: false },
    candidateBytes: { value: candidateBytes, enumerable: false },
  });
  return mutation;
}

function readyPreparedMutation(
  plan: IOSDirectConfigPlan,
  mutation: IOSDirectConfigFileMutation,
  validator: () => Promise<boolean>,
): IOSDirectConfigPreparedMutation {
  const prepared = { status: "ready", plan } as IOSDirectConfigPreparedMutation;
  Object.defineProperty(prepared, "mutation", {
    value: mutation,
    enumerable: false,
  });
  preparedValidators.set(prepared, validator);
  return prepared;
}

async function exactPostcondition(
  plan: IOSDirectConfigPlan,
  publishableKey: string,
  candidateHash: string,
): Promise<boolean> {
  const prepared = await prepareDirectConfig({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    platform: plan.platform,
    allowDirty: true,
  });
  return (
    prepared.plan.status === "ready" &&
    prepared.snapshot?.hash === candidateHash &&
    prepared.structure?.existingPublishableKey === publishableKey &&
    prepared.structure.hasClerkKitImport &&
    prepared.structure.hasEnvironment &&
    prepared.plan.changes?.configuration === "verify-existing" &&
    prepared.plan.changes.clerkKitImport === "satisfied" &&
    prepared.plan.changes.environment === "satisfied"
  );
}

/**
 * @internal Prepare one key-bearing Swift mutation without writing it. The
 * returned plan/result remains redacted; only the non-enumerable mutation
 * bytes are sensitive to accidental output.
 */
export async function prepareIOSDirectConfigMutation(
  plan: IOSDirectConfigPlan,
  publishableKey: string,
): Promise<IOSDirectConfigPreparedMutation> {
  if (plan.status === "blocked") return { status: "blocked", plan };
  if (
    plan.schemaVersion !== 1 ||
    plan.kind !== "clerk-ios-direct-config" ||
    !plan.sourcePath ||
    !plan.expectedSourceHash ||
    !plan.changes
  ) {
    return {
      status: "blocked",
      plan: redactedKeyBlocker(
        plan,
        "invalid-selection",
        "The direct native Apple configuration plan is incomplete or unsupported.",
      ),
    };
  }
  const normalizedKey = validatedDevelopmentKey(publishableKey);
  if (!normalizedKey) {
    let production = false;
    try {
      production = decodePublishableKey(publishableKey).instanceType === "production";
    } catch {
      // The redacted blocker below covers malformed values.
    }
    return {
      status: "blocked",
      plan: redactedKeyBlocker(
        plan,
        production ? "production-publishable-key" : "invalid-publishable-key",
        production
          ? "Automatic direct native Apple configuration accepts a development publishable key only."
          : "A valid Clerk development publishable key is required.",
      ),
    };
  }

  const current = await prepareDirectConfig({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    platform: plan.platform,
    allowDirty: plan.allowDirty,
  });
  if (
    current.plan.status === "blocked" ||
    !current.snapshot ||
    !current.structure ||
    !current.plan.expectedSourceHash
  ) {
    return { status: "blocked", plan: current.plan };
  }
  if (
    current.plan.sourcePath !== plan.sourcePath ||
    current.plan.expectedSourceHash !== plan.expectedSourceHash
  ) {
    return {
      status: "stale",
      plan,
      message: "The selected Swift entry source changed after the plan was created.",
    };
  }
  if (
    current.structure.existingPublishableKey &&
    current.structure.existingPublishableKey !== normalizedKey
  ) {
    return {
      status: "blocked",
      plan: redactedKeyBlocker(
        plan,
        "different-inline-publishable-key",
        "The existing inline development publishable key belongs to a different Clerk application and was preserved.",
      ),
    };
  }

  const candidate = directConfigCandidate(current.structure, normalizedKey);
  const candidateBytes = new TextEncoder().encode(candidate);
  const candidateHash = sha256(candidateBytes);
  if (candidateHash === current.snapshot.hash) {
    return { status: "satisfied", plan };
  }
  const boundary = await prepareIOSFileMutationBoundary(plan.root, current.snapshot.absolutePath);
  if (!boundary) {
    return {
      status: "stale",
      plan,
      message: "The selected Swift entry source moved outside its prepared project boundary.",
    };
  }
  const mutation = mutationWithHiddenBytes(current.snapshot, candidateBytes, boundary);
  return readyPreparedMutation(plan, mutation, async () =>
    exactPostcondition(plan, normalizedKey, candidateHash),
  );
}

/** @internal Validate a committed prepared mutation with the same exact structural parser. */
export async function validatePreparedIOSDirectConfig(
  prepared: IOSDirectConfigPreparedMutation,
): Promise<boolean> {
  return (await preparedValidators.get(prepared)?.()) ?? false;
}

export async function applyIOSDirectConfig(
  plan: IOSDirectConfigPlan,
  publishableKey: string,
  options: IOSDirectConfigApplyOptions = {},
): Promise<IOSDirectConfigApplyResult> {
  const prepared = await prepareIOSDirectConfigMutation(plan, publishableKey);
  if (prepared.status !== "ready") return prepared;

  const mutation: IOSExistingFileMutation = {
    path: prepared.mutation.absolutePath,
    boundary: prepared.mutation.boundary,
    originalBytes: prepared.mutation.originalBytes,
    originalHash: prepared.mutation.expectedHash,
    candidateBytes: prepared.mutation.candidateBytes,
    candidateHash: prepared.mutation.candidateHash,
    mode: prepared.mutation.mode,
  };
  let result;
  try {
    result = await applyIOSExistingFileTransaction(
      [mutation],
      [
        async () => {
          await options.beforePostWriteValidation?.();
          return (
            options.forcePostWriteValidationFailure !== true &&
            (await validatePreparedIOSDirectConfig(prepared))
          );
        },
      ],
      {
        beforeExistingDestinationClaim: options.beforeCommit,
        beforeExistingDestinationInstall: options.beforeCommitInstall,
      },
    );
  } catch (error) {
    if (!(error instanceof IOSFileTransactionError) || error.code !== "commit-failed") throw error;
    return {
      status: "rolled-back",
      plan,
      message: "The direct native Apple source update failed and the original file was restored.",
    };
  }

  if (result.status === "applied") return { status: "applied", plan };
  return {
    status: result.status,
    plan,
    message:
      result.status === "stale"
        ? "The selected Swift entry source changed while the update was being committed."
        : "The direct native Apple source update failed validation and the original file was restored.",
  };
}

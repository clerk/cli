import {
  applyEdits,
  getNodeValue,
  modify,
  parseTree,
  type JSONPath,
  type Node,
  type ParseError,
} from "jsonc-parser";

export const MAX_XCPROJ_BYTES = 15_000_000;

export type XCProjRecord = Record<string, unknown>;

export type XCProjErrorCode =
  | "too-large"
  | "invalid-utf8"
  | "invalid-syntax"
  | "duplicate-key"
  | "invalid-schema"
  | "unsupported-capability"
  | "unsafe-edit";

export class XCProjError extends Error {
  readonly code: XCProjErrorCode;

  constructor(code: XCProjErrorCode, message: string) {
    super(message);
    this.name = "XCProjError";
    this.code = code;
  }
}

export interface ParseXCProjOptions {
  maxBytes?: number;
}

export interface ParsedXCProjSource {
  /** The validated source text. Never include it in diagnostics or logs. */
  source: string;
  root: XCProjRecord;
}

export type XCProjBuildPhaseKind =
  | "apple-script"
  | "frameworks"
  | "headers"
  | "java-archive"
  | "resources"
  | "rez"
  | "compile-sources"
  | "copy"
  | "script";

export interface XCProjBuildPhase {
  kind: XCProjBuildPhaseKind;
  name?: string;
  id?: string;
  raw: string | XCProjRecord;
}

export type XCProjSwiftPackage =
  | {
      kind: "remote";
      repository: string;
      version?: XCProjRecord;
      traits: string[];
      raw: XCProjRecord;
    }
  | {
      kind: "local";
      path: string;
      traits: string[];
      raw: XCProjRecord;
    };

export interface XCProjTarget {
  name: string;
  id: string;
  kind: "native" | "aggregate" | "external-build-system";
  productType?: string;
  buildSettings: Record<string, string | string[]>;
  buildPhases: XCProjBuildPhase[];
  packageProductMembers: XCProjRecord[];
  raw: XCProjRecord;
}

const BUILD_PHASE_KINDS = new Set<XCProjBuildPhaseKind>([
  "apple-script",
  "frameworks",
  "headers",
  "java-archive",
  "resources",
  "rez",
  "compile-sources",
  "copy",
  "script",
]);

const COMPACT_BUILD_PHASE_KINDS = new Set<XCProjBuildPhaseKind>([
  "frameworks",
  "headers",
  "java-archive",
  "resources",
  "rez",
  "compile-sources",
]);

const TARGET_KINDS = new Set(["native", "aggregate", "external-build-system"] as const);
const PACKAGE_VERSION_KEYS = [
  "revision",
  "branch",
  "version",
  "version-range",
  "version-range-min",
  "version-range-max",
  "up-to-next-minor-version",
  "up-to-next-major-version",
] as const;

function schemaError(): never {
  throw new XCProjError(
    "invalid-schema",
    "project.xcproj contains a value with an unsupported schema shape.",
  );
}

export function xcprojRecord(value: unknown): XCProjRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) schemaError();
  return value as XCProjRecord;
}

export function xcprojArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) schemaError();
  return value;
}

export function xcprojString(value: unknown): string {
  if (typeof value !== "string") schemaError();
  return value;
}

export function xcprojStringArray(value: unknown): string[] {
  const values = xcprojArray(value);
  if (!values.every((item): item is string => typeof item === "string")) schemaError();
  return values;
}

function optionalString(record: XCProjRecord, key: string): string | undefined {
  const value = record[key];
  return value === undefined ? undefined : xcprojString(value);
}

function optionalStringArray(record: XCProjRecord, key: string): string[] {
  const value = record[key];
  return value === undefined ? [] : xcprojStringArray(value);
}

function recordArray(value: unknown): XCProjRecord[] {
  return xcprojArray(value).map(xcprojRecord);
}

function optionalRecordArray(record: XCProjRecord, key: string): XCProjRecord[] {
  const value = record[key];
  return value === undefined ? [] : recordArray(value);
}

function validateBuildSettings(value: unknown): Record<string, string | string[]> {
  const record = xcprojRecord(value);
  const settings: Record<string, string | string[]> = {};
  for (const [key, setting] of Object.entries(record)) {
    settings[key] = Array.isArray(setting) ? xcprojStringArray(setting) : xcprojString(setting);
  }
  return settings;
}

function validateConfiguration(value: unknown): void {
  if (typeof value === "string") return;
  const record = xcprojRecord(value);
  xcprojString(record.name);
  optionalString(record, "id");
  if (record.file !== undefined && typeof record.file !== "string") xcprojRecord(record.file);
}

function normalizeBuildPhase(value: unknown): XCProjBuildPhase {
  if (typeof value === "string") {
    if (!COMPACT_BUILD_PHASE_KINDS.has(value as XCProjBuildPhaseKind)) schemaError();
    return { kind: value as XCProjBuildPhaseKind, raw: value };
  }

  const record = xcprojRecord(value);
  const kind = xcprojString(record.kind) as XCProjBuildPhaseKind;
  if (!BUILD_PHASE_KINDS.has(kind)) schemaError();
  return {
    kind,
    name: optionalString(record, "name"),
    id: optionalString(record, "id"),
    raw: record,
  };
}

export function xcprojBuildPhases(target: XCProjRecord): XCProjBuildPhase[] {
  const value = target["build-phases"];
  return value === undefined ? [] : xcprojArray(value).map(normalizeBuildPhase);
}

function validatePackageVersion(value: unknown): XCProjRecord {
  const version = xcprojRecord(value);
  const presentKeys = PACKAGE_VERSION_KEYS.filter((key) => version[key] !== undefined);
  const hasSplitRange =
    presentKeys.includes("version-range-min") || presentKeys.includes("version-range-max");
  const expectedKeyCount = hasSplitRange ? 2 : 1;
  if (presentKeys.length !== expectedKeyCount) schemaError();
  if (
    hasSplitRange &&
    (!presentKeys.includes("version-range-min") || !presentKeys.includes("version-range-max"))
  ) {
    schemaError();
  }
  for (const key of presentKeys) xcprojString(version[key]);
  return version;
}

function normalizePackage(value: unknown): XCProjSwiftPackage {
  const record = xcprojRecord(value);
  const kind = xcprojString(record.kind);
  const traits = optionalStringArray(record, "traits");
  if (kind === "remote") {
    const version =
      record.version === undefined ? undefined : validatePackageVersion(record.version);
    return {
      kind,
      repository: xcprojString(record.repository),
      version,
      traits,
      raw: record,
    };
  }
  if (kind === "local") {
    return { kind, path: xcprojString(record.path), traits, raw: record };
  }
  return schemaError();
}

export function xcprojPackages(root: XCProjRecord): XCProjSwiftPackage[] {
  const value = root.packages;
  return value === undefined ? [] : xcprojArray(value).map(normalizePackage);
}

function validatePackageProductMember(value: unknown): XCProjRecord {
  const member = xcprojRecord(value);
  xcprojString(member["product-name"]);
  optionalString(member, "package");
  optionalString(member, "id");
  optionalString(member, "product-type");
  const buildPhase = xcprojRecord(member["build-phase"]);
  optionalString(buildPhase, "id");
  xcprojString(buildPhase["build-phase"]);
  optionalStringArray(buildPhase, "platforms");
  return member;
}

function normalizeTarget(value: unknown): XCProjTarget {
  const target = xcprojRecord(value);
  const kind = (optionalString(target, "kind") ?? "native") as XCProjTarget["kind"];
  if (!TARGET_KINDS.has(kind)) schemaError();
  if (target["product-type"] !== undefined && target["full-product-type"] !== undefined) {
    schemaError();
  }
  const configurations = target["specialized-configurations"];
  if (configurations !== undefined) xcprojArray(configurations).forEach(validateConfiguration);
  const dependencies = target.dependencies;
  if (dependencies !== undefined) {
    for (const dependency of xcprojArray(dependencies)) {
      if (typeof dependency !== "string") xcprojRecord(dependency);
    }
  }

  return {
    name: xcprojString(target.name),
    id: xcprojString(target.id),
    kind,
    productType:
      optionalString(target, "product-type") ?? optionalString(target, "full-product-type"),
    buildSettings:
      target["build-settings"] === undefined ? {} : validateBuildSettings(target["build-settings"]),
    buildPhases: xcprojBuildPhases(target),
    packageProductMembers: optionalRecordArray(target, "package-product-members").map(
      validatePackageProductMember,
    ),
    raw: target,
  };
}

export function xcprojTargets(root: XCProjRecord): XCProjTarget[] {
  const value = root.targets;
  return value === undefined ? [] : xcprojArray(value).map(normalizeTarget);
}

function validateFileReference(value: unknown): void {
  const reference = xcprojRecord(value);
  optionalString(reference, "kind");
  optionalString(reference, "path");
  optionalString(reference, "name");
  optionalString(reference, "id");
  const children = reference.children;
  if (children !== undefined) xcprojArray(children).forEach(validateFileReference);
  const membership = reference["target-membership"];
  if (membership !== undefined) {
    for (const item of xcprojArray(membership)) {
      if (typeof item !== "string") xcprojRecord(item);
    }
  }
}

function validateRoot(root: XCProjRecord): void {
  const capabilities =
    root["required-capabilities"] === undefined
      ? []
      : xcprojStringArray(root["required-capabilities"]);
  if (capabilities.length > 0) {
    throw new XCProjError(
      "unsupported-capability",
      "project.xcproj requires an unsupported Xcode capability.",
    );
  }

  xcprojString(root["default-configuration"]);
  const localizations = xcprojRecord(root.localizations);
  xcprojString(localizations.development);
  optionalStringArray(localizations, "supported");

  xcprojArray(root.configurations ?? []).forEach(validateConfiguration);
  xcprojArray(root.files).forEach(validateFileReference);
  xcprojPackages(root);
  xcprojTargets(root);
  if (root["build-settings"] !== undefined) validateBuildSettings(root["build-settings"]);
  optionalRecordArray(root, "imported-products");

  if (
    root["build-independent-targets-in-parallel"] !== undefined &&
    typeof root["build-independent-targets-in-parallel"] !== "boolean"
  ) {
    schemaError();
  }
  for (const key of [
    "id",
    "root-group-debug-id",
    "configuration-list-debug-id",
    "organization",
    "class-prefix",
    "products-group",
    "last-upgrade",
    "last-swift-update",
    "last-swift-migration",
  ]) {
    if (root[key] !== undefined && key !== "products-group") optionalString(root, key);
  }
  if (
    root["products-group"] !== undefined &&
    typeof root["products-group"] !== "string" &&
    !Array.isArray(root["products-group"])
  ) {
    schemaError();
  }
  if (Array.isArray(root["products-group"])) xcprojStringArray(root["products-group"]);
}

function validateNoDuplicateKeys(node: Node): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      const value = property.children?.[1];
      if (typeof key !== "string" || !value) schemaError();
      if (seen.has(key)) {
        throw new XCProjError("duplicate-key", "project.xcproj contains duplicate object keys.");
      }
      seen.add(key);
      validateNoDuplicateKeys(value);
    }
    return;
  }
  if (node.type === "array") {
    for (const child of node.children ?? []) validateNoDuplicateKeys(child);
  }
}

function sourceText(source: string | Uint8Array, maxBytes: number): string {
  const byteLength = typeof source === "string" ? Buffer.byteLength(source) : source.byteLength;
  if (byteLength > maxBytes) {
    throw new XCProjError(
      "too-large",
      `project.xcproj exceeds the ${maxBytes} byte inspection limit.`,
    );
  }
  if (typeof source === "string") return source;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new XCProjError("invalid-utf8", "project.xcproj is not valid UTF-8.");
  }
}

export function parseXCProjSource(
  source: string | Uint8Array,
  options: ParseXCProjOptions = {},
): ParsedXCProjSource {
  const text = sourceText(source, options.maxBytes ?? MAX_XCPROJ_BYTES);
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  if (!tree || errors.length > 0) {
    throw new XCProjError("invalid-syntax", "project.xcproj is not valid canonical Xcode JSON.");
  }
  if (tree.type !== "object") schemaError();
  validateNoDuplicateKeys(tree);
  const root = xcprojRecord(getNodeValue(tree));
  validateRoot(root);
  return { source: text, root };
}

export interface ApplyXCProjValueOptions extends ParseXCProjOptions {
  formatting?: {
    insertSpaces?: boolean;
    tabSize?: number;
    eol?: string;
  };
}

/**
 * Applies one JSON-path edit while leaving unrelated bytes and comments intact.
 * Passing `undefined` removes the value at `path`.
 */
export function applyXCProjValue(
  source: string | Uint8Array,
  path: JSONPath,
  value: unknown,
  options: ApplyXCProjValueOptions = {},
): string {
  const parsed = parseXCProjSource(source, options);
  try {
    const edits = modify(parsed.source, [...path], value, {
      formattingOptions: {
        insertSpaces: options.formatting?.insertSpaces ?? true,
        tabSize: options.formatting?.tabSize ?? 2,
        eol: options.formatting?.eol ?? (parsed.source.includes("\r\n") ? "\r\n" : "\n"),
      },
    });
    const candidate = applyEdits(parsed.source, edits);
    parseXCProjSource(candidate, options);
    return candidate;
  } catch (error) {
    if (error instanceof XCProjError) throw error;
    throw new XCProjError("unsafe-edit", "Unable to edit project.xcproj safely.");
  }
}

import {
  applyEdits,
  getNodeValue,
  modify,
  parseTree,
  type JSONPath,
  type Node,
  type ParseError,
} from "jsonc-parser";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";

const MAX_XCPROJ_BYTES = 15_000_000;

type XCProjRecord = Record<string, unknown>;

function xcprojError(message: string): never {
  throw new CliError(`${message} Set up Clerk in Xcode instead.`, {
    code: ERROR_CODE.IOS_SETUP_BLOCKED,
  });
}

type XCProjBuildPhaseKind =
  | "apple-script"
  | "frameworks"
  | "headers"
  | "java-archive"
  | "resources"
  | "rez"
  | "compile-sources"
  | "copy"
  | "script";

interface XCProjBuildPhase {
  kind: XCProjBuildPhaseKind;
  name?: string;
  id?: string;
  raw: string | XCProjRecord;
}

type XCProjSwiftPackage =
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

interface XCProjTarget {
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
  return xcprojError("project.xcproj contains a value with an unsupported shape.");
}

function xcprojRecord(value: unknown): XCProjRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) schemaError();
  return value as XCProjRecord;
}

function xcprojArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) schemaError();
  return value;
}

function xcprojString(value: unknown): string {
  if (typeof value !== "string") schemaError();
  return value;
}

function xcprojStringArray(value: unknown): string[] {
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
  if (record.file !== undefined && typeof record.file !== "string") {
    if (Array.isArray(record.file)) {
      for (const component of xcprojArray(record.file)) {
        if (typeof component === "string") continue;
        xcprojString(xcprojRecord(component).name);
      }
    } else {
      xcprojRecord(record.file);
    }
  }
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

function xcprojBuildPhases(target: XCProjRecord): XCProjBuildPhase[] {
  const value = target["build-phases"];
  return value === undefined ? [] : xcprojArray(value).map(normalizeBuildPhase);
}

type ParsedTargetBuildPhaseReference =
  | { kind: "id"; id: string }
  | { kind: "named"; phaseKind: XCProjBuildPhaseKind; name?: string };

function xcprojNamePathChildNames(value: unknown): string[] | undefined {
  const rawComponents = typeof value === "string" ? value.split("/") : value;
  if (!Array.isArray(rawComponents)) return undefined;
  const components: string[] = [];
  for (const raw of rawComponents) {
    if (typeof raw === "string") {
      if (raw === "." || raw === ".." || (Array.isArray(value) && raw.includes("/"))) {
        return undefined;
      }
      components.push(raw);
      continue;
    }
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      typeof (raw as XCProjRecord).name !== "string"
    ) {
      return undefined;
    }
    components.push((raw as XCProjRecord).name as string);
  }
  return components;
}

function parseTargetBuildPhaseReference(
  value: unknown,
): ParsedTargetBuildPhaseReference | undefined {
  if (typeof value === "string" && value.startsWith("id:")) {
    const id = value.slice("id:".length);
    return id ? { kind: "id", id } : undefined;
  }
  const components = xcprojNamePathChildNames(value);
  if (!components || components.length < 1 || components.length > 2) return undefined;
  const [kind, name] = components;
  if (!BUILD_PHASE_KINDS.has(kind as XCProjBuildPhaseKind)) return undefined;
  return { kind: "named", phaseKind: kind as XCProjBuildPhaseKind, name };
}

/** Resolves Xcode's target-relative build-phase reference against one target. */
export function resolveXCProjTargetBuildPhaseReference(
  target: XCProjTarget,
  value: unknown,
): XCProjBuildPhase | undefined {
  const reference = parseTargetBuildPhaseReference(value);
  if (!reference) return undefined;
  const matches = target.buildPhases.filter((phase) =>
    reference.kind === "id"
      ? phase.id === reference.id
      : phase.kind === reference.phaseKind &&
        // Xcode 27.2 resolves a kind-only reference to the sole phase of that
        // kind even when the phase carries a display name.
        (reference.name === undefined || phase.name === reference.name),
  );
  return matches.length === 1 ? matches[0] : undefined;
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
  if (!parseTargetBuildPhaseReference(buildPhase["build-phase"])) schemaError();
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

// Only shapes this module reads are validated; edits are byte-preserving, so
// fields it never reads can't be damaged.
function validateRoot(root: XCProjRecord): void {
  const capabilities =
    root["required-capabilities"] === undefined
      ? []
      : xcprojStringArray(root["required-capabilities"]);
  if (capabilities.length > 0)
    xcprojError("project.xcproj requires an Xcode capability this setup doesn't support.");
  xcprojArray(root.configurations ?? []).forEach(validateConfiguration);
  xcprojPackages(root);
  xcprojTargets(root);
  if (root["build-settings"] !== undefined) validateBuildSettings(root["build-settings"]);
}

function validateNoDuplicateKeys(node: Node): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      const value = property.children?.[1];
      if (typeof key !== "string" || !value) schemaError();
      if (seen.has(key)) xcprojError("project.xcproj contains duplicate object keys.");
      seen.add(key);
      validateNoDuplicateKeys(value);
    }
    return;
  }
  if (node.type === "array") {
    for (const child of node.children ?? []) validateNoDuplicateKeys(child);
  }
}

function sourceText(source: string | Uint8Array): string {
  const byteLength = typeof source === "string" ? Buffer.byteLength(source) : source.byteLength;
  if (byteLength > MAX_XCPROJ_BYTES) xcprojError("project.xcproj is too large to inspect.");
  if (typeof source === "string") return source;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    return xcprojError("project.xcproj is not valid UTF-8.");
  }
}

export function parseXCProjSource(source: string | Uint8Array): {
  /** The validated source text. Never include it in diagnostics or logs. */
  source: string;
  root: XCProjRecord;
} {
  const text = sourceText(source);
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  if (!tree || errors.length > 0)
    xcprojError("project.xcproj could not be parsed; re-save it in Xcode and retry.");
  if (tree.type !== "object") schemaError();
  validateNoDuplicateKeys(tree);
  const root = xcprojRecord(getNodeValue(tree));
  validateRoot(root);
  return { source: text, root };
}

/**
 * Applies one JSON-path edit while leaving unrelated bytes and comments intact.
 * Passing `undefined` removes the value at `path`.
 */
export function applyXCProjValue(
  source: string | Uint8Array,
  path: JSONPath,
  value: unknown,
): string {
  const parsed = parseXCProjSource(source);
  const edits = modify(parsed.source, [...path], value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: parsed.source.includes("\r\n") ? "\r\n" : "\n",
    },
  });
  const candidate = applyEdits(parsed.source, edits);
  parseXCProjSource(candidate);
  return candidate;
}

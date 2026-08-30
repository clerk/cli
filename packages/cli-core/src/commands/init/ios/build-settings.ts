import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { parse as parseXCConfig } from "@bacons/xcode/xcconfig";
import { pathIsSafelyWithinIOSRoot, pathIsWithinIOSRoot, relativeIOSPath } from "./discovery.ts";
import {
  asString,
  asStringArray,
  asStringRecord,
  resolvePbxFilePath,
  type PbxObject,
  type PbxObjects,
  type PbxParentIndex,
} from "./pbx.ts";
import type {
  IOSBuildConfiguration,
  IOSDiagnostic,
  IOSNativePlatform,
  IOSSourceEvidence,
  IOSValueResolution,
} from "./types.ts";

const MAX_XCCONFIG_DEPTH = 12;
const BUILD_SETTING_VARIABLE = /\$\(([^)]+)\)|\$\{([^}]+)\}/g;
const INSPECTED_BUILD_SETTING_KEYS = [
  "PRODUCT_BUNDLE_IDENTIFIER",
  "DEVELOPMENT_TEAM",
  "CODE_SIGN_ENTITLEMENTS",
  "IPHONEOS_DEPLOYMENT_TARGET",
  "MACOSX_DEPLOYMENT_TARGET",
  "ENABLE_APP_SANDBOX",
  "ENABLE_OUTGOING_NETWORK_CONNECTIONS",
  "SDKROOT",
  "SUPPORTED_PLATFORMS",
] as const;
const MODELED_SUPPORTED_PLATFORM_TOKENS = new Set(["iphoneos", "iphonesimulator", "macosx"]);

interface BuildContext {
  label:
    | "iphoneos/arm64"
    | "iphonesimulator/arm64"
    | "iphonesimulator/x86_64"
    | "macosx/arm64"
    | "macosx/x86_64";
  platform: IOSNativePlatform;
  sdk: "iphoneos" | "iphonesimulator" | "macosx";
  arch: "arm64" | "x86_64";
}

interface BuildSettingsEvaluation {
  settings: Record<string, string>;
  /** Unknown inputs are tracked independently for each inspected setting. */
  settingTaints: Map<string, string[]>;
  /** Unknown inputs that may define any setting not yet seen by the inspector. */
  globalTaints: string[];
  /** Literal assignments after the most recent global taint are authoritative. */
  globalTaintOverrides: Set<string>;
}

type XCConfigOperation =
  | { kind: "include"; path: string; optional: boolean }
  | { kind: "setting"; key: string; value: string; conditions?: XCConfigCondition[] }
  | { kind: "unresolved-continuation" };

const BUILD_CONTEXTS: BuildContext[] = [
  { label: "iphoneos/arm64", platform: "ios", sdk: "iphoneos", arch: "arm64" },
  {
    label: "iphonesimulator/arm64",
    platform: "ios",
    sdk: "iphonesimulator",
    arch: "arm64",
  },
  {
    label: "iphonesimulator/x86_64",
    platform: "ios",
    sdk: "iphonesimulator",
    arch: "x86_64",
  },
  { label: "macosx/arm64", platform: "macos", sdk: "macosx", arch: "arm64" },
  { label: "macosx/x86_64", platform: "macos", sdk: "macosx", arch: "x86_64" },
];

interface XCConfigCondition {
  sdk?: string;
  arch?: string;
  config?: string;
}

function wildcardMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function conditionsMatch(
  conditions: XCConfigCondition[] | undefined,
  configuration: string,
  context: BuildContext,
): boolean {
  return (conditions ?? []).every((condition) => {
    if (condition.sdk && !wildcardMatches(context.sdk, condition.sdk)) return false;
    if (condition.arch && !wildcardMatches(context.arch, condition.arch)) return false;
    if (condition.config && !wildcardMatches(configuration, condition.config)) return false;
    return true;
  });
}

function applySettings(base: Record<string, string>, next: Record<string, string>): void {
  for (const [key, value] of Object.entries(next)) {
    base[key] = value.replace(/\$(?:\(inherited\)|\{inherited\})/gi, base[key] ?? "").trim();
  }
}

function cloneEvaluation(evaluation: BuildSettingsEvaluation): BuildSettingsEvaluation {
  return {
    settings: { ...evaluation.settings },
    settingTaints: cloneSettingTaints(evaluation.settingTaints),
    globalTaints: [...evaluation.globalTaints],
    globalTaintOverrides: new Set(evaluation.globalTaintOverrides),
  };
}

function taintInspectedSettings(evaluation: BuildSettingsEvaluation, taint: string): void {
  evaluation.globalTaints = unique([...evaluation.globalTaints, taint]);
  evaluation.globalTaintOverrides.clear();
  for (const key of INSPECTED_BUILD_SETTING_KEYS) {
    addSettingTaint(evaluation.settingTaints, key, taint);
  }
}

function applyEvaluatedSetting(
  evaluation: BuildSettingsEvaluation,
  key: string,
  value: string,
  conditions: XCConfigCondition[] | undefined,
): void {
  const retainedInheritedOverride =
    evaluation.globalTaintOverrides.has(key) && onlyUsesInheritedBuildSettingVariables(value);
  applySettings(evaluation.settings, { [key]: value });

  // An unconditional literal assignment fully overrides any earlier unknown
  // include for this setting. Inherited or variable-derived values may still
  // depend on the skipped input, so retain their existing taint.
  if ((conditions?.length ?? 0) === 0 && !hasBuildSettingVariable(value)) {
    evaluation.settingTaints.delete(key);
    evaluation.globalTaintOverrides.add(key);
  } else if (!retainedInheritedOverride) {
    evaluation.globalTaintOverrides.delete(key);
  }
}

function onlyUsesInheritedBuildSettingVariables(value: string): boolean {
  const variables = [...value.matchAll(/\$\(([^)]+)\)|\$\{([^}]+)\}/g)].map((match) =>
    String(match[1] ?? match[2]).toLowerCase(),
  );
  return variables.length > 0 && variables.every((variable) => variable === "inherited");
}

function hasBuildSettingVariable(value: string): boolean {
  BUILD_SETTING_VARIABLE.lastIndex = 0;
  const result = BUILD_SETTING_VARIABLE.test(value);
  BUILD_SETTING_VARIABLE.lastIndex = 0;
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function addDiagnosticOnce(diagnostics: IOSDiagnostic[], diagnostic: IOSDiagnostic): void {
  if (
    diagnostics.some(
      (candidate) => candidate.code === diagnostic.code && candidate.message === diagnostic.message,
    )
  ) {
    return;
  }
  diagnostics.push(diagnostic);
}

function parseXCConfigOperations(content: string): XCConfigOperation[] {
  const operations: XCConfigOperation[] = [];
  // @bacons/xcode intentionally exposes includes and assignments separately.
  // Parsing one logical source line at a time retains their interleaving,
  // which is significant because a later include can override an earlier
  // assignment. Xcode replaces a trailing backslash plus newline with a space,
  // including when whitespace or a line comment follows the backslash.
  let logicalLine = "";
  let usedContinuation = false;
  for (const rawLine of content.split(/\r\n|\r|\n/)) {
    const withoutComment = rawLine.replace(/\/\/.*/, "").trimEnd();
    // Xcode also accepts an optional assignment terminator after a
    // continuation marker (`VALUE = first \;`). Remove that terminator before
    // checking for and consuming the final continuation backslash.
    const continuationCandidate = withoutComment.replace(/\\\s*;$/, "\\").trimEnd();
    const continues = continuationCandidate.endsWith("\\");
    const fragment = (continues ? continuationCandidate.slice(0, -1) : withoutComment).trim();
    logicalLine = logicalLine ? `${logicalLine} ${fragment}`.trim() : fragment;
    usedContinuation ||= continues;
    if (continues) continue;

    const line = logicalLine;
    logicalLine = "";
    const parsed = parseXCConfig(line);
    const include = parsed.includes[0]?.include;
    if (include) {
      if (usedContinuation) {
        operations.push({ kind: "unresolved-continuation" });
        usedContinuation = false;
        continue;
      }
      operations.push({
        kind: "include",
        path: include.path,
        optional: include.optional,
      });
      usedContinuation = false;
      continue;
    }
    const setting = parsed.buildSettings[0];
    if (setting) {
      operations.push({
        kind: "setting",
        key: setting.key,
        value: setting.value,
        conditions: setting.conditions,
      });
    } else if (usedContinuation && line) {
      operations.push({ kind: "unresolved-continuation" });
    }
    usedContinuation = false;
  }

  // Xcode accepts a trailing continuation at EOF and removes the final
  // backslash, so parse the accumulated assignment once more.
  if (logicalLine) {
    const parsed = parseXCConfig(logicalLine);
    const setting = parsed.buildSettings[0];
    if (setting) {
      operations.push({
        kind: "setting",
        key: setting.key,
        value: setting.value,
        conditions: setting.conditions,
      });
    } else {
      operations.push({ kind: "unresolved-continuation" });
    }
  }
  return operations;
}

function unresolvedXCConfig(
  root: string,
  path: string,
  diagnostics: IOSDiagnostic[],
  message: string,
  taint: string,
  inherited: BuildSettingsEvaluation,
): BuildSettingsEvaluation {
  addDiagnosticOnce(diagnostics, {
    code: "xcode.unresolved-build-setting",
    severity: "warning",
    message,
    remedy:
      "Check in the required xcconfig and use a literal include path before automating setup.",
    evidence: [{ path: relativeIOSPath(root, path), keyPath: "include" }],
  });
  const evaluation = cloneEvaluation(inherited);
  taintInspectedSettings(evaluation, taint);
  return evaluation;
}

async function readXCConfigSettings(
  root: string,
  path: string,
  configuration: string,
  context: BuildContext,
  diagnostics: IOSDiagnostic[],
  inherited: BuildSettingsEvaluation = {
    settings: {},
    settingTaints: new Map(),
    globalTaints: [],
    globalTaintOverrides: new Set(),
  },
  visited: Set<string> = new Set(),
  depth = 0,
  optional = false,
): Promise<BuildSettingsEvaluation> {
  if (depth >= MAX_XCCONFIG_DEPTH) {
    const unresolved = unresolvedXCConfig(
      root,
      path,
      diagnostics,
      `Could not fully evaluate ${relativeIOSPath(root, path)} because xcconfig includes exceeded the inspection depth limit.`,
      "xcconfig include depth",
      inherited,
    );
    return unresolved;
  }
  if (visited.has(path)) {
    const unresolved = unresolvedXCConfig(
      root,
      path,
      diagnostics,
      `Could not fully evaluate ${relativeIOSPath(root, path)} because its xcconfig includes form a cycle.`,
      "xcconfig include cycle",
      inherited,
    );
    return unresolved;
  }
  if (!(await pathIsSafelyWithinIOSRoot(root, path))) {
    addDiagnosticOnce(diagnostics, {
      code: "xcode.external-path",
      severity: "warning",
      message: `Skipped xcconfig outside the inspected project root: ${path}`,
      evidence: [{ path }],
    });
    const evaluation = cloneEvaluation(inherited);
    // Even an optional include can exist outside the inspected root and
    // override local values. Since we intentionally do not read it, its
    // contribution remains unknown.
    taintInspectedSettings(evaluation, "xcconfig outside project root");
    return evaluation;
  }

  let content: string;
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      if (optional) {
        return cloneEvaluation(inherited);
      }
      const unresolved = unresolvedXCConfig(
        root,
        path,
        diagnostics,
        `Required xcconfig include ${relativeIOSPath(root, path)} does not exist.`,
        "required xcconfig include",
        inherited,
      );
      return unresolved;
    }
    if (file.size > 1_000_000) {
      const unresolved = unresolvedXCConfig(
        root,
        path,
        diagnostics,
        `Could not evaluate ${relativeIOSPath(root, path)} because the xcconfig is too large to inspect safely.`,
        "unreadable xcconfig include",
        inherited,
      );
      return unresolved;
    }
    content = await readFile(path, "utf8");
  } catch {
    const unresolved = unresolvedXCConfig(
      root,
      path,
      diagnostics,
      `Could not read required xcconfig include ${relativeIOSPath(root, path)}.`,
      "unreadable xcconfig include",
      inherited,
    );
    return unresolved;
  }

  const nextVisited = new Set(visited);
  nextVisited.add(path);
  let evaluation = cloneEvaluation(inherited);

  for (const operation of parseXCConfigOperations(content)) {
    if (operation.kind === "unresolved-continuation") {
      taintInspectedSettings(evaluation, "unsupported xcconfig continuation");
      addDiagnosticOnce(diagnostics, {
        code: "xcode.unresolved-build-setting",
        severity: "warning",
        message: `${relativeIOSPath(root, path)} has an xcconfig continuation that could not be evaluated safely.`,
        remedy:
          "Keep continued build-setting values on consecutive lines using a trailing backslash.",
        evidence: [{ path: relativeIOSPath(root, path), keyPath: "continuation" }],
      });
      continue;
    }
    if (operation.kind === "setting") {
      if (!conditionsMatch(operation.conditions, configuration, context)) continue;
      applyEvaluatedSetting(evaluation, operation.key, operation.value, operation.conditions);
      continue;
    }
    // Paths containing build variables cannot be resolved safely without an
    // Xcode build context. Leave those settings unresolved rather than guess.
    if (hasBuildSettingVariable(operation.path)) {
      taintInspectedSettings(evaluation, "variable xcconfig include path");
      addDiagnosticOnce(diagnostics, {
        code: "xcode.unresolved-build-setting",
        severity: "warning",
        message: `${relativeIOSPath(root, path)} has an xcconfig include whose path contains build-setting variables.`,
        remedy: "Use a literal checked-in include path before automating setup.",
        evidence: [{ path: relativeIOSPath(root, path), keyPath: "include" }],
      });
      continue;
    }
    const includePath = resolve(dirname(path), operation.path);
    const included = await readXCConfigSettings(
      root,
      includePath,
      configuration,
      context,
      diagnostics,
      evaluation,
      nextVisited,
      depth + 1,
      operation.optional,
    );
    evaluation = included;
  }

  return evaluation;
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function cloneSettingTaints(source: Map<string, string[]>): Map<string, string[]> {
  return new Map([...source].map(([key, values]) => [key, [...values]]));
}

function addSettingTaint(settingTaints: Map<string, string[]>, key: string, taint: string): void {
  settingTaints.set(key, unique([...(settingTaints.get(key) ?? []), taint]));
}

function settingTaintsFor(evaluation: BuildSettingsEvaluation, key: string): string[] {
  return unique([
    ...(evaluation.settingTaints.get(key) ?? []),
    ...(evaluation.globalTaintOverrides.has(key) ? [] : evaluation.globalTaints),
  ]);
}

function parseInlineBuildSettingKey(
  rawKey: string,
):
  | { key: string; conditions: XCConfigCondition[]; supported: true }
  | { key: string; supported: false } {
  const match = rawKey.match(/^([a-zA-Z_][a-zA-Z0-9_]*)((?:\[[^\]]+\])*)$/);
  if (!match) return { key: rawKey, supported: false };
  const key = match[1];
  if (!key) return { key: rawKey, supported: false };
  const suffix = match[2] ?? "";
  if (!suffix) return { key, conditions: [], supported: true };

  const conditions: XCConfigCondition[] = [];
  let consumed = "";
  for (const conditionMatch of suffix.matchAll(/\[([a-zA-Z]+)=([^\]]+)\]/g)) {
    consumed += conditionMatch[0];
    const rawType = conditionMatch[1];
    const value = conditionMatch[2];
    if (!rawType || !value) return { key, supported: false };
    const type = rawType.toLowerCase();
    if (!["sdk", "arch", "config"].includes(type)) {
      return { key, supported: false };
    }
    if (type === "sdk") conditions.push({ sdk: value });
    if (type === "arch") conditions.push({ arch: value });
    if (type === "config") conditions.push({ config: value });
  }
  if (consumed !== suffix) return { key, supported: false };
  return { key, conditions, supported: true };
}

function applyInlineBuildSettings(
  evaluation: BuildSettingsEvaluation,
  rawSettings: Record<string, string>,
  configuration: string,
  context: BuildContext,
): void {
  const parsed = Object.entries(rawSettings).map(([rawKey, value], order) => ({
    parsedKey: parseInlineBuildSettingKey(rawKey),
    value,
    order,
  }));

  // A PBX buildSettings value is a dictionary, not an ordered instruction
  // stream. Apply unconditional values first, followed by increasingly
  // specific matching conditions. This lets an SDK-qualified value override
  // its base value regardless of serialization order.
  parsed.sort((left, right) => {
    const leftSpecificity =
      left.parsedKey.supported && "conditions" in left.parsedKey
        ? left.parsedKey.conditions.length
        : Number.MAX_SAFE_INTEGER;
    const rightSpecificity =
      right.parsedKey.supported && "conditions" in right.parsedKey
        ? right.parsedKey.conditions.length
        : Number.MAX_SAFE_INTEGER;
    return leftSpecificity - rightSpecificity || left.order - right.order;
  });

  for (const entry of parsed) {
    if (!entry.parsedKey.supported) {
      addSettingTaint(
        evaluation.settingTaints,
        entry.parsedKey.key,
        "unsupported conditional build setting",
      );
      continue;
    }
    if (!conditionsMatch(entry.parsedKey.conditions, configuration, context)) continue;
    applyEvaluatedSetting(evaluation, entry.parsedKey.key, entry.value, entry.parsedKey.conditions);
  }
}

function resolveSetting(
  key: string,
  evaluation: BuildSettingsEvaluation,
  builtins: Record<string, string>,
  evidence: IOSSourceEvidence,
): IOSValueResolution {
  const settings = evaluation.settings;
  const initial = settings[key];
  const taints = settingTaintsFor(evaluation, key);
  if ((initial == null || initial.trim() === "") && taints.length === 0) {
    return { state: "missing", evidence: [evidence] };
  }

  const missingVariables = new Set<string>(taints);
  const resolveValue = (raw: string, stack: Set<string>): string => {
    BUILD_SETTING_VARIABLE.lastIndex = 0;
    return raw.replace(BUILD_SETTING_VARIABLE, (match, parenthesized, braced) => {
      const variableWithModifier = String(parenthesized ?? braced);
      // Xcode build-setting modifiers transform values (for example,
      // `:rfc1034identifier`). Replacing only the base variable would silently
      // produce a different value, so preserve the expression as unresolved.
      if (variableWithModifier.includes(":")) {
        missingVariables.add(variableWithModifier);
        return match;
      }
      const variable = variableWithModifier.split(":", 1)[0] ?? variableWithModifier;
      if (variable.toLowerCase() === "inherited") return "";
      if (stack.has(variable)) {
        missingVariables.add(variable);
        return `$(${variableWithModifier})`;
      }

      const replacement = settings[variable] ?? builtins[variable];
      if (replacement == null) {
        missingVariables.add(variable);
        return `$(${variableWithModifier})`;
      }

      const nextStack = new Set(stack);
      nextStack.add(variable);
      return resolveValue(replacement, nextStack);
    });
  };

  const raw = initial ?? "";
  const value = stripSurroundingQuotes(resolveValue(raw, new Set([key])));
  if (missingVariables.size > 0 || hasBuildSettingVariable(value)) {
    return {
      state: "unresolved",
      raw,
      missingVariables: [...missingVariables].sort(),
      evidence: [evidence],
    };
  }

  return { state: "resolved", value, evidence: [evidence] };
}

interface ConfigurationReference {
  id: string;
  object?: PbxObject;
}

function configurationReferences(
  listId: string | undefined,
  objects: PbxObjects,
  diagnostics: IOSDiagnostic[],
  evidencePath: string,
  owner: string,
): { references: ConfigurationReference[]; complete: boolean } {
  if (!listId) {
    addDiagnosticOnce(diagnostics, {
      code: "xcode.dangling-reference",
      severity: "error",
      message: `${owner} has no XCConfigurationList reference.`,
      remedy: "Repair the Xcode project build-configuration list before automating setup.",
      evidence: [{ path: evidencePath, keyPath: "buildConfigurationList" }],
    });
    return { references: [], complete: false };
  }
  const list = objects[listId];
  if (list?.isa !== "XCConfigurationList") {
    addDiagnosticOnce(diagnostics, {
      code: "xcode.dangling-reference",
      severity: "error",
      message: `${owner} references a missing or invalid XCConfigurationList (${listId}).`,
      remedy: "Repair the Xcode project build-configuration list before automating setup.",
      evidence: [{ path: evidencePath, objectId: listId }],
    });
    return { references: [], complete: false };
  }

  let complete = true;
  const references = asStringArray(list.buildConfigurations).map((id) => {
    const object = objects[id];
    if (object?.isa === "XCBuildConfiguration") return { id, object };
    complete = false;
    addDiagnosticOnce(diagnostics, {
      code: "xcode.dangling-reference",
      severity: "error",
      message: `${owner} references a missing or invalid XCBuildConfiguration (${id}).`,
      remedy:
        "Repair or remove the dangling build-configuration reference before automating setup.",
      evidence: [{ path: evidencePath, objectId: listId, keyPath: "buildConfigurations" }],
    });
    return { id };
  });
  return { references, complete };
}

async function settingsForConfiguration(
  root: string,
  projectPath: string,
  projectDirectory: string,
  groupRootDirectory: string,
  configuration: PbxObject | undefined,
  configurationName: string,
  context: BuildContext,
  objects: PbxObjects,
  parents: PbxParentIndex,
  diagnostics: IOSDiagnostic[],
  inherited: BuildSettingsEvaluation = {
    settings: {},
    settingTaints: new Map(),
    globalTaints: [],
    globalTaintOverrides: new Set(),
  },
): Promise<BuildSettingsEvaluation> {
  let evaluation = cloneEvaluation(inherited);
  if (!configuration) return evaluation;
  const baseReference = asString(configuration.baseConfigurationReference);
  if (baseReference) {
    const configPath = resolvePbxFilePath(
      baseReference,
      objects,
      parents,
      projectDirectory,
      groupRootDirectory,
    );
    if (configPath) {
      if (hasBuildSettingVariable(configPath)) {
        taintInspectedSettings(evaluation, "variable base xcconfig path");
        addDiagnosticOnce(diagnostics, {
          code: "xcode.unresolved-build-setting",
          severity: "warning",
          message: "An XCBuildConfiguration base xcconfig path contains build-setting variables.",
          remedy: "Use a literal checked-in base xcconfig path before automating setup.",
          evidence: [
            {
              path: relativeIOSPath(root, resolve(projectPath, "project.pbxproj")),
              objectId: baseReference,
              keyPath: "baseConfigurationReference",
            },
          ],
        });
      } else {
        evaluation = await readXCConfigSettings(
          root,
          configPath,
          configurationName,
          context,
          diagnostics,
          evaluation,
        );
      }
    } else {
      taintInspectedSettings(evaluation, "unresolved base xcconfig reference");
      addDiagnosticOnce(diagnostics, {
        code: "xcode.dangling-reference",
        severity: "error",
        message: `Could not resolve an XCBuildConfiguration baseConfigurationReference (${baseReference}).`,
        remedy: "Repair the base xcconfig file reference before automating setup.",
        evidence: [
          {
            path: relativeIOSPath(root, resolve(projectPath, "project.pbxproj")),
            objectId: baseReference,
            keyPath: "baseConfigurationReference",
          },
        ],
      });
    }
  }
  applyInlineBuildSettings(
    evaluation,
    asStringRecord(configuration.buildSettings),
    configurationName,
    context,
  );
  return evaluation;
}

export interface InspectedTargetConfiguration {
  model: IOSBuildConfiguration;
  entitlementContexts: EntitlementBuildContext[];
  /** Modeled native platforms declared or inferred for this configuration. */
  supportedPlatforms: IOSNativePlatform[];
  /** Declared Xcode platforms that this CLI does not model for automatic setup. */
  unmodeledPlatforms: string[];
  /** Undefined when resolved platform evidence excludes iOS and macOS. */
  platform?: IOSNativePlatform;
  /** True only when concrete build settings prove this configuration's platform. */
  platformEvidenceComplete: boolean;
  /** Compatibility flag for existing iOS-only mutation planners. */
  isIOS: boolean;
}

export interface EntitlementBuildContext {
  label: string;
  settings: Record<string, string>;
  settingTaints: Map<string, string[]>;
  globalTaints: string[];
  globalTaintOverrides: Set<string>;
  builtins: Record<string, string>;
}

interface EvaluatedBuildContext {
  context: BuildContext;
  evaluation: BuildSettingsEvaluation;
  builtins: Record<string, string>;
}

function resolutionSignature(resolution: IOSValueResolution): string {
  if (resolution.state === "resolved") return `resolved:${resolution.value}`;
  if (resolution.state === "missing") return "missing";
  return `unresolved:${resolution.raw}:${resolution.missingVariables.join(",")}`;
}

function resolutionDisplay(resolution: IOSValueResolution): string {
  if (resolution.state === "resolved") return resolution.value;
  return resolution.state === "missing" ? "<missing>" : "<unresolved>";
}

function resolveSettingAcrossContexts(
  key: string,
  contexts: EvaluatedBuildContext[],
  evidence: IOSSourceEvidence,
  targetName: string,
  configurationName: string,
  diagnostics: IOSDiagnostic[],
  reportConflict = true,
): IOSValueResolution {
  const variants = contexts.map(({ context, evaluation, builtins }) => ({
    context,
    resolution: resolveSetting(key, evaluation, builtins, evidence),
  }));
  const signatures = new Set(variants.map(({ resolution }) => resolutionSignature(resolution)));
  if (signatures.size <= 1)
    return variants[0]?.resolution ?? { state: "missing", evidence: [evidence] };

  if (reportConflict) {
    addDiagnosticOnce(diagnostics, {
      code: "xcode.conflicting-build-setting",
      severity: "warning",
      message: `${targetName} ${configurationName} has different ${key} values by SDK and architecture: ${variants
        .map(({ context, resolution }) => `${context.label}=${resolutionDisplay(resolution)}`)
        .join(", ")}`,
      remedy:
        "Make device and simulator architecture values consistent or select the intended SDK and architecture explicitly.",
      evidence: variants.flatMap(({ resolution }) => resolution.evidence),
    });
  }

  return {
    state: "unresolved",
    raw: variants
      .map(({ context, resolution }) => `${context.label}=${resolutionDisplay(resolution)}`)
      .join("; "),
    missingVariables: unique([
      "sdk/architecture-conditioned build setting",
      ...variants.flatMap(({ resolution }) =>
        resolution.state === "unresolved" ? resolution.missingVariables : [],
      ),
    ]).sort(),
    evidence: variants.flatMap(({ resolution }) => resolution.evidence),
  };
}

function missingConfiguration(
  root: string,
  projectPath: string,
  configurationId: string,
  platform: IOSNativePlatform = "ios",
): InspectedTargetConfiguration {
  const evidence: IOSSourceEvidence = {
    path: relativeIOSPath(root, resolve(projectPath, "project.pbxproj")),
    objectId: configurationId,
    keyPath: "buildConfigurations",
  };
  const missing: IOSValueResolution = { state: "missing", evidence: [evidence] };
  return {
    model: {
      name: `Unresolved (${configurationId})`,
      bundleIdentifier: missing,
      developmentTeam: missing,
      entitlementsPath: missing,
      deploymentTarget: missing,
    },
    entitlementContexts: [],
    supportedPlatforms: [],
    unmodeledPlatforms: [],
    // Preserve the selected fail-closed platform view for a dangling
    // application configuration whose evidence cannot be resolved.
    platform,
    platformEvidenceComplete: false,
    isIOS: platform === "ios",
  };
}

export async function inspectTargetBuildConfigurations(options: {
  root: string;
  projectPath: string;
  groupRootDirectory: string;
  projectObject: PbxObject;
  targetId: string;
  targetObject: PbxObject;
  objects: PbxObjects;
  parents: PbxParentIndex;
  diagnostics: IOSDiagnostic[];
  /** Resolve settings through one platform view while preserving all declared platforms. */
  platform?: IOSNativePlatform;
}): Promise<InspectedTargetConfiguration[]> {
  const {
    root,
    projectPath,
    groupRootDirectory,
    projectObject,
    targetId,
    targetObject,
    objects,
    parents,
    diagnostics,
    platform: requestedPlatform,
  } = options;
  const projectDirectory = dirname(projectPath);
  const pbxprojRelativePath = relativeIOSPath(root, resolve(projectPath, "project.pbxproj"));
  const projectConfigurationReferences = configurationReferences(
    asString(projectObject.buildConfigurationList),
    objects,
    diagnostics,
    pbxprojRelativePath,
    "PBXProject",
  );
  const projectConfigsByName = new Map(
    projectConfigurationReferences.references.flatMap(({ object }) =>
      object ? [[asString(object.name) ?? "", object] as const] : [],
    ),
  );
  const targetName = asString(targetObject.name) ?? "App";
  const targetConfigurationReferences = configurationReferences(
    asString(targetObject.buildConfigurationList),
    objects,
    diagnostics,
    pbxprojRelativePath,
    `Target ${targetName}`,
  );
  const inspected: InspectedTargetConfiguration[] = [];

  for (const targetReference of targetConfigurationReferences.references.sort((a, b) =>
    (asString(a.object?.name) ?? a.id).localeCompare(asString(b.object?.name) ?? b.id),
  )) {
    const targetConfig = targetReference.object;
    if (!targetConfig) {
      inspected.push(
        missingConfiguration(root, projectPath, targetReference.id, requestedPlatform ?? "ios"),
      );
      continue;
    }
    const name = asString(targetConfig.name) ?? "Unnamed";
    const evaluatedContexts: EvaluatedBuildContext[] = [];
    for (const context of BUILD_CONTEXTS) {
      const inherited: BuildSettingsEvaluation = {
        settings: {},
        settingTaints: new Map(),
        globalTaints: [],
        globalTaintOverrides: new Set(),
      };
      const projectSettings = await settingsForConfiguration(
        root,
        projectPath,
        projectDirectory,
        groupRootDirectory,
        projectConfigsByName.get(name),
        name,
        context,
        objects,
        parents,
        diagnostics,
        inherited,
      );
      const evaluation = await settingsForConfiguration(
        root,
        projectPath,
        projectDirectory,
        groupRootDirectory,
        targetConfig,
        name,
        context,
        objects,
        parents,
        diagnostics,
        projectSettings,
      );
      // A dangling project configuration cannot be attributed to Debug or
      // Release, so keep completeness unknown even when another layer has a
      // literal override. This is structural evidence, not an ordered
      // xcconfig include that a later assignment can supersede.
      if (!projectConfigurationReferences.complete) {
        taintInspectedSettings(evaluation, "incomplete project configuration list");
      }

      const productName =
        evaluation.settings.PRODUCT_NAME ?? asString(targetObject.productName) ?? targetName;
      evaluatedContexts.push({
        context,
        evaluation,
        builtins: {
          SRCROOT: projectDirectory,
          PROJECT_DIR: projectDirectory,
          PROJECT_NAME:
            projectPath
              .split(sep)
              .at(-1)
              ?.replace(/\.xcodeproj$/, "") ?? targetName,
          TARGET_NAME: targetName,
          PRODUCT_NAME: productName,
          CONFIGURATION: name,
        },
      });
    }

    if (evaluatedContexts.length === 0) continue;
    const evidence = (setting: string): IOSSourceEvidence => ({
      path: pbxprojRelativePath,
      objectId: targetId,
      keyPath: `buildConfigurations.${name}.buildSettings.${setting}`,
    });
    // Select the automation platform without emitting cross-platform
    // conflicts. Once selected, every inspected setting is resolved only
    // across that platform's device/architecture contexts.
    const initialSupportedPlatformsResolution = resolveSettingAcrossContexts(
      "SUPPORTED_PLATFORMS",
      evaluatedContexts,
      evidence("SUPPORTED_PLATFORMS"),
      targetName,
      name,
      diagnostics,
      false,
    );
    const supportedPlatforms =
      initialSupportedPlatformsResolution.state === "resolved"
        ? initialSupportedPlatformsResolution.value
        : "";
    const supportedPlatformTokens = new Set(
      supportedPlatforms
        .toLowerCase()
        .split(/\s+/)
        .filter((value) => value !== ""),
    );
    const hasIOSPlatform =
      supportedPlatformTokens.has("iphoneos") || supportedPlatformTokens.has("iphonesimulator");
    const hasMacOSPlatform = supportedPlatformTokens.has("macosx");
    const unmodeledPlatforms = [...supportedPlatformTokens]
      .filter((token) => !MODELED_SUPPORTED_PLATFORM_TOKENS.has(token))
      .sort();
    const declaredPlatforms: IOSNativePlatform[] = [
      ...(hasIOSPlatform ? (["ios"] as const) : []),
      ...(hasMacOSPlatform ? (["macos"] as const) : []),
    ];
    const supportedPlatform: IOSNativePlatform | undefined =
      requestedPlatform ?? (hasIOSPlatform ? "ios" : hasMacOSPlatform ? "macos" : undefined);
    const platformCandidateContexts = supportedPlatform
      ? evaluatedContexts.filter(({ context }) => context.platform === supportedPlatform)
      : evaluatedContexts;
    const initialSDKRootResolution = resolveSettingAcrossContexts(
      "SDKROOT",
      platformCandidateContexts,
      evidence("SDKROOT"),
      targetName,
      name,
      diagnostics,
      false,
    );
    const initialSDKRoot =
      initialSDKRootResolution.state === "resolved"
        ? initialSDKRootResolution.value.toLowerCase()
        : "";
    const sdkRootIsAuto = initialSDKRoot === "auto";
    const hasIOSSDK = /iphone(?:os|simulator)/.test(initialSDKRoot);
    const hasMacOSSDK = initialSDKRoot.includes("macosx");
    const hasUnknownPlatformEvidence =
      initialSDKRootResolution.state === "unresolved" ||
      initialSupportedPlatformsResolution.state === "unresolved";
    const hasResolvedUnsupportedEvidence =
      (initialSDKRootResolution.state === "resolved" &&
        initialSDKRoot !== "" &&
        !sdkRootIsAuto &&
        !hasIOSSDK &&
        !hasMacOSSDK) ||
      (initialSupportedPlatformsResolution.state === "resolved" &&
        supportedPlatforms !== "" &&
        !hasIOSPlatform &&
        !hasMacOSPlatform);
    // Existing iOS-capable multiplatform targets intentionally retain the iOS
    // setup path by default. A capability planner may request a macOS view;
    // unknown or contradictory evidence stays incomplete so mutations refuse.
    const supportedClassification: IOSNativePlatform | "unsupported" | undefined =
      initialSupportedPlatformsResolution.state === "resolved" && supportedPlatforms !== ""
        ? requestedPlatform
          ? declaredPlatforms.includes(requestedPlatform)
            ? requestedPlatform
            : "unsupported"
          : (supportedPlatform ?? "unsupported")
        : undefined;
    const sdkClassification: IOSNativePlatform | "unsupported" | undefined =
      initialSDKRootResolution.state === "resolved" && initialSDKRoot !== "" && !sdkRootIsAuto
        ? hasIOSSDK
          ? "ios"
          : hasMacOSSDK
            ? "macos"
            : "unsupported"
        : undefined;
    const concreteClassifications = new Set(
      [supportedClassification, sdkClassification].filter(
        (value): value is IOSNativePlatform | "unsupported" => value !== undefined,
      ),
    );
    const hasMixedUnmodeledPlatforms =
      declaredPlatforms.length > 0 && unmodeledPlatforms.length > 0;
    const platformEvidenceComplete = requestedPlatform
      ? concreteClassifications.size === 1 &&
        concreteClassifications.has(requestedPlatform) &&
        !hasUnknownPlatformEvidence &&
        !hasMixedUnmodeledPlatforms
      : concreteClassifications.size === 1 &&
        !hasUnknownPlatformEvidence &&
        !hasMixedUnmodeledPlatforms;
    const platform: IOSNativePlatform | undefined = requestedPlatform
      ? requestedPlatform
      : concreteClassifications.has("ios")
        ? "ios"
        : concreteClassifications.has("macos")
          ? "macos"
          : hasUnknownPlatformEvidence
            ? (requestedPlatform ?? "ios")
            : concreteClassifications.has("unsupported")
              ? undefined
              : !hasResolvedUnsupportedEvidence
                ? (requestedPlatform ?? "ios")
                : undefined;
    const supportedNativePlatforms: IOSNativePlatform[] = [
      ...declaredPlatforms,
      ...(sdkClassification === "ios" || sdkClassification === "macos" ? [sdkClassification] : []),
    ].filter((value, index, values): value is IOSNativePlatform => values.indexOf(value) === index);
    const platformContexts = platform
      ? evaluatedContexts.filter(({ context }) => context.platform === platform)
      : evaluatedContexts;
    const hasExplicitContextFilter =
      initialSupportedPlatformsResolution.state === "resolved" &&
      platformContexts.some(({ context }) => supportedPlatformTokens.has(context.sdk));
    const activeContexts = hasExplicitContextFilter
      ? platformContexts.filter(({ context }) => supportedPlatformTokens.has(context.sdk))
      : platformContexts;
    const supportedPlatformsResolution = resolveSettingAcrossContexts(
      "SUPPORTED_PLATFORMS",
      activeContexts,
      evidence("SUPPORTED_PLATFORMS"),
      targetName,
      name,
      diagnostics,
    );
    const sdkRootResolution = resolveSettingAcrossContexts(
      "SDKROOT",
      activeContexts,
      evidence("SDKROOT"),
      targetName,
      name,
      diagnostics,
    );
    const deploymentTargetSetting =
      platform === "macos" ? "MACOSX_DEPLOYMENT_TARGET" : "IPHONEOS_DEPLOYMENT_TARGET";
    const deploymentTarget = resolveSettingAcrossContexts(
      deploymentTargetSetting,
      activeContexts,
      evidence(deploymentTargetSetting),
      targetName,
      name,
      diagnostics,
    );

    const model: IOSBuildConfiguration = {
      name,
      bundleIdentifier: resolveSettingAcrossContexts(
        "PRODUCT_BUNDLE_IDENTIFIER",
        activeContexts,
        evidence("PRODUCT_BUNDLE_IDENTIFIER"),
        targetName,
        name,
        diagnostics,
      ),
      developmentTeam: resolveSettingAcrossContexts(
        "DEVELOPMENT_TEAM",
        activeContexts,
        evidence("DEVELOPMENT_TEAM"),
        targetName,
        name,
        diagnostics,
      ),
      entitlementsPath: resolveSettingAcrossContexts(
        "CODE_SIGN_ENTITLEMENTS",
        activeContexts,
        evidence("CODE_SIGN_ENTITLEMENTS"),
        targetName,
        name,
        diagnostics,
      ),
      deploymentTarget,
      ...(platform === "macos"
        ? {
            appSandbox: resolveSettingAcrossContexts(
              "ENABLE_APP_SANDBOX",
              activeContexts,
              evidence("ENABLE_APP_SANDBOX"),
              targetName,
              name,
              diagnostics,
            ),
            outgoingNetworkConnections: resolveSettingAcrossContexts(
              "ENABLE_OUTGOING_NETWORK_CONNECTIONS",
              activeContexts,
              evidence("ENABLE_OUTGOING_NETWORK_CONNECTIONS"),
              targetName,
              name,
              diagnostics,
            ),
          }
        : {}),
    };
    const relevantSettings: Array<[string, IOSValueResolution]> = [
      ["PRODUCT_BUNDLE_IDENTIFIER", model.bundleIdentifier],
      ["DEVELOPMENT_TEAM", model.developmentTeam],
      ["CODE_SIGN_ENTITLEMENTS", model.entitlementsPath],
      [deploymentTargetSetting, model.deploymentTarget],
      ["SDKROOT", sdkRootResolution],
      ["SUPPORTED_PLATFORMS", supportedPlatformsResolution],
    ];
    if (platform === "macos") {
      relevantSettings.push(
        ["ENABLE_APP_SANDBOX", model.appSandbox!],
        ["ENABLE_OUTGOING_NETWORK_CONNECTIONS", model.outgoingNetworkConnections!],
      );
    }
    for (const [setting, resolution] of relevantSettings) {
      if (resolution.state !== "unresolved") continue;
      addDiagnosticOnce(diagnostics, {
        code: "xcode.unresolved-build-setting",
        severity: "warning",
        message: `${targetName} ${name} has an unresolved ${setting} value (${resolution.missingVariables.join(", ") || "unknown variable"}).`,
        remedy: "Make the setting resolvable from the project or its checked-in xcconfig files.",
        evidence: resolution.evidence,
      });
    }

    inspected.push({
      model,
      entitlementContexts: activeContexts.map(({ context, evaluation, builtins }) => ({
        label: context.label,
        settings: { ...evaluation.settings },
        settingTaints: cloneSettingTaints(evaluation.settingTaints),
        globalTaints: [...evaluation.globalTaints],
        globalTaintOverrides: new Set(evaluation.globalTaintOverrides),
        builtins: { ...builtins },
      })),
      supportedPlatforms: supportedNativePlatforms,
      unmodeledPlatforms,
      platform,
      platformEvidenceComplete,
      isIOS: platform === "ios",
    });
  }

  return inspected;
}

export function addBuildSettingConflictDiagnostics(
  targetName: string,
  configurations: IOSBuildConfiguration[],
  diagnostics: IOSDiagnostic[],
): void {
  const checks: Array<[string, (config: IOSBuildConfiguration) => IOSValueResolution]> = [
    ["PRODUCT_BUNDLE_IDENTIFIER", (config) => config.bundleIdentifier],
    ["DEVELOPMENT_TEAM", (config) => config.developmentTeam],
    ["CODE_SIGN_ENTITLEMENTS", (config) => config.entitlementsPath],
  ];

  for (const [setting, select] of checks) {
    const values = configurations.map((configuration) => ({
      name: configuration.name,
      resolution: select(configuration),
    }));
    const signatures = new Set(
      values.map(({ resolution }) =>
        resolution.state === "resolved"
          ? `resolved:${resolution.value}`
          : resolution.state === "unresolved"
            ? `unresolved:${resolution.raw}`
            : "missing",
      ),
    );
    if (signatures.size <= 1) continue;

    diagnostics.push({
      code: "xcode.conflicting-build-setting",
      severity: "warning",
      message: `${targetName} has different ${setting} values across build configurations: ${values
        .map(
          ({ name, resolution }) =>
            `${name}=${
              resolution.state === "resolved"
                ? resolution.value
                : resolution.state === "unresolved"
                  ? "<unresolved>"
                  : "<missing>"
            }`,
        )
        .join(", ")}`,
      remedy: "Select one configuration or make the values consistent before automating setup.",
      evidence: values.flatMap((item) => item.resolution.evidence),
    });
  }
}

export function resolveEntitlementsAbsolutePath(
  root: string,
  projectPath: string,
  resolution: IOSValueResolution,
): string | undefined {
  if (resolution.state !== "resolved") return undefined;
  const path = resolution.value;
  const absolute = resolve(dirname(projectPath), path);
  return pathIsWithinIOSRoot(root, absolute) ? absolute : undefined;
}

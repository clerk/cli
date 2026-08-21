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
} from "./pbx.ts";
import type {
  IOSBuildConfiguration,
  IOSDiagnostic,
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
  "SDKROOT",
  "SUPPORTED_PLATFORMS",
] as const;
const INSPECTED_BUILD_SETTINGS = new Set<string>(INSPECTED_BUILD_SETTING_KEYS);

interface BuildContext {
  label: "iphoneos" | "iphonesimulator";
  sdk: "iphoneos" | "iphonesimulator";
  arch: "arm64";
}

interface BuildSettingsEvaluation {
  settings: Record<string, string>;
  /** Unknown inputs are tracked independently for each inspected setting. */
  settingTaints: Map<string, string[]>;
}

type XCConfigOperation =
  | { kind: "include"; path: string; optional: boolean }
  | { kind: "setting"; key: string; value: string; conditions?: XCConfigCondition[] };

const BUILD_CONTEXTS: BuildContext[] = [
  { label: "iphoneos", sdk: "iphoneos", arch: "arm64" },
  { label: "iphonesimulator", sdk: "iphonesimulator", arch: "arm64" },
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
  };
}

function taintInspectedSettings(evaluation: BuildSettingsEvaluation, taint: string): void {
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
  applySettings(evaluation.settings, { [key]: value });
  if (!INSPECTED_BUILD_SETTINGS.has(key)) return;

  // An unconditional literal assignment fully overrides any earlier unknown
  // include for this setting. Inherited or variable-derived values may still
  // depend on the skipped input, so retain their existing taint.
  if ((conditions?.length ?? 0) === 0 && !hasBuildSettingVariable(value)) {
    evaluation.settingTaints.delete(key);
  }
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
  // Parsing one source line at a time retains their interleaving, which is
  // significant because a later include can override an earlier assignment.
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseXCConfig(line);
    const include = parsed.includes[0]?.include;
    if (include) {
      operations.push({
        kind: "include",
        path: include.path,
        optional: include.optional,
      });
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
  inherited: BuildSettingsEvaluation = { settings: {}, settingTaints: new Map() },
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
  const taints = evaluation.settingTaints.get(key) ?? [];
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
  parents: Map<string, string>,
  diagnostics: IOSDiagnostic[],
  inherited: BuildSettingsEvaluation = {
    settings: {},
    settingTaints: new Map(),
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
  settings: Record<string, string>;
  isIOS: boolean;
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
): IOSValueResolution {
  const variants = contexts.map(({ context, evaluation, builtins }) => ({
    context,
    resolution: resolveSetting(key, evaluation, builtins, evidence),
  }));
  const signatures = new Set(variants.map(({ resolution }) => resolutionSignature(resolution)));
  if (signatures.size <= 1)
    return variants[0]?.resolution ?? { state: "missing", evidence: [evidence] };

  addDiagnosticOnce(diagnostics, {
    code: "xcode.conflicting-build-setting",
    severity: "warning",
    message: `${targetName} ${configurationName} has different ${key} values by SDK: ${variants
      .map(({ context, resolution }) => `${context.label}=${resolutionDisplay(resolution)}`)
      .join(", ")}`,
    remedy: "Make device and simulator values consistent or select the intended SDK explicitly.",
    evidence: variants.flatMap(({ resolution }) => resolution.evidence),
  });

  return {
    state: "unresolved",
    raw: variants
      .map(({ context, resolution }) => `${context.label}=${resolutionDisplay(resolution)}`)
      .join("; "),
    missingVariables: unique([
      "sdk-conditioned build setting",
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
    settings: {},
    // The product type identifies this as an application target, but the
    // dangling configuration does not contain enough evidence to exclude iOS.
    isIOS: true,
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
  parents: Map<string, string>;
  diagnostics: IOSDiagnostic[];
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
      inspected.push(missingConfiguration(root, projectPath, targetReference.id));
      continue;
    }
    const name = asString(targetConfig.name) ?? "Unnamed";
    const evaluatedContexts: EvaluatedBuildContext[] = [];
    for (const context of BUILD_CONTEXTS) {
      const inherited: BuildSettingsEvaluation = {
        settings: {},
        settingTaints: new Map(),
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

    const deviceContext = evaluatedContexts[0];
    if (!deviceContext) continue;
    const evidence = (setting: string): IOSSourceEvidence => ({
      path: pbxprojRelativePath,
      objectId: targetId,
      keyPath: `buildConfigurations.${name}.buildSettings.${setting}`,
    });
    const supportedPlatformsResolution = resolveSettingAcrossContexts(
      "SUPPORTED_PLATFORMS",
      evaluatedContexts,
      evidence("SUPPORTED_PLATFORMS"),
      targetName,
      name,
      diagnostics,
    );
    const supportedPlatforms =
      supportedPlatformsResolution.state === "resolved" ? supportedPlatformsResolution.value : "";
    const activeContexts =
      supportedPlatformsResolution.state === "resolved" &&
      supportedPlatforms.trim() !== "" &&
      !/\biphonesimulator\b/.test(supportedPlatforms)
        ? [deviceContext]
        : evaluatedContexts;
    const sdkRootResolution = resolveSettingAcrossContexts(
      "SDKROOT",
      activeContexts,
      evidence("SDKROOT"),
      targetName,
      name,
      diagnostics,
    );
    const deploymentTarget = resolveSettingAcrossContexts(
      "IPHONEOS_DEPLOYMENT_TARGET",
      activeContexts,
      evidence("IPHONEOS_DEPLOYMENT_TARGET"),
      targetName,
      name,
      diagnostics,
    );
    const sdkRoot = sdkRootResolution.state === "resolved" ? sdkRootResolution.value : "";
    const hasIOSSDK = sdkRootResolution.state === "resolved" && sdkRoot.includes("iphoneos");
    const hasIOSPlatform =
      supportedPlatformsResolution.state === "resolved" &&
      /iphone(?:os|simulator)/.test(supportedPlatforms);
    const hasPositiveIOSEvidence =
      deploymentTarget.state !== "missing" || hasIOSSDK || hasIOSPlatform;
    const hasUnknownPlatformEvidence =
      sdkRootResolution.state === "unresolved" ||
      supportedPlatformsResolution.state === "unresolved";
    const hasResolvedNonIOSEvidence =
      (sdkRootResolution.state === "resolved" && sdkRoot !== "" && !hasIOSSDK) ||
      (supportedPlatformsResolution.state === "resolved" &&
        supportedPlatforms !== "" &&
        !hasIOSPlatform);
    const explicitlyNonIOS =
      !hasPositiveIOSEvidence && !hasUnknownPlatformEvidence && hasResolvedNonIOSEvidence;

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
    };
    const relevantSettings: Array<[string, IOSValueResolution]> = [
      ["PRODUCT_BUNDLE_IDENTIFIER", model.bundleIdentifier],
      ["DEVELOPMENT_TEAM", model.developmentTeam],
      ["CODE_SIGN_ENTITLEMENTS", model.entitlementsPath],
      ["IPHONEOS_DEPLOYMENT_TARGET", model.deploymentTarget],
      ["SDKROOT", sdkRootResolution],
      ["SUPPORTED_PLATFORMS", supportedPlatformsResolution],
    ];
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
      settings: deviceContext.evaluation.settings,
      isIOS: !explicitlyNonIOS,
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

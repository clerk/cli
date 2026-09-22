import { basename, dirname, relative, resolve } from "node:path";
import {
  inspectTargetBuildConfigurations,
  type InspectedTargetConfiguration,
} from "./build-settings.ts";
import type { PbxObject, PbxObjects } from "./pbx.ts";
import type { IOSDiagnostic, IOSNativePlatform } from "./types.ts";
import {
  XCProjError,
  xcprojArray,
  xcprojRecord,
  xcprojString,
  type XCProjRecord,
  type XCProjTarget,
} from "./xcproj.ts";

interface XCProjConfiguration {
  name: string;
  file?: string | XCProjRecord;
}

export interface InspectXCProjTargetBuildConfigurationsOptions {
  /** Root directory being inspected by Clerk. */
  root: string;
  /** The containing .xcodeproj directory. */
  projectPath: string;
  /** The resolved project.xcproj document. */
  projectDocumentPath: string;
  /** Parsed and schema-validated project.xcproj root object. */
  project: XCProjRecord;
  /** Normalized target returned by xcprojTargets(). */
  target: XCProjTarget;
  diagnostics: IOSDiagnostic[];
  platform?: IOSNativePlatform;
}

function invalidSchema(): never {
  throw new XCProjError(
    "invalid-schema",
    "project.xcproj contains an unsupported build-configuration shape.",
  );
}

function buildSettings(value: unknown): Record<string, string | string[]> {
  if (value === undefined) return {};
  const record = xcprojRecord(value);
  const result: Record<string, string | string[]> = {};
  for (const [key, setting] of Object.entries(record)) {
    if (typeof setting === "string") {
      result[key] = setting;
      continue;
    }
    if (!Array.isArray(setting) || !setting.every((item) => typeof item === "string")) {
      invalidSchema();
    }
    result[key] = setting;
  }
  return result;
}

function pbxBuildSettings(
  settings: Readonly<Record<string, string | string[]>>,
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
}

function configuration(value: unknown): XCProjConfiguration {
  if (typeof value === "string") {
    if (value === "") invalidSchema();
    return { name: value };
  }
  const record = xcprojRecord(value);
  const name = xcprojString(record.name);
  if (name === "") invalidSchema();
  if (record.file === "") invalidSchema();
  return {
    name,
    file:
      record.file === undefined
        ? undefined
        : typeof record.file === "string"
          ? record.file
          : xcprojRecord(record.file),
  };
}

function configurations(value: unknown, requireAtLeastOne = true): XCProjConfiguration[] {
  const parsed = xcprojArray(value ?? []).map(configuration);
  const names = new Set<string>();
  for (const item of parsed) {
    if (names.has(item.name)) invalidSchema();
    names.add(item.name);
  }
  if (requireAtLeastOne && parsed.length === 0) invalidSchema();
  return parsed;
}

function simpleNamePath(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const components: string[] = [];
  for (const component of value) {
    if (typeof component === "string") {
      components.push(component);
      continue;
    }
    if (
      typeof component === "object" &&
      component !== null &&
      !Array.isArray(component) &&
      typeof (component as XCProjRecord).name === "string"
    ) {
      components.push((component as XCProjRecord).name as string);
      continue;
    }
    return undefined;
  }
  return components.join("/");
}

/**
 * Resolve the compact, path-based form emitted for ordinary checked-in
 * xcconfig files. Object-ID anchors require the full groups-and-files graph;
 * leave those unresolved so the shared evaluator fails closed.
 */
function projectReferencePath(
  projectDirectory: string,
  parent: string,
  path: string,
): string | undefined {
  if (!path || /^<(?:PRODUCTS|SDK|DEVELOPER)>\//.test(path)) return undefined;
  if (path.startsWith("<PROJECT>/")) {
    return resolve(projectDirectory, path.slice("<PROJECT>/".length));
  }
  if (path.startsWith("<")) return undefined;
  return resolve(parent, path);
}

function normalizeConfigurationReferenceToken(token: string): string {
  return token.replaceAll("\\", "/").replace(/^\.\//, "");
}

function configurationFileIndex(projectPath: string, project: XCProjRecord): Map<string, string[]> {
  const projectDirectory = dirname(projectPath);
  const paths = new Map<string, Set<string>>();
  const add = (token: string, path: string): void => {
    const normalizedToken = normalizeConfigurationReferenceToken(token);
    if (!normalizedToken) return;
    const matches = paths.get(normalizedToken) ?? new Set<string>();
    matches.add(path);
    paths.set(normalizedToken, matches);
  };
  const logicalChildPath = (parent: string, child: string): string =>
    parent ? `${parent}/${child}` : child;
  const visit = (raw: unknown, parent: string, logicalParent: string): void => {
    const reference = xcprojRecord(raw);
    const kind = typeof reference.kind === "string" ? reference.kind : "file";
    const path = typeof reference.path === "string" ? reference.path : "";
    if (kind === "group") {
      const groupDirectory = path ? projectReferencePath(projectDirectory, parent, path) : parent;
      if (!groupDirectory) return;
      const logicalName =
        typeof reference.name === "string" && reference.name
          ? reference.name
          : path
            ? basename(path.replaceAll("\\", "/"))
            : "";
      const logicalGroupPath = logicalName
        ? logicalChildPath(logicalParent, logicalName)
        : logicalParent;
      for (const child of xcprojArray(reference.children ?? [])) {
        visit(child, groupDirectory, logicalGroupPath);
      }
      return;
    }
    if (kind !== "file" || !path) return;
    const absolutePath = projectReferencePath(projectDirectory, parent, path);
    if (!absolutePath) return;
    const displayName = typeof reference.name === "string" ? reference.name : basename(path);
    add(displayName, absolutePath);
    add(path, absolutePath);
    add(logicalChildPath(logicalParent, displayName), absolutePath);
    add(relative(projectDirectory, absolutePath), absolutePath);
  };
  for (const reference of xcprojArray(project.files ?? [])) {
    visit(reference, projectDirectory, "");
  }
  return new Map([...paths].map(([token, matches]) => [token, [...matches].sort()] as const));
}

function configurationFilePath(
  file: string | XCProjRecord | undefined,
  indexedFiles: ReadonlyMap<string, string[]>,
): string | undefined {
  if (!file) return undefined;
  if (typeof file === "string") {
    const matches = indexedFiles.get(normalizeConfigurationReferenceToken(file)) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  }
  const anchor = simpleNamePath(file.anchor);
  const relativePath = simpleNamePath(file["relative-path"]);
  if (!anchor || anchor.startsWith("id:") || relativePath === undefined) return undefined;
  const token = normalizeConfigurationReferenceToken(
    relativePath ? `${anchor}/${relativePath}` : anchor,
  );
  const matches = indexedFiles.get(token) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function attachBaseConfiguration(
  objects: PbxObjects,
  configurationObject: PbxObject,
  file: string | XCProjRecord | undefined,
  indexedFiles: ReadonlyMap<string, string[]>,
  referenceId: string,
): void {
  if (!file) return;
  configurationObject.baseConfigurationReference = referenceId;
  const path = configurationFilePath(file, indexedFiles);
  if (!path) return;
  objects[referenceId] = {
    isa: "PBXFileReference",
    path,
    sourceTree: "<absolute>",
  };
}

/**
 * Adapts Xcode's JSON project build-setting representation to the existing
 * evaluator. The compatibility objects are read-only and are never serialized
 * back to either project format.
 */
export async function inspectXCProjTargetBuildConfigurations(
  options: InspectXCProjTargetBuildConfigurationsOptions,
): Promise<InspectedTargetConfiguration[]> {
  const { project, target } = options;
  const projectConfigurations = configurations(project.configurations);
  const targetSpecializations = configurations(
    target.raw["specialized-configurations"] ?? [],
    false,
  );
  const specializationByName = new Map(targetSpecializations.map((item) => [item.name, item]));
  for (const specialized of targetSpecializations) {
    if (!projectConfigurations.some(({ name }) => name === specialized.name)) invalidSchema();
  }

  const objects: PbxObjects = {};
  const projectConfigurationIds: string[] = [];
  const targetConfigurationIds: string[] = [];
  const projectSettings = buildSettings(project["build-settings"]);
  const indexedFiles = configurationFileIndex(options.projectPath, project);

  for (const [index, projectConfiguration] of projectConfigurations.entries()) {
    const projectConfigurationId = `__xcproj_project_configuration_${index}`;
    const targetConfigurationId = `__xcproj_target_configuration_${index}`;
    const projectBaseReferenceId = `__xcproj_project_xcconfig_${index}`;
    const targetBaseReferenceId = `__xcproj_target_xcconfig_${index}`;
    const targetSpecialization = specializationByName.get(projectConfiguration.name);

    const projectConfigurationObject: PbxObject = {
      isa: "XCBuildConfiguration",
      name: projectConfiguration.name,
      buildSettings: pbxBuildSettings(projectSettings),
    };
    attachBaseConfiguration(
      objects,
      projectConfigurationObject,
      projectConfiguration.file,
      indexedFiles,
      projectBaseReferenceId,
    );
    objects[projectConfigurationId] = projectConfigurationObject;
    projectConfigurationIds.push(projectConfigurationId);

    const targetConfigurationObject: PbxObject = {
      isa: "XCBuildConfiguration",
      name: projectConfiguration.name,
      buildSettings: pbxBuildSettings(target.buildSettings),
    };
    attachBaseConfiguration(
      objects,
      targetConfigurationObject,
      targetSpecialization?.file,
      indexedFiles,
      targetBaseReferenceId,
    );
    objects[targetConfigurationId] = targetConfigurationObject;
    targetConfigurationIds.push(targetConfigurationId);
  }

  const projectListId = "__xcproj_project_configuration_list";
  const targetListId = "__xcproj_target_configuration_list";
  objects[projectListId] = {
    isa: "XCConfigurationList",
    buildConfigurations: projectConfigurationIds,
  };
  objects[targetListId] = {
    isa: "XCConfigurationList",
    buildConfigurations: targetConfigurationIds,
  };

  return inspectTargetBuildConfigurations({
    root: options.root,
    projectPath: options.projectPath,
    projectDocumentPath: options.projectDocumentPath,
    groupRootDirectory: dirname(options.projectPath),
    projectObject: {
      isa: "PBXProject",
      buildConfigurationList: projectListId,
    },
    targetId: target.id,
    targetObject: {
      isa: "PBXNativeTarget",
      name: target.name,
      productName: target.name,
      buildConfigurationList: targetListId,
    },
    objects,
    parents: new Map(),
    diagnostics: options.diagnostics,
    platform: options.platform,
  });
}

import { basename, dirname, resolve } from "node:path";
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

type XCProjConfigurationFile = string | unknown[] | XCProjRecord;

interface XCProjConfiguration {
  name: string;
  file?: XCProjConfigurationFile;
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
  const file = record.file;
  if (Array.isArray(file) && !namePathComponents(file)) invalidSchema();
  return {
    name,
    file:
      file === undefined
        ? undefined
        : typeof file === "string" || Array.isArray(file)
          ? file
          : xcprojRecord(file),
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

type NamePathComponent = { kind: "child"; name: string } | { kind: "relative"; value: "." | ".." };

interface IndexedProjectReference {
  path: string;
}

interface ConfigurationReferenceIndex {
  referencesById: ReadonlyMap<string, IndexedProjectReference[]>;
  referencesByNamePath: ReadonlyMap<string, IndexedProjectReference[]>;
}

function namePathComponents(value: unknown): NamePathComponent[] | undefined {
  const rawComponents = typeof value === "string" ? value.split("/") : value;
  if (!Array.isArray(rawComponents)) return undefined;
  const components: NamePathComponent[] = [];
  for (const component of rawComponents) {
    if (typeof component === "string") {
      components.push(
        component === "." || component === ".."
          ? { kind: "relative", value: component }
          : { kind: "child", name: component },
      );
      continue;
    }
    if (
      typeof component === "object" &&
      component !== null &&
      !Array.isArray(component) &&
      typeof (component as XCProjRecord).name === "string"
    ) {
      components.push({ kind: "child", name: (component as XCProjRecord).name as string });
      continue;
    }
    return undefined;
  }
  return components;
}

function fileSystemNamePath(value: unknown): string | undefined {
  const components = namePathComponents(value);
  if (!components) return undefined;
  return components
    .map((component) => (component.kind === "child" ? component.name : component.value))
    .join("/");
}

function namePathKey(components: readonly string[]): string {
  return JSON.stringify(components);
}

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

function configurationReferenceIndex(
  projectPath: string,
  project: XCProjRecord,
): ConfigurationReferenceIndex {
  const projectDirectory = dirname(projectPath);
  const referencesById = new Map<string, IndexedProjectReference[]>();
  const referencesByNamePath = new Map<string, IndexedProjectReference[]>();
  const addReference = (
    logicalPath: readonly string[],
    path: string,
    id: unknown,
    hasLogicalName: boolean,
  ): void => {
    const indexed = { path };
    if (hasLogicalName) {
      const key = namePathKey(logicalPath);
      const namedMatches = referencesByNamePath.get(key) ?? [];
      namedMatches.push(indexed);
      referencesByNamePath.set(key, namedMatches);
    }
    if (typeof id === "string" && id) {
      const idMatches = referencesById.get(id) ?? [];
      idMatches.push(indexed);
      referencesById.set(id, idMatches);
    }
  };
  const logicalChildPath = (parent: readonly string[], child: string): string[] => [
    ...parent,
    child,
  ];
  const visit = (raw: unknown, parent: string, logicalParent: readonly string[]): void => {
    const reference = xcprojRecord(raw);
    const kind = typeof reference.kind === "string" ? reference.kind : "file-reference";
    const path = typeof reference.path === "string" ? reference.path : "";
    const logicalName =
      typeof reference.name === "string" && reference.name
        ? reference.name
        : path
          ? basename(path.replaceAll("\\", "/"))
          : "";
    const logicalPath = logicalName
      ? logicalChildPath(logicalParent, logicalName)
      : [...logicalParent];

    if (kind === "group") {
      const groupDirectory = path ? projectReferencePath(projectDirectory, parent, path) : parent;
      if (!groupDirectory) return;
      addReference(logicalPath, groupDirectory, reference.id, Boolean(logicalName));
      for (const child of xcprojArray(reference.children ?? [])) {
        visit(child, groupDirectory, logicalPath);
      }
      return;
    }

    if (kind === "folder") {
      const folderDirectory = path ? projectReferencePath(projectDirectory, parent, path) : parent;
      if (!folderDirectory) return;
      addReference(logicalPath, folderDirectory, reference.id, Boolean(logicalName));
      return;
    }

    if ((kind !== "file" && kind !== "file-reference") || !path) return;
    const absolutePath = projectReferencePath(projectDirectory, parent, path);
    if (!absolutePath) return;
    addReference(logicalPath, absolutePath, reference.id, Boolean(logicalName));
  };
  for (const reference of xcprojArray(project.files ?? [])) {
    visit(reference, projectDirectory, []);
  }
  return {
    referencesById,
    referencesByNamePath,
  };
}

function anchoredReferencePath(
  anchor: unknown,
  index: ConfigurationReferenceIndex,
): string | undefined {
  if (typeof anchor === "string" && anchor.startsWith("id:")) {
    const matches = index.referencesById.get(anchor.slice("id:".length)) ?? [];
    return matches.length === 1 ? matches[0]?.path : undefined;
  }

  const components = namePathComponents(anchor);
  if (!components) return undefined;
  const logicalPath: string[] = [];
  let match: IndexedProjectReference | undefined;
  for (const component of components) {
    if (component.kind === "child") {
      logicalPath.push(component.name);
    } else if (component.value === "..") {
      if (logicalPath.length === 0) return undefined;
      logicalPath.pop();
    }
    if (logicalPath.length === 0) {
      match = undefined;
      continue;
    }
    const matches = index.referencesByNamePath.get(namePathKey(logicalPath)) ?? [];
    if (matches.length !== 1) return undefined;
    match = matches[0];
  }
  return match?.path;
}

function configurationFilePath(
  file: XCProjConfigurationFile | undefined,
  index: ConfigurationReferenceIndex,
): string | undefined {
  if (!file) return undefined;
  if (typeof file === "string" || Array.isArray(file)) return anchoredReferencePath(file, index);
  const anchorPath = anchoredReferencePath(file.anchor, index);
  const relativePath = fileSystemNamePath(file["relative-path"]);
  if (!anchorPath || relativePath === undefined) return undefined;
  return resolve(anchorPath, relativePath);
}

function attachBaseConfiguration(
  objects: PbxObjects,
  configurationObject: PbxObject,
  file: XCProjConfigurationFile | undefined,
  index: ConfigurationReferenceIndex,
  referenceId: string,
): void {
  if (!file) return;
  configurationObject.baseConfigurationReference = referenceId;
  const path = configurationFilePath(file, index);
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
  const referenceIndex = configurationReferenceIndex(options.projectPath, project);

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
      referenceIndex,
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
      referenceIndex,
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

import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parsePbxProject } from "@bacons/xcode/json";
import {
  generatedProjectKind,
  selectedIOSAppTarget as selectedTarget,
} from "./project-selection.ts";
import { readBoundedRegularFile } from "./bounded-file.ts";
import { inspectTargetBuildConfigurations } from "./build-settings.ts";
import {
  discoverLocalIOSProjects,
  pathIsSafelyWithinIOSRoot,
  relativeIOSPath,
} from "./discovery.ts";
import { hashIOSFileBytes } from "./file-transaction.ts";
import {
  planIOSMissingEntitlementsSettings,
  type IOSMissingEntitlementsSettingsPlan,
} from "./entitlements-settings.ts";
import { inspectIOSProject } from "./inspect.ts";
import { asString, buildPbxParentIndex, isRecord, type PbxObject, type PbxObjects } from "./pbx.ts";
import { decodeEntitlementsXML } from "./entitlements-xml.ts";
import { resolveXcodeProjectDocument } from "./project-document.ts";
import type { IOSDiagnostic, IOSNativePlatform, IOSProjectInspectionResult } from "./types.ts";
import { inspectXCProjTargetBuildConfigurations } from "./xcproj-build-settings.ts";
import { parseXCProjSource, xcprojTargets } from "./xcproj.ts";

const MAX_ENTITLEMENTS_BYTES = 1_000_000;
export type IOSEntitlementsFileBlockerCode =
  | "invalid-selection"
  | "generated-project"
  | "unresolved-platform"
  | "missing-entitlements"
  | "mixed-entitlements"
  | "unresolved-entitlements"
  | "unsafe-entitlements"
  | "unreadable-entitlements"
  | "unsupported-entitlements"
  | "shared-entitlements"
  | "stale-entitlements";

export interface IOSEntitlementsFileBlocker {
  code: IOSEntitlementsFileBlockerCode;
  message: string;
}

export interface IOSEntitlementsPlanFile {
  /** Invocation-root-relative path. */
  path: string;
  operation: "create" | "modify";
  expectedHash?: string;
}

export interface IOSEntitlementsFileOptions {
  root: string;
  projectPath: string;
  targetId: string;
  platform?: IOSNativePlatform;
  allowMissingEntitlementsCreation?: boolean;
  /** Only capabilities valid on every selected-target platform may opt in. */
  allowSelectedTargetPlatformSharing?: boolean;
}

export interface IOSEntitlementsFileSelection {
  status: "ready" | "blocked";
  targetName?: string;
  files: IOSEntitlementsPlanFile[];
  missingEntitlementsSettings?: IOSMissingEntitlementsSettingsPlan;
  blockers: IOSEntitlementsFileBlocker[];
}

/** Internal file evidence; never include source or plist values in serialized plans. */
export interface IOSEntitlementsFile {
  absolutePath: string;
  relativePath: string;
  bytes: Uint8Array;
  hash: string;
  mode: number;
  source: string;
  bom: boolean;
  values: Record<string, unknown>;
}

function blocker(
  code: IOSEntitlementsFileBlockerCode,
  message: string,
): IOSEntitlementsFileBlocker {
  return { code, message };
}

function blockedSelection(
  blockers: IOSEntitlementsFileBlocker[],
  targetName?: string,
): IOSEntitlementsFileSelection {
  return { status: "blocked", ...(targetName ? { targetName } : {}), files: [], blockers };
}

export async function inspectIOSEntitlementsFile(
  root: string,
  absolutePath: string,
): Promise<{ file?: IOSEntitlementsFile; blocker?: IOSEntitlementsFileBlocker }> {
  if (!(await pathIsSafelyWithinIOSRoot(root, absolutePath))) {
    return {
      blocker: blocker(
        "unsafe-entitlements",
        `${relativeIOSPath(root, absolutePath)} resolves outside the inspected project root.`,
      ),
    };
  }

  const file = await readBoundedRegularFile(absolutePath, MAX_ENTITLEMENTS_BYTES);
  if (file.status === "not-regular" || file.status === "too-large") {
    return {
      blocker: blocker(
        "unsupported-entitlements",
        `${relativeIOSPath(
          root,
          absolutePath,
        )} must be a regular, non-symlink XML plist no larger than 1 MB.`,
      ),
    };
  }
  if (file.status !== "ok") {
    try {
      const info = await lstat(absolutePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ENTITLEMENTS_BYTES) {
        return {
          blocker: blocker(
            "unsupported-entitlements",
            `${relativeIOSPath(
              root,
              absolutePath,
            )} must be a regular, non-symlink XML plist no larger than 1 MB.`,
          ),
        };
      }
    } catch {
      // Preserve the unreadable classification below when the current path
      // cannot explain the bounded reader's failure.
    }
    return {
      blocker: blocker(
        "unreadable-entitlements",
        `${relativeIOSPath(root, absolutePath)} could not be read as a UTF-8 XML plist dictionary.`,
      ),
    };
  }

  try {
    const bytes = file.bytes;
    if (new TextDecoder().decode(bytes.slice(0, 8)).startsWith("bplist")) {
      return {
        blocker: blocker(
          "unsupported-entitlements",
          `${relativeIOSPath(
            root,
            absolutePath,
          )} is a binary plist. Save it as XML before automatic setup.`,
        ),
      };
    }
    const { source, bom, values: parsed } = decodeEntitlementsXML(bytes);
    return {
      file: {
        absolutePath,
        relativePath: relativeIOSPath(root, absolutePath),
        bytes,
        hash: hashIOSFileBytes(bytes),
        mode: file.mode,
        source,
        bom,
        values: parsed,
      },
    };
  } catch {
    return {
      blocker: blocker(
        "unreadable-entitlements",
        `${relativeIOSPath(root, absolutePath)} could not be read as a UTF-8 XML plist dictionary.`,
      ),
    };
  }
}

function normalizeObjects(value: unknown): PbxObjects | undefined {
  if (!isRecord(value)) return undefined;
  const objects: PbxObjects = {};
  for (const [id, object] of Object.entries(value)) {
    if (isRecord(object)) objects[id] = object as PbxObject;
  }
  return objects;
}

function exactStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

async function ownershipIsExclusive(
  root: string,
  projectPath: string,
  selectedTargetId: string,
  selectedFiles: readonly IOSEntitlementsFile[],
  selectedPlatform: IOSNativePlatform,
  allowSelectedTargetPlatformSharing = false,
): Promise<boolean> {
  try {
    const selectedCanonical = new Set<string>();
    const selectedInodes = new Set<string>();
    for (const file of selectedFiles) {
      const canonical = await realpath(file.absolutePath);
      const info = await lstat(file.absolutePath);
      const inode = `${info.dev}:${info.ino}`;
      // Two selected configuration paths that resolve to the same file are
      // not independent transaction targets. Refuse both symlink/canonical
      // aliases and hard-link aliases rather than silently splitting them.
      if (selectedCanonical.has(canonical) || selectedInodes.has(inode)) return false;
      selectedCanonical.add(canonical);
      selectedInodes.add(inode);
    }

    const selectedProject = resolve(root, projectPath);
    const inventory = await discoverLocalIOSProjects(root, [selectedProject]);
    if (!inventory.complete) return false;
    for (const absoluteProject of inventory.projectPaths) {
      const documentResolution = await resolveXcodeProjectDocument(absoluteProject);
      if (documentResolution.status !== "found") return false;
      if (documentResolution.document.format === "xcproj") {
        if (!(await pathIsSafelyWithinIOSRoot(root, documentResolution.document.absolutePath))) {
          return false;
        }
        const projectFile = await readBoundedRegularFile(
          documentResolution.document.absolutePath,
          15_000_000,
        );
        if (projectFile.status !== "ok") return false;
        const project = parseXCProjSource(projectFile.bytes).root;
        const targets = xcprojTargets(project);
        // The canonical JSON project path is safe when it has only the
        // selected app target. Additional JSON targets are preserved but left
        // for manual review until their non-application entitlement ownership
        // can be modeled with the same guarantees as PBX targets.
        if (
          absoluteProject !== selectedProject ||
          targets.length !== 1 ||
          targets[0]?.id !== selectedTargetId
        ) {
          return false;
        }

        const target = targets[0];
        if (!target) return false;
        const primaryDiagnostics: IOSDiagnostic[] = [];
        const primaryConfigurations = await inspectXCProjTargetBuildConfigurations({
          root,
          projectPath: absoluteProject,
          projectDocumentPath: documentResolution.document.absolutePath,
          project,
          target,
          diagnostics: primaryDiagnostics,
        });
        if (
          primaryConfigurations.length === 0 ||
          primaryConfigurations.some((configuration) => !configuration.platformEvidenceComplete) ||
          primaryDiagnostics.some((diagnostic) => diagnostic.severity === "error")
        ) {
          return false;
        }
        if (
          !primaryConfigurations.every(
            (configuration) => configuration.platform === primaryConfigurations[0]?.platform,
          )
        ) {
          return false;
        }

        const primaryPlatform = primaryConfigurations[0]?.platform;
        const supportedPlatforms = (["ios", "macos"] as const).filter((platform) =>
          primaryConfigurations.some((configuration) =>
            configuration.supportedPlatforms.includes(platform),
          ),
        );
        const views: Array<{
          platform?: IOSNativePlatform;
          configurations: typeof primaryConfigurations;
        }> = [{ platform: primaryPlatform, configurations: primaryConfigurations }];
        for (const platform of supportedPlatforms) {
          if (platform === primaryPlatform) continue;
          const diagnostics: IOSDiagnostic[] = [];
          const configurations = await inspectXCProjTargetBuildConfigurations({
            root,
            projectPath: absoluteProject,
            projectDocumentPath: documentResolution.document.absolutePath,
            project,
            target,
            diagnostics,
            platform,
          });
          if (
            configurations.length !== primaryConfigurations.length ||
            configurations.some(
              (configuration) =>
                !configuration.platformEvidenceComplete || configuration.platform !== platform,
            ) ||
            diagnostics.some((diagnostic) => diagnostic.severity === "error")
          ) {
            return false;
          }
          views.push({ platform, configurations });
        }

        for (const view of views) {
          if (view.platform === selectedPlatform || allowSelectedTargetPlatformSharing) {
            continue;
          }
          for (const configuration of view.configurations) {
            const resolution = configuration.model.entitlementsPath;
            if (resolution.state === "unresolved") return false;
            if (resolution.state !== "resolved") continue;
            const siblingPath = resolve(dirname(absoluteProject), resolution.value);
            if (!(await pathIsSafelyWithinIOSRoot(root, siblingPath))) return false;
            try {
              const canonical = await realpath(siblingPath);
              const info = await lstat(siblingPath);
              if (
                selectedCanonical.has(canonical) ||
                selectedInodes.has(`${info.dev}:${info.ino}`)
              ) {
                return false;
              }
            } catch {
              // A missing sibling entitlements path cannot currently alias an existing selected file.
            }
          }
        }
        continue;
      }
      const pbxprojPath = resolve(absoluteProject, "project.pbxproj");
      if (!(await pathIsSafelyWithinIOSRoot(root, pbxprojPath))) return false;
      const info = await lstat(pbxprojPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 15_000_000) return false;
      const bytes = new Uint8Array(await readFile(pbxprojPath));
      const archive = parsePbxProject(new TextDecoder().decode(bytes));
      const objects = normalizeObjects(archive.objects);
      if (!objects) return false;
      const rootObjectId = asString(archive.rootObject);
      const projectObject = rootObjectId ? objects[rootObjectId] : undefined;
      if (projectObject?.isa !== "PBXProject") return false;
      const targetIds = exactStringArray(projectObject.targets);
      if (!targetIds) return false;
      const parents = buildPbxParentIndex(objects);
      const groupRootDirectory = resolve(
        dirname(absoluteProject),
        asString(projectObject.projectDirPath) ?? "",
      );

      for (const targetId of targetIds) {
        const targetObject = objects[targetId];
        if (!targetObject) return false;
        if (targetObject.isa !== "PBXNativeTarget") continue;
        const primaryDiagnostics: IOSDiagnostic[] = [];
        const primaryConfigurations = await inspectTargetBuildConfigurations({
          root,
          projectPath: absoluteProject,
          groupRootDirectory,
          projectObject,
          targetId,
          targetObject,
          objects,
          parents,
          diagnostics: primaryDiagnostics,
        });
        if (
          primaryConfigurations.length === 0 ||
          primaryConfigurations.some((configuration) => !configuration.platformEvidenceComplete) ||
          primaryDiagnostics.some((diagnostic) => diagnostic.severity === "error")
        ) {
          return false;
        }

        if (
          !primaryConfigurations.every(
            (configuration) => configuration.platform === primaryConfigurations[0]?.platform,
          )
        ) {
          return false;
        }
        const primaryPlatform = primaryConfigurations[0]?.platform;
        const supportedPlatforms = (["ios", "macos"] as const).filter((platform) =>
          primaryConfigurations.some((configuration) =>
            configuration.supportedPlatforms.includes(platform),
          ),
        );
        const views: Array<{
          platform?: IOSNativePlatform;
          configurations: typeof primaryConfigurations;
        }> = [{ platform: primaryPlatform, configurations: primaryConfigurations }];
        for (const platform of supportedPlatforms) {
          if (platform === primaryPlatform) continue;
          const diagnostics: IOSDiagnostic[] = [];
          const configurations = await inspectTargetBuildConfigurations({
            root,
            projectPath: absoluteProject,
            groupRootDirectory,
            projectObject,
            targetId,
            targetObject,
            objects,
            parents,
            diagnostics,
            platform,
          });
          if (
            configurations.length !== primaryConfigurations.length ||
            configurations.some(
              (configuration) =>
                !configuration.platformEvidenceComplete || configuration.platform !== platform,
            ) ||
            diagnostics.some((diagnostic) => diagnostic.severity === "error")
          ) {
            return false;
          }
          views.push({ platform, configurations });
        }

        for (const view of views) {
          if (
            absoluteProject === selectedProject &&
            targetId === selectedTargetId &&
            (view.platform === selectedPlatform || allowSelectedTargetPlatformSharing)
          ) {
            continue;
          }
          for (const configuration of view.configurations) {
            const resolution = configuration.model.entitlementsPath;
            if (resolution.state === "unresolved") return false;
            if (resolution.state !== "resolved") continue;
            const siblingPath = resolve(dirname(absoluteProject), resolution.value);
            if (!(await pathIsSafelyWithinIOSRoot(root, siblingPath))) return false;
            try {
              const canonical = await realpath(siblingPath);
              const info = await lstat(siblingPath);
              if (
                selectedCanonical.has(canonical) ||
                selectedInodes.has(`${info.dev}:${info.ino}`)
              ) {
                return false;
              }
            } catch {
              // A missing sibling entitlements path cannot currently alias an existing selected file.
            }
          }
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Select safe XML files and prove ownership without interpreting capability values. */
export async function selectIOSEntitlementsFiles(
  options: IOSEntitlementsFileOptions,
  preparedInspection?: IOSProjectInspectionResult,
): Promise<IOSEntitlementsFileSelection> {
  const root = resolve(options.root);
  const platform = options.platform ?? "ios";
  const inspection =
    preparedInspection ??
    (await inspectIOSProject(root, {
      target: options.targetId,
      exhaustiveContainerDiscovery: true,
      platform,
    }));
  const target = selectedTarget(inspection, options.projectPath, options.targetId);
  if (!target) {
    return blockedSelection([
      blocker(
        "invalid-selection",
        "The selected native Apple target could not be resolved exactly.",
      ),
    ]);
  }
  if (!target.platformEvidenceComplete) {
    return blockedSelection(
      [
        blocker(
          "unresolved-platform",
          "Resolve SDKROOT and SUPPORTED_PLATFORMS consistently across every selected-target build configuration before changing entitlements.",
        ),
      ],
      target.name,
    );
  }
  const generator =
    inspection.generatedProject ??
    (await generatedProjectKind(root, resolve(root, options.projectPath)));
  if (generator) {
    return blockedSelection(
      [
        blocker(
          "generated-project",
          `This is a ${
            generator === "xcodegen" ? "XcodeGen" : "Tuist"
          } project; update its source manifest instead of generated entitlements.`,
        ),
      ],
      target.name,
    );
  }

  if (target.configurations.length === 0) {
    return blockedSelection(
      [
        blocker(
          "missing-entitlements",
          "The selected target has no inspectable build configurations.",
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
  if (resolvedPaths.length === 0) {
    if (
      target.configurations.some(
        (configuration) => configuration.entitlementsPath.state !== "missing",
      )
    ) {
      return blockedSelection(
        [
          blocker(
            "unresolved-entitlements",
            "One or more CODE_SIGN_ENTITLEMENTS settings could not be resolved exactly.",
          ),
        ],
        target.name,
      );
    }
    if (options.allowMissingEntitlementsCreation) {
      const settingsPlan = await planIOSMissingEntitlementsSettings({
        root,
        projectPath: options.projectPath,
        targetId: options.targetId,
        platform,
      });
      if (settingsPlan.status === "ready" && settingsPlan.entitlementsPath) {
        return {
          status: "ready",
          targetName: target.name,
          files: [{ path: settingsPlan.entitlementsPath, operation: "create" }],
          missingEntitlementsSettings: settingsPlan,
          blockers: [],
        };
      }
      return blockedSelection(
        settingsPlan.blockers.length > 0
          ? settingsPlan.blockers.map((item) => blocker("missing-entitlements", item.message))
          : [
              blocker(
                "missing-entitlements",
                "The missing-entitlements plan did not identify one safe destination.",
              ),
            ],
        target.name,
      );
    }
    return blockedSelection(
      [
        blocker(
          "missing-entitlements",
          "No selected-target configuration has an existing entitlements file, and automatic file creation was not enabled.",
        ),
      ],
      target.name,
    );
  }
  if (resolvedPaths.length !== target.configurations.length) {
    return blockedSelection(
      [
        blocker(
          "mixed-entitlements",
          "Some selected-target configurations have entitlements while others do not. Choose the intended files in Xcode before automatic setup.",
        ),
      ],
      target.name,
    );
  }
  if (
    target.configurations.some(
      (configuration) => configuration.entitlementsPath.state !== "resolved",
    )
  ) {
    return blockedSelection(
      [
        blocker(
          "unresolved-entitlements",
          "One or more CODE_SIGN_ENTITLEMENTS settings could not be resolved exactly.",
        ),
      ],
      target.name,
    );
  }

  const filesByPath = new Map<string, IOSEntitlementsFile>();
  const blockers: IOSEntitlementsFileBlocker[] = [];
  for (const configuredPath of new Set(resolvedPaths)) {
    const absolutePath = resolve(root, options.projectPath, "..", configuredPath);
    const inspected = await inspectIOSEntitlementsFile(root, absolutePath);
    if (inspected.blocker) blockers.push(inspected.blocker);
    if (inspected.file) filesByPath.set(inspected.file.absolutePath, inspected.file);
  }
  if (blockers.length > 0 || filesByPath.size !== new Set(resolvedPaths).size) {
    return blockedSelection(blockers, target.name);
  }
  const files = [...filesByPath.values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  if (
    !(await ownershipIsExclusive(
      root,
      options.projectPath,
      options.targetId,
      files,
      platform,
      options.allowSelectedTargetPlatformSharing,
    ))
  ) {
    return blockedSelection(
      [
        blocker(
          "shared-entitlements",
          "An entitlements file may be shared with another target, or exclusive ownership could not be proven.",
        ),
      ],
      target.name,
    );
  }

  return {
    status: "ready",
    targetName: target.name,
    files: files.map((file) => ({
      path: file.relativePath,
      operation: "modify" as const,
      expectedHash: file.hash,
    })),
    blockers: [],
  };
}

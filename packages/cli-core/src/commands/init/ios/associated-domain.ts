import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parsePbxProject } from "@bacons/xcode/json";
import plist from "@expo/plist";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import { inspectTargetBuildConfigurations } from "./build-settings.ts";
import {
  discoverIOSContainers,
  inspectWorkspace,
  pathIsSafelyWithinIOSRoot,
  relativeIOSPath,
} from "./discovery.ts";
import {
  applyIOSFileTransaction,
  hashIOSFileBytes,
  type IOSCreateFileMutation,
  type IOSExistingFileMutation,
  type IOSFileMutation,
} from "./file-transaction.ts";
import {
  planIOSMissingEntitlementsSettings,
  prepareIOSMissingEntitlementsSettingsMutation,
  validateIOSMissingEntitlementsSettingsPostcondition,
  type IOSMissingEntitlementsSettingsPlan,
} from "./entitlements-settings.ts";
import { inspectIOSProject } from "./inspect.ts";
import {
  asString,
  asStringArray,
  buildPbxParentIndex,
  isRecord,
  type PbxObject,
  type PbxObjects,
} from "./pbx.ts";
import type { IOSAppTarget, IOSDiagnostic, IOSProjectInspectionResult } from "./types.ts";

const ASSOCIATED_DOMAINS_KEY = "com.apple.developer.associated-domains";
const MAX_ENTITLEMENTS_BYTES = 1_000_000;

export type IOSAssociatedDomainBlockerCode =
  | "invalid-selection"
  | "generated-project"
  | "runtime-key-unproven"
  | "missing-entitlements"
  | "mixed-entitlements"
  | "unresolved-entitlements"
  | "unsafe-entitlements"
  | "unreadable-entitlements"
  | "unsupported-entitlements"
  | "shared-entitlements"
  | "stale-entitlements";

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
  /** A separately proven direct Swift configuration will supply the runtime key after auth. */
  deferToPublishableKey?: boolean;
  /** Allows the strict synchronized-root planner to create and attach a new file. */
  allowMissingEntitlementsCreation?: boolean;
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

interface EntitlementsFile {
  absolutePath: string;
  relativePath: string;
  bytes: Uint8Array;
  hash: string;
  mode: number;
  source: string;
  bom: boolean;
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
    ...(targetName ? { targetName } : {}),
    requiresPublishableKey: options.deferToPublishableKey === true,
    files: [],
    actions: [],
    blockers,
  };
}

function selectedTarget(
  inspection: IOSProjectInspectionResult,
  projectPath: string,
  targetId: string,
): IOSAppTarget | undefined {
  const selection = inspection.selection;
  if (
    selection.state !== "selected" ||
    selection.projectPath !== projectPath ||
    selection.targetId !== targetId
  ) {
    return undefined;
  }
  return inspection.appTargets.find(
    (target) => target.projectPath === projectPath && target.id === targetId,
  );
}

function runtimeFrontendHost(
  inspection: IOSProjectInspectionResult,
  target: IOSAppTarget,
): string | undefined {
  const key = inspection.localPublishableKey;
  if (!key.found || key.conflict || !key.source || !key.frontendApiHost) return undefined;
  const source = key.source;
  const connected = target.swift.configureCalls.some((call) => {
    if (call.startupBinding !== "app-init") return false;
    if (call.publishableKeyWiring === "inline-literal") {
      return call.path === source && call.inlinePublishableKey?.state === "valid";
    }
    if (call.publishableKeyWiring === "local-secrets-loader") {
      return (
        call.localSecretsRuntimeBinding === "proven" &&
        target.runtimeKeySinks.some((sink) => sink.path === source)
      );
    }
    return call.publishableKeyWiring === "process-info-environment" && source.endsWith(".xcscheme");
  });
  return connected ? key.frontendApiHost : undefined;
}

function stripXMLCommentsPreservingOffsets(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length));
}

function countAssociatedDomainKeys(source: string): number {
  const structural = stripXMLCommentsPreservingOffsets(source);
  return [
    ...structural.matchAll(/<key\b[^>]*>\s*com\.apple\.developer\.associated-domains\s*<\/key>/g),
  ].length;
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

function associatedDomainKeyStructure(source: string): {
  semanticCount: number;
  safelyDecoded: boolean;
} {
  const structural = stripXMLCommentsPreservingOffsets(source);
  let semanticCount = 0;
  let safelyDecoded = true;
  for (const match of structural.matchAll(/<key\b[^>]*>([\s\S]*?)<\/key>/g)) {
    const decoded = decodeXMLText(match[1] ?? "");
    if (decoded == null) {
      safelyDecoded = false;
      continue;
    }
    if (decoded.trim() === ASSOCIATED_DOMAINS_KEY) semanticCount += 1;
  }
  return { semanticCount, safelyDecoded };
}

function hasUnresolvedDomain(value: string): boolean {
  return /\$\([^)]+\)|\$\{[^}]+\}/.test(value);
}

async function inspectEntitlementsFile(
  root: string,
  absolutePath: string,
): Promise<{ file?: EntitlementsFile; blocker?: IOSAssociatedDomainBlocker }> {
  if (!(await pathIsSafelyWithinIOSRoot(root, absolutePath))) {
    return {
      blocker: blocker(
        "unsafe-entitlements",
        `${relativeIOSPath(root, absolutePath)} resolves outside the inspected project root.`,
      ),
    };
  }

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
    const bytes = new Uint8Array(await readFile(absolutePath));
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
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const textBytes = bom ? bytes.slice(3) : bytes;
    const source = new TextDecoder("utf-8", { fatal: true }).decode(textBytes);
    const parsed: unknown = plist.parse(source);
    if (!isRecord(parsed)) throw new Error("plist root is not a dictionary");
    const rawDomains = parsed[ASSOCIATED_DOMAINS_KEY];
    const structuralKeyCount = countAssociatedDomainKeys(source);
    const semanticKeyStructure = associatedDomainKeyStructure(source);
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
    return {
      file: {
        absolutePath,
        relativePath: relativeIOSPath(root, absolutePath),
        bytes,
        hash: hashIOSFileBytes(bytes),
        mode: info.mode & 0o7777,
        source,
        bom,
        domains,
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

async function ownershipIsExclusive(
  root: string,
  projectPath: string,
  selectedTargetId: string,
  selectedFiles: readonly EntitlementsFile[],
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
    const discovered = await discoverIOSContainers(root);
    const projectPaths = new Set([...discovered.projectPaths, selectedProject]);
    for (const workspacePath of discovered.workspacePaths) {
      const workspace = await inspectWorkspace(root, workspacePath);
      for (const localProjectPath of workspace.localProjectPaths) {
        projectPaths.add(localProjectPath);
      }
    }
    for (const absoluteProject of [...projectPaths].sort()) {
      const pbxprojPath = resolve(absoluteProject, "project.pbxproj");
      if (!(await pathIsSafelyWithinIOSRoot(root, pbxprojPath))) return false;
      const bytes = new Uint8Array(await readFile(pbxprojPath));
      if (bytes.byteLength > 15_000_000) return false;
      const archive = parsePbxProject(new TextDecoder().decode(bytes));
      const objects = normalizeObjects(archive.objects);
      if (!objects) return false;
      const rootObjectId = asString(archive.rootObject);
      const projectObject =
        (rootObjectId ? objects[rootObjectId] : undefined) ??
        Object.values(objects).find((object) => object.isa === "PBXProject");
      if (projectObject?.isa !== "PBXProject") return false;
      const parents = buildPbxParentIndex(objects);
      const groupRootDirectory = resolve(
        dirname(absoluteProject),
        asString(projectObject.projectDirPath) ?? "",
      );

      for (const targetId of asStringArray(projectObject.targets)) {
        if (absoluteProject === selectedProject && targetId === selectedTargetId) continue;
        const targetObject = objects[targetId];
        if (targetObject?.isa !== "PBXNativeTarget") continue;
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
        });
        if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return false;
        for (const configuration of configurations) {
          const resolution = configuration.model.entitlementsPath;
          if (resolution.state === "unresolved") return false;
          if (resolution.state !== "resolved") continue;
          const siblingPath = resolve(dirname(absoluteProject), resolution.value);
          if (!(await pathIsSafelyWithinIOSRoot(root, siblingPath))) return false;
          try {
            const canonical = await realpath(siblingPath);
            const info = await lstat(siblingPath);
            if (selectedCanonical.has(canonical) || selectedInodes.has(`${info.dev}:${info.ino}`)) {
              return false;
            }
          } catch {
            // A missing sibling entitlements path cannot currently alias an existing selected file.
          }
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function exactDomainPresent(domains: readonly string[], expectedDomain: string): boolean {
  return domains.includes(expectedDomain);
}

async function generatedProjectKind(
  root: string,
  absoluteProjectPath: string,
): Promise<"xcodegen" | "tuist" | null> {
  let directory = dirname(absoluteProjectPath);
  while (await pathIsSafelyWithinIOSRoot(root, directory)) {
    for (const [relativePath, kind] of [
      ["project.yml", "xcodegen"],
      ["Project.swift", "tuist"],
      ["Workspace.swift", "tuist"],
      ["Tuist/ProjectDescriptionHelpers", "tuist"],
    ] as const) {
      const marker = resolve(directory, relativePath);
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

/**
 * Plans the conservative v1 Associated Domains edit. It only patches existing
 * XML entitlements files that cover every selected-target configuration.
 */
export async function planIOSAssociatedDomain(
  options: IOSAssociatedDomainPlanOptions,
): Promise<IOSAssociatedDomainPlan> {
  const root = resolve(options.root);
  const inspection = await inspectIOSProject(root, {
    target: options.targetId,
  });
  const target = selectedTarget(inspection, options.projectPath, options.targetId);
  if (!target) {
    return blockedPlan(options, [
      blocker("invalid-selection", "The selected iOS target could not be resolved exactly."),
    ]);
  }
  const generator =
    inspection.generatedProject ??
    (await generatedProjectKind(root, resolve(root, options.projectPath)));
  if (generator) {
    return blockedPlan(
      options,
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

  if (target.configurations.length === 0) {
    return blockedPlan(
      options,
      [
        blocker(
          "missing-entitlements",
          "The selected target has no inspectable build configurations.",
        ),
      ],
      target.name,
    );
  }
  const expectedDomain = host ? `webcredentials:${host}` : undefined;
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
      return blockedPlan(
        options,
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
      });
      if (settingsPlan.status === "ready" && settingsPlan.entitlementsPath) {
        return {
          schemaVersion: 1,
          kind: "clerk-ios-associated-domain",
          status: "ready",
          root,
          projectPath: options.projectPath,
          targetId: options.targetId,
          targetName: target.name,
          ...(expectedDomain ? { expectedDomain } : {}),
          requiresPublishableKey: expectedDomain == null,
          files: [{ path: settingsPlan.entitlementsPath, operation: "create" }],
          missingEntitlementsSettings: settingsPlan,
          actions: [
            expectedDomain
              ? `Create ${settingsPlan.entitlementsPath} with ${expectedDomain}.`
              : `Create ${settingsPlan.entitlementsPath} with the linked development instance's exact webcredentials host (resolved after authentication).`,
            `Attach ${settingsPlan.entitlementsPath} only to iPhone and iPad SDK builds for every selected-target configuration.`,
          ],
          blockers: [],
        };
      }
      return blockedPlan(
        options,
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
    return blockedPlan(
      options,
      [
        blocker(
          "missing-entitlements",
          "No selected-target configuration has an existing entitlements file, and this runtime route cannot safely create one automatically.",
        ),
      ],
      target.name,
    );
  }
  if (resolvedPaths.length !== target.configurations.length) {
    return blockedPlan(
      options,
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
    return blockedPlan(
      options,
      [
        blocker(
          "unresolved-entitlements",
          "One or more CODE_SIGN_ENTITLEMENTS settings could not be resolved exactly.",
        ),
      ],
      target.name,
    );
  }

  const filesByPath = new Map<string, EntitlementsFile>();
  const blockers: IOSAssociatedDomainBlocker[] = [];
  for (const configuredPath of new Set(resolvedPaths)) {
    const absolutePath = resolve(root, options.projectPath, "..", configuredPath);
    const inspected = await inspectEntitlementsFile(root, absolutePath);
    if (inspected.blocker) blockers.push(inspected.blocker);
    if (inspected.file) filesByPath.set(inspected.file.absolutePath, inspected.file);
  }
  if (blockers.length > 0 || filesByPath.size !== new Set(resolvedPaths).size) {
    return blockedPlan(options, blockers, target.name);
  }
  const files = [...filesByPath.values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  if (!(await ownershipIsExclusive(root, options.projectPath, options.targetId, files))) {
    return blockedPlan(
      options,
      [
        blocker(
          "shared-entitlements",
          "An entitlements file may be shared with another target, or exclusive ownership could not be proven.",
        ),
      ],
      target.name,
    );
  }

  const satisfied =
    expectedDomain != null &&
    files.every((file) => exactDomainPresent(file.domains, expectedDomain));
  return {
    schemaVersion: 1,
    kind: "clerk-ios-associated-domain",
    status: satisfied ? "satisfied" : "ready",
    root,
    projectPath: options.projectPath,
    targetId: options.targetId,
    targetName: target.name,
    ...(expectedDomain ? { expectedDomain } : {}),
    requiresPublishableKey: expectedDomain == null,
    files: files.map((file) => ({
      path: file.relativePath,
      operation: "modify" as const,
      expectedHash: file.hash,
    })),
    actions: satisfied
      ? []
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

function lineIndentAt(source: string, index: number): string {
  const start = source.lastIndexOf("\n", index - 1) + 1;
  return /^[\t ]*/.exec(source.slice(start, index))?.[0] ?? "";
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
  const selfClosing = /^\s*<array\b[^>]*\/\s*>/.exec(tail);
  if (selfClosing) {
    const start = afterKey + (selfClosing.index ?? 0);
    const end = start + selfClosing[0].length;
    const keyIndent = lineIndentAt(source, keyMatch.index);
    const replacement = `${newline}${keyIndent}<array>${newline}${keyIndent}\t<string>${encoded}</string>${newline}${keyIndent}</array>`;
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

function bytesWithOptionalBOM(source: string, bom: boolean): Uint8Array {
  const encoded = new TextEncoder().encode(source);
  if (!bom) return encoded;
  const bytes = new Uint8Array(encoded.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(encoded, 3);
  return bytes;
}

function newEntitlementsBytes(expectedDomain: string): Uint8Array {
  return new TextEncoder().encode(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `\t<key>${ASSOCIATED_DOMAINS_KEY}</key>`,
      "\t<array>",
      `\t\t<string>${xmlEscape(expectedDomain)}</string>`,
      "\t</array>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
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
    try {
      if (!plannedFile.expectedHash) return { status: "blocked", plan };
      const info = await lstat(absolutePath);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        hashIOSFileBytes(await readFile(absolutePath)) !== plannedFile.expectedHash
      ) {
        return { status: "stale", plan };
      }
    } catch {
      return { status: "stale", plan };
    }
  }

  const replanned = await planIOSAssociatedDomain({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
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
    const candidateBytes = newEntitlementsBytes(expectedDomain);
    const createMutation: IOSCreateFileMutation = {
      kind: "create",
      path: createPath,
      expectedParentIdentity: { ...expectedParentIdentity },
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
    mutations.push({
      path: inspected.file.absolutePath,
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
  prepared: Extract<PreparedIOSAssociatedDomainMutation, { status: "ready" }>,
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
  });
  const target = selectedTarget(inspection, prepared.plan.projectPath, prepared.plan.targetId);
  if (!target) return false;
  if (
    inspection.generatedProject != null ||
    (await generatedProjectKind(
      prepared.plan.root,
      resolve(prepared.plan.root, prepared.plan.projectPath),
    )) != null
  ) {
    return false;
  }
  const expectedHost = prepared.expectedDomain.slice("webcredentials:".length);
  if (runtimeFrontendHost(inspection, target) !== expectedHost) return false;
  if (target.configurations.length === 0) return false;
  const files: EntitlementsFile[] = [];
  for (const configuration of target.configurations) {
    if (configuration.entitlementsPath.state !== "resolved") return false;
    const absolutePath = resolve(
      prepared.plan.root,
      prepared.plan.projectPath,
      "..",
      configuration.entitlementsPath.value,
    );
    const inspected = await inspectEntitlementsFile(prepared.plan.root, absolutePath);
    if (!inspected.file || !exactDomainPresent(inspected.file.domains, prepared.expectedDomain)) {
      return false;
    }
    files.push(inspected.file);
  }
  return ownershipIsExclusive(
    prepared.plan.root,
    prepared.plan.projectPath,
    prepared.plan.targetId,
    [...new Map(files.map((file) => [file.absolutePath, file])).values()],
  );
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

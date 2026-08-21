import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { errorMessage } from "../../lib/errors.ts";
import { isRecord } from "../../lib/objects.ts";
import { pathIsSafelyWithinIOSRoot, relativeIOSPath } from "../init/ios/discovery.ts";
import type {
  IOSAppTarget,
  IOSProjectInspectionResult,
  IOSWorkspaceInspection,
} from "../init/ios/types.ts";
import type { CheckResult } from "./types.ts";

const XCRUN = "/usr/bin/xcrun";
const TOOLCHAIN_TIMEOUT_MS = 10_000;
const DISCOVERY_TIMEOUT_MS = 30_000;
const RESOLUTION_TIMEOUT_MS = 5 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const SIMULATOR_LIST_TIMEOUT_MS = 15_000;
const SIMULATOR_BOOT_TIMEOUT_MS = 2 * 60_000;
const SIMULATOR_OPERATION_TIMEOUT_MS = 60_000;
const FORCE_KILL_DELAY_MS = 2_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const JSON_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_RESOLVED_BYTES = 2 * 1024 * 1024;
const MAX_SCHEME_BYTES = 2 * 1024 * 1024;
const APP_PRODUCT_TYPE = "com.apple.product-type.application";

export interface IOSXcodeVerificationOptions {
  /** Project-root-relative or absolute `.xcodeproj`/`.xcworkspace` path. */
  container?: string;
  /** Scheme to verify instead of selecting one from exact target evidence. */
  scheme?: string;
  /** Explicitly allow Xcode to create or update Package.resolved. */
  resolvePackages?: boolean;
  /** Run a frozen, code-signing-disabled iOS Simulator build. */
  build?: boolean;
  /** Install and launch the built app in a simulator. Implies `build`. */
  simulator?: boolean;
  /** Exact simulator UDID or exact device name. Only valid with `simulator`. */
  device?: string;
}

export interface IOSXcodeCommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes?: number;
}

export interface IOSXcodeCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  spawnError?: string;
}

export type IOSXcodeCommandRunner = (
  argv: readonly string[],
  options: IOSXcodeCommandOptions,
) => Promise<IOSXcodeCommandResult>;

export interface IOSXcodeVerificationDependencies {
  runner?: IOSXcodeCommandRunner;
  platform?: NodeJS.Platform;
  xcrunPath?: string;
  environment?: NodeJS.ProcessEnv;
  makeTemporaryDirectory?: () => Promise<string>;
  removeTemporaryDirectory?: (path: string) => Promise<void>;
}

interface BoundedOutput {
  text: string;
  truncated: boolean;
}

interface SelectedContainer {
  kind: "project" | "workspace";
  flag: "-project" | "-workspace";
  absolutePath: string;
  relativePath: string;
  workspace?: IOSWorkspaceInspection;
}

interface PackageResolvedSnapshot {
  status: "missing" | "valid" | "invalid";
  path: string;
  hash?: string;
}

interface PackageResolvedPathSafety {
  safe: boolean;
  exists?: boolean;
  detail?: string;
}

interface SafePackageResolvedSnapshot {
  snapshot?: PackageResolvedSnapshot;
  detail?: string;
}

interface VerifiedBuildSettings {
  targetBuildDir?: string;
  fullProductName?: string;
  bundleIdentifier?: string;
}

interface SimulatorDevice {
  name: string;
  udid: string;
  state: string;
  runtime: string;
}

function pass(name: string, message: string, detail?: string): CheckResult {
  return {
    name,
    status: "pass",
    message: sanitizeInline(message),
    ...(detail ? { detail: sanitizeIOSXcodeDiagnostic(detail) } : {}),
  };
}

function warn(name: string, message: string, remedy?: string, detail?: string): CheckResult {
  return {
    name,
    status: "warn",
    message: sanitizeInline(message),
    ...(detail ? { detail: sanitizeIOSXcodeDiagnostic(detail) } : {}),
    ...(remedy ? { remedy: sanitizeIOSXcodeDiagnostic(remedy) } : {}),
  };
}

function fail(name: string, message: string, remedy?: string, detail?: string): CheckResult {
  return {
    name,
    status: "fail",
    message: sanitizeInline(message),
    ...(detail ? { detail: sanitizeIOSXcodeDiagnostic(detail) } : {}),
    ...(remedy ? { remedy: sanitizeIOSXcodeDiagnostic(remedy) } : {}),
  };
}

function sanitizeSupportedURLTokens(value: string): string {
  return value.replace(/\b(?:https?|ssh|git(?:\+ssh)?):\/\/[^\s"'`<>]+/gi, (token) => {
    const queryIndex = token.indexOf("?");
    const fragmentIndex = token.indexOf("#");
    const secretIndex = [queryIndex, fragmentIndex]
      .filter((index) => index >= 0)
      .reduce((lowest, index) => Math.min(lowest, index), token.length);
    const removed = token.slice(secretIndex);
    const structuralSuffix = removed.match(/[\])},.;]+$/)?.[0] ?? "";
    return `${token.slice(0, secretIndex).replace(/^((?:https?|ssh|git(?:\+ssh)?):\/\/)[^/\s]+@/i, "$1<redacted>@")}${structuralSuffix}`;
  });
}

/**
 * Removes terminal control sequences and credentials before subprocess output
 * reaches human, verbose, debug, or JSON doctor output.
 */
export function sanitizeIOSXcodeDiagnostic(value: string): string {
  const escape = String.fromCharCode(27);
  const ansiPattern = new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g");
  const withoutAnsi = value.replace(ansiPattern, "");
  let withoutControls = "";
  for (const char of withoutAnsi) {
    const code = char.codePointAt(0)!;
    if (char === "\n" || char === "\r" || char === "\t" || (code >= 0x20 && code !== 0x7f)) {
      if (code < 0x80 || code > 0x9f) withoutControls += char;
    }
  }

  return sanitizeSupportedURLTokens(withoutControls)
    .replace(
      /(^|[\s("'`=])[A-Za-z0-9._~%!$&'()*+,;=:+-]+@((?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):[^\s"'`<>]+)/gm,
      "$1<redacted>@$2",
    )
    .replace(/\bBasic\s+[A-Za-z0-9+/_=-]{4,}/gi, "Basic <redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(?:pk|sk|ak)_[A-Za-z0-9._~+/=-]+/gi, "<redacted>")
    .replace(
      /(\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY|PUBLISHABLE_KEY)[A-Z0-9_]*\b\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi,
      "$1<redacted>",
    )
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
}

function sanitizeInline(value: string): string {
  return sanitizeIOSXcodeDiagnostic(value).replace(/\s+/g, " ").slice(0, 500);
}

function diagnosticDetail(result: IOSXcodeCommandResult): string | undefined {
  const raw = result.stderr.trim() || result.stdout.trim() || result.spawnError || "";
  const sanitized = sanitizeIOSXcodeDiagnostic(raw);
  if (!sanitized) return result.truncated ? "Subprocess output was truncated." : undefined;
  const lines = sanitized.split("\n");
  const detail = lines
    .slice(Math.max(0, lines.length - 40))
    .join("\n")
    .slice(-8_000);
  return result.truncated ? `${detail}\n[output truncated]` : detail;
}

function commandFailure(
  name: string,
  action: string,
  result: IOSXcodeCommandResult,
  remedy: string,
): CheckResult {
  const reason = result.timedOut
    ? `${action} timed out`
    : result.spawnError
      ? `${action} could not start`
      : `${action} exited with code ${result.exitCode ?? "unknown"}`;
  return fail(name, reason, remedy, diagnosticDetail(result));
}

function isCommandSuccess(result: IOSXcodeCommandResult): boolean {
  return !result.timedOut && !result.spawnError && result.exitCode === 0;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<BoundedOutput> {
  const reader = stream.getReader();
  let retained = new Uint8Array(0);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (value.byteLength >= limit) {
        retained = value.slice(value.byteLength - limit);
        continue;
      }
      const overflow = Math.max(0, retained.byteLength + value.byteLength - limit);
      const previous = overflow > 0 ? retained.slice(overflow) : retained;
      const next = new Uint8Array(previous.byteLength + value.byteLength);
      next.set(previous);
      next.set(value, previous.byteLength);
      retained = next;
    }
  } finally {
    reader.releaseLock();
  }
  return {
    text: new TextDecoder().decode(retained),
    truncated: total > limit,
  };
}

/** Default bounded, non-interactive command runner used by iOS doctor. */
export const runIOSXcodeCommand: IOSXcodeCommandRunner = async (argv, options) => {
  let process: ReturnType<typeof Bun.spawn>;
  try {
    process = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      spawnError: sanitizeIOSXcodeDiagnostic(errorMessage(error)),
    };
  }

  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      process.kill("SIGTERM");
    } catch {}
    forceKillTimer = setTimeout(() => {
      try {
        process.kill("SIGKILL");
      } catch {}
    }, FORCE_KILL_DELAY_MS);
  }, options.timeoutMs);

  const outputLimit = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      readBoundedStream(process.stdout as ReadableStream<Uint8Array>, outputLimit),
      readBoundedStream(process.stderr as ReadableStream<Uint8Array>, outputLimit),
    ]);
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut,
      truncated: stdout.truncated || stderr.truncated,
    };
  } catch (error) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut,
      truncated: false,
      spawnError: sanitizeIOSXcodeDiagnostic(errorMessage(error)),
    };
  } finally {
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  }
};

/**
 * Xcode build phases receive the parent's environment. Keep only ordinary
 * toolchain/locale values so CLI API keys and unrelated host credentials are
 * not inherited by project-controlled scripts.
 */
export function createIOSXcodeChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NUMERIC",
    "LC_TIME",
    "TERM",
    "DEVELOPER_DIR",
    "__CF_USER_TEXT_ENCODING",
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (allowed.has(key)) env[key] = value;
  }
  env.PATH ??= "/usr/bin:/bin:/usr/sbin:/sbin";
  return env;
}

function targetFromInspection(inspection: IOSProjectInspectionResult): {
  target?: IOSAppTarget;
  result?: CheckResult;
} {
  const selection = inspection.selection;
  if (selection.state !== "selected") {
    return {
      result: fail(
        "Xcode target",
        "No unambiguous iOS application target is selected",
        "Rerun with --target <target-name-or-id>.",
      ),
    };
  }
  const target = inspection.appTargets.find(
    (candidate) =>
      candidate.id === selection.targetId && candidate.projectPath === selection.projectPath,
  );
  if (!target) {
    return {
      result: fail(
        "Xcode target",
        "The selected iOS target is no longer present in the inspection",
        "Rerun clerk doctor so the Xcode project can be inspected again.",
      ),
    };
  }
  return { target };
}

async function isSafeDirectory(root: string, path: string): Promise<boolean> {
  if (!(await pathIsSafelyWithinIOSRoot(root, path))) return false;
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function selectContainer(
  inspection: IOSProjectInspectionResult,
  target: IOSAppTarget,
  requested: string | undefined,
): Promise<{ container?: SelectedContainer; result?: CheckResult }> {
  const root = inspection.root;
  const selectedProject = resolve(root, target.projectPath);

  if (requested) {
    const absolutePath = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
    const extension = extname(absolutePath);
    if (extension !== ".xcodeproj" && extension !== ".xcworkspace") {
      return {
        result: fail(
          "Xcode container",
          "The requested Xcode container is not a .xcodeproj or .xcworkspace",
          "Pass --xcode-container with the selected project or a workspace containing it.",
        ),
      };
    }
    if (!(await isSafeDirectory(root, absolutePath))) {
      return {
        result: fail(
          "Xcode container",
          "The requested Xcode container is missing, external, or unsafe",
          "Choose an inspected Xcode project or workspace inside the project root.",
        ),
      };
    }
    const relativePath = relativeIOSPath(root, absolutePath);
    if (extension === ".xcodeproj") {
      if (relativePath !== target.projectPath) {
        return {
          result: fail(
            "Xcode container",
            "The requested project does not own the selected target",
            `Use ${target.projectPath}, or select a target owned by the requested project.`,
          ),
        };
      }
      return {
        container: {
          kind: "project",
          flag: "-project",
          absolutePath,
          relativePath,
        },
      };
    }

    const workspace = inspection.workspaces.find((candidate) => candidate.path === relativePath);
    if (!workspace?.projectPaths.includes(target.projectPath)) {
      return {
        result: fail(
          "Xcode container",
          "The requested workspace does not contain the selected target's project",
          "Choose an inspected workspace that contains the selected project.",
        ),
      };
    }
    return {
      container: {
        kind: "workspace",
        flag: "-workspace",
        absolutePath,
        relativePath,
        workspace,
      },
    };
  }

  const containingWorkspaces = inspection.workspaces.filter((workspace) =>
    workspace.projectPaths.includes(target.projectPath),
  );
  if (containingWorkspaces.length > 1) {
    return {
      result: fail(
        "Xcode container",
        "More than one workspace contains the selected iOS project",
        "Pass --xcode-container <workspace.xcworkspace> to select one explicitly.",
        containingWorkspaces.map((workspace) => workspace.path).join("\n"),
      ),
    };
  }
  const workspace = containingWorkspaces[0];
  if (workspace) {
    const absolutePath = resolve(root, workspace.path);
    if (!(await isSafeDirectory(root, absolutePath))) {
      return {
        result: fail(
          "Xcode container",
          "The inspected workspace is no longer a safe local directory",
          "Rerun clerk doctor or pass the selected .xcodeproj explicitly.",
        ),
      };
    }
    return {
      container: {
        kind: "workspace",
        flag: "-workspace",
        absolutePath,
        relativePath: workspace.path,
        workspace,
      },
    };
  }

  if (!(await isSafeDirectory(root, selectedProject))) {
    return {
      result: fail(
        "Xcode container",
        "The selected target's project is no longer a safe local directory",
        "Rerun clerk doctor after restoring the Xcode project.",
      ),
    };
  }
  return {
    container: {
      kind: "project",
      flag: "-project",
      absolutePath: selectedProject,
      relativePath: target.projectPath,
    },
  };
}

function containerProjectPaths(container: SelectedContainer, target: IOSAppTarget): string[] {
  return container.kind === "workspace"
    ? (container.workspace?.projectPaths ?? [])
    : [target.projectPath];
}

function containerHasRemotePackages(
  inspection: IOSProjectInspectionResult,
  container: SelectedContainer,
  target: IOSAppTarget,
): boolean {
  const projects = new Set(containerProjectPaths(container, target));
  return inspection.projects.some(
    (project) =>
      projects.has(project.path) &&
      project.packages.some((reference) => reference.kind === "remote"),
  );
}

function packageResolvedPath(container: SelectedContainer): string {
  return container.kind === "workspace"
    ? join(container.absolutePath, "xcshareddata", "swiftpm", "Package.resolved")
    : join(
        container.absolutePath,
        "project.xcworkspace",
        "xcshareddata",
        "swiftpm",
        "Package.resolved",
      );
}

async function readPackageResolvedSnapshot(path: string): Promise<PackageResolvedSnapshot> {
  let bytes: Uint8Array;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PACKAGE_RESOLVED_BYTES) {
      return { status: "invalid", path };
    }
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "missing", path };
    }
    return { status: "invalid", path };
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed)) return { status: "invalid", path };
    const legacy = isRecord(parsed.object) ? parsed.object : undefined;
    const pins = Array.isArray(parsed.pins)
      ? parsed.pins
      : Array.isArray(legacy?.pins)
        ? legacy.pins
        : undefined;
    if (!pins) return { status: "invalid", path };
    return {
      status: "valid",
      path,
      hash: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return { status: "invalid", path };
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Before reading or allowing Xcode to update Package.resolved, prove every
 * existing component below the inspected root is a real directory rather than
 * a symlink or another file type. This is deliberately stricter than ordinary
 * read-path containment, including for symlinks whose destinations remain in
 * the project root.
 */
async function validatePackageResolvedPath(
  inspectionRoot: string,
  containerPath: string,
  resolvedPath: string,
): Promise<PackageResolvedPathSafety> {
  const root = resolve(inspectionRoot);
  const container = resolve(containerPath);
  const candidate = resolve(resolvedPath);
  if (!isWithin(root, container) || !isWithin(container, candidate)) {
    return { safe: false, detail: "The package lock path is outside the selected container." };
  }
  if (!(await pathIsSafelyWithinIOSRoot(root, candidate))) {
    return {
      safe: false,
      detail: "The package lock path resolves outside the inspected project root.",
    };
  }

  const segments = relative(root, candidate).split(sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isMissingPathError(error)) return { safe: true, exists: false };
      return {
        safe: false,
        detail: `An existing package lock parent could not be inspected: ${relativeIOSPath(root, current)}.`,
      };
    }

    if (info.isSymbolicLink()) {
      return {
        safe: false,
        detail: `The package lock path contains a symbolic link: ${relativeIOSPath(root, current)}.`,
      };
    }
    const isLeaf = index === segments.length - 1;
    if (!isLeaf && !info.isDirectory()) {
      return {
        safe: false,
        detail: `A package lock parent is not a directory: ${relativeIOSPath(root, current)}.`,
      };
    }
    if (isLeaf) {
      return info.isFile()
        ? { safe: true, exists: true }
        : {
            safe: false,
            detail: "Package.resolved is not a regular file.",
          };
    }
  }

  return { safe: false, detail: "The package lock path could not be verified." };
}

async function readSafePackageResolvedSnapshot(
  inspectionRoot: string,
  containerPath: string,
  resolvedPath: string,
): Promise<SafePackageResolvedSnapshot> {
  const before = await validatePackageResolvedPath(inspectionRoot, containerPath, resolvedPath);
  if (!before.safe) return { detail: before.detail };
  if (!before.exists) {
    return { snapshot: { status: "missing", path: resolvedPath } };
  }

  const snapshot = await readPackageResolvedSnapshot(resolvedPath);
  const after = await validatePackageResolvedPath(inspectionRoot, containerPath, resolvedPath);
  if (!after.safe) return { detail: after.detail };
  if (!after.exists || snapshot.status === "missing") {
    return { detail: "Package.resolved disappeared while it was being inspected." };
  }
  return { snapshot };
}

function packageSnapshotChange(
  before: PackageResolvedSnapshot,
  after: PackageResolvedSnapshot,
): "created" | "updated" | "unchanged" | "removed" | "invalid" {
  if (after.status === "invalid") return "invalid";
  if (before.status === "missing" && after.status === "valid") return "created";
  if (before.status === "valid" && after.status === "missing") return "removed";
  if (before.status === "valid" && after.status === "valid") {
    return before.hash === after.hash ? "unchanged" : "updated";
  }
  if (before.status === after.status) return "unchanged";
  return "invalid";
}

function packageSafetyArgs(sourcePackagesPath: string, requireResolvedVersions: boolean): string[] {
  return [
    "-clonedSourcePackagesDirPath",
    sourcePackagesPath,
    "-disableAutomaticPackageResolution",
    ...(requireResolvedVersions ? ["-onlyUsePackageVersionsFromResolvedFile"] : []),
    "-skipPackageUpdates",
  ];
}

function parseSchemeNames(output: string, kind: SelectedContainer["kind"]): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!isRecord(parsed)) return undefined;
    const section = parsed[kind];
    if (!isRecord(section) || !Array.isArray(section.schemes)) return undefined;
    const schemes = section.schemes.filter(
      (scheme): scheme is string => typeof scheme === "string" && scheme.trim().length > 0,
    );
    return [...new Set(schemes)].sort((a, b) => a.localeCompare(b));
  } catch {
    return undefined;
  }
}

function decodeXMLAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function xmlAttribute(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "s"));
  return match?.[2] == null ? undefined : decodeXMLAttribute(match[2]);
}

function referenceMatchesTarget(attributes: string, target: IOSAppTarget): boolean {
  if (xmlAttribute(attributes, "BlueprintIdentifier") !== target.id) return false;
  const referencedContainer = xmlAttribute(attributes, "ReferencedContainer")
    ?.replace(/^container:/, "")
    .replaceAll("\\", "/");
  return (
    referencedContainer == null ||
    target.projectPath.endsWith(referencedContainer) ||
    referencedContainer.endsWith(target.projectPath) ||
    basename(referencedContainer) === basename(target.projectPath)
  );
}

async function sharedSchemesReferencingTarget(
  inspection: IOSProjectInspectionResult,
  container: SelectedContainer,
  target: IOSAppTarget,
): Promise<Set<string>> {
  const directories = new Set<string>([
    join(container.absolutePath, "xcshareddata", "xcschemes"),
    join(resolve(inspection.root, target.projectPath), "xcshareddata", "xcschemes"),
  ]);
  const schemes = new Set<string>();
  for (const directory of directories) {
    if (!(await pathIsSafelyWithinIOSRoot(inspection.root, directory))) continue;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, 100)) {
      if (!entry.isFile() || !entry.name.endsWith(".xcscheme")) continue;
      const path = join(directory, entry.name);
      let info;
      try {
        info = await lstat(path);
      } catch {
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SCHEME_BYTES) continue;
      let xml: string;
      try {
        xml = await readFile(path, "utf8");
      } catch {
        continue;
      }
      const buildActions = [...xml.matchAll(/<BuildAction\b[^>]*>([\s\S]*?)<\/BuildAction>/g)];
      const referencesTarget = buildActions.some((buildAction) =>
        [...(buildAction[1] ?? "").matchAll(/<BuildableReference\b([^>]*)>/g)].some((reference) =>
          referenceMatchesTarget(reference[1] ?? "", target),
        ),
      );
      if (referencesTarget) schemes.add(basename(entry.name, ".xcscheme"));
    }
  }
  return schemes;
}

async function chooseScheme(
  inspection: IOSProjectInspectionResult,
  container: SelectedContainer,
  target: IOSAppTarget,
  requested: string | undefined,
  available: string[],
): Promise<
  { scheme: string; blueprintProven: boolean; result: CheckResult } | { result: CheckResult }
> {
  const shared = await sharedSchemesReferencingTarget(inspection, container, target);
  if (requested) {
    if (!available.includes(requested)) {
      return {
        result: fail(
          "Xcode scheme",
          `Scheme ${requested} is not available in ${container.relativePath}`,
          "Pass --scheme with one of the schemes reported by Xcode.",
          available.slice(0, 30).join("\n"),
        ),
      };
    }
    return {
      scheme: requested,
      blueprintProven: shared.has(requested),
      result: pass("Xcode scheme", `Selected ${requested}`),
    };
  }

  const targetNameIsUnique =
    inspection.appTargets.filter(
      (candidate) => candidate.projectPath === target.projectPath && candidate.name === target.name,
    ).length === 1;
  if (targetNameIsUnique && available.includes(target.name)) {
    return {
      scheme: target.name,
      blueprintProven: shared.has(target.name),
      result: pass("Xcode scheme", `Selected ${target.name}`),
    };
  }

  const provenAvailable = available.filter((scheme) => shared.has(scheme));
  if (provenAvailable.length === 1) {
    return {
      scheme: provenAvailable[0]!,
      blueprintProven: true,
      result: pass("Xcode scheme", `Selected ${provenAvailable[0]}`),
    };
  }
  if (available.length === 1 && targetNameIsUnique) {
    return {
      scheme: available[0]!,
      blueprintProven: shared.has(available[0]!),
      result: pass("Xcode scheme", `Selected ${available[0]}`),
    };
  }

  return {
    result: fail(
      "Xcode scheme",
      "No single build scheme can be selected safely for the iOS target",
      "Pass --scheme <name> after confirming which scheme builds the selected application target.",
      available.slice(0, 30).join("\n"),
    ),
  };
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function verifyBuildSettings(
  output: string,
  inspection: IOSProjectInspectionResult,
  target: IOSAppTarget,
  blueprintProven: boolean,
): Promise<VerifiedBuildSettings | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  const duplicateTargetName =
    inspection.appTargets.filter(
      (candidate) => candidate.projectPath === target.projectPath && candidate.name === target.name,
    ).length > 1;
  if (duplicateTargetName && !blueprintProven) return undefined;

  const expectedProject = resolve(inspection.root, target.projectPath);
  let expectedRealProject = expectedProject;
  try {
    expectedRealProject = await realpath(expectedProject);
  } catch {}

  const matches: Record<string, unknown>[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry) || !isRecord(entry.buildSettings)) continue;
    const settings = entry.buildSettings;
    const targetName = stringValue(settings, "TARGET_NAME") ?? stringValue(entry, "target");
    const projectFile = stringValue(settings, "PROJECT_FILE_PATH");
    const productType = stringValue(settings, "PRODUCT_TYPE");
    if (targetName !== target.name || productType !== APP_PRODUCT_TYPE || !projectFile) continue;
    let actualProject = resolve(projectFile);
    try {
      actualProject = await realpath(actualProject);
    } catch {}
    if (actualProject !== expectedRealProject) continue;
    matches.push(settings);
  }
  if (matches.length !== 1) return undefined;
  const settings = matches[0]!;
  return {
    targetBuildDir: stringValue(settings, "TARGET_BUILD_DIR"),
    fullProductName: stringValue(settings, "FULL_PRODUCT_NAME"),
    bundleIdentifier: stringValue(settings, "PRODUCT_BUNDLE_IDENTIFIER"),
  };
}

function parseSimulatorDevices(output: string): SimulatorDevice[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.devices)) return undefined;
  const devices: SimulatorDevice[] = [];
  for (const [runtimeIdentifier, values] of Object.entries(parsed.devices)) {
    if (!runtimeIdentifier.includes(".SimRuntime.iOS-") || !Array.isArray(values)) continue;
    const runtimeVersion = runtimeIdentifier.split(".SimRuntime.iOS-")[1]?.replaceAll("-", ".");
    const runtime = runtimeVersion ? `iOS ${runtimeVersion}` : "iOS";
    for (const value of values) {
      if (!isRecord(value) || value.isAvailable === false) continue;
      const name = stringValue(value, "name");
      const udid = stringValue(value, "udid");
      const state = stringValue(value, "state");
      if (name && udid && state) devices.push({ name, udid, state, runtime });
    }
  }
  return devices.sort((a, b) => a.runtime.localeCompare(b.runtime) || a.name.localeCompare(b.name));
}

function selectSimulatorDevice(
  devices: SimulatorDevice[],
  requested: string | undefined,
): { device?: SimulatorDevice; result?: CheckResult } {
  if (requested?.trim()) {
    const value = requested.trim();
    const udidMatches = devices.filter(
      (device) => device.udid.toUpperCase() === value.toUpperCase(),
    );
    const matches =
      udidMatches.length > 0 ? udidMatches : devices.filter((device) => device.name === value);
    if (matches.length === 1) return { device: matches[0] };
    if (matches.length > 1) {
      return {
        result: fail(
          "iOS Simulator",
          `More than one available simulator is named ${value}`,
          "Pass --device with the exact simulator UDID.",
          matches.map((device) => `${device.name} (${device.runtime}) ${device.udid}`).join("\n"),
        ),
      };
    }
    return {
      result: fail(
        "iOS Simulator",
        `No available iOS simulator matches ${value}`,
        "Pass --device with an available simulator UDID from `xcrun simctl list devices available`.",
      ),
    };
  }

  const booted = devices.filter((device) => device.state === "Booted");
  if (booted.length === 1) return { device: booted[0] };
  return {
    result: fail(
      "iOS Simulator",
      booted.length === 0
        ? "No single booted iOS simulator can be selected safely"
        : "More than one iOS simulator is booted",
      "Pass --device with the exact simulator UDID.",
      booted.map((device) => `${device.name} (${device.runtime}) ${device.udid}`).join("\n"),
    ),
  };
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function validateBuiltApplication(
  derivedDataPath: string,
  settings: VerifiedBuildSettings,
): Promise<{ appPath?: string; bundleIdentifier?: string; result?: CheckResult }> {
  if (!settings.targetBuildDir || !settings.fullProductName || !settings.bundleIdentifier) {
    return {
      result: fail(
        "iOS Simulator",
        "Xcode did not provide an unambiguous application path and Bundle ID",
        "Run the verified scheme from Xcode and inspect its build settings.",
      ),
    };
  }
  const appPath = resolve(settings.targetBuildDir, settings.fullProductName);
  if (!settings.fullProductName.endsWith(".app") || !isWithin(derivedDataPath, appPath)) {
    return {
      result: fail(
        "iOS Simulator",
        "The built application path is outside the isolated doctor build directory",
        "Run the selected scheme directly in Xcode; doctor will not install this product.",
      ),
    };
  }
  try {
    const info = await lstat(appPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a local app directory");
    const [realDerivedData, realApp] = await Promise.all([
      realpath(derivedDataPath),
      realpath(appPath),
    ]);
    if (!isWithin(realDerivedData, realApp)) throw new Error("external app directory");
  } catch {
    return {
      result: fail(
        "iOS Simulator",
        "The expected simulator application was not produced safely",
        "Open Xcode's build log for the selected scheme.",
      ),
    };
  }
  return { appPath, bundleIdentifier: settings.bundleIdentifier };
}

function resolvedTargetBundleIdentifiers(target: IOSAppTarget): string[] {
  return [
    ...new Set(
      target.configurations.flatMap((configuration) =>
        configuration.bundleIdentifier.state === "resolved"
          ? [configuration.bundleIdentifier.value]
          : [],
      ),
    ),
  ].sort();
}

async function makeDefaultTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clerk-doctor-ios-"));
}

async function removeDefaultTemporaryDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Runs only the explicitly requested Xcode verification phases. The supplied
 * inspection must already have one selected application target; no project,
 * package, scheme, simulator, or signing state is guessed or repaired here.
 */
export async function runIOSXcodeVerification(
  inspection: IOSProjectInspectionResult,
  options: IOSXcodeVerificationOptions,
  dependencies: IOSXcodeVerificationDependencies = {},
): Promise<CheckResult[]> {
  const requested =
    options.resolvePackages === true || options.build === true || options.simulator === true;
  if (!requested) return [];

  if (options.device && !options.simulator) {
    return [
      fail(
        "iOS Simulator",
        "--device requires --simulator",
        "Drop --device, or add --simulator to install and launch the verified build.",
      ),
    ];
  }

  const targetResolution = targetFromInspection(inspection);
  if (!targetResolution.target) return [targetResolution.result!];
  const target = targetResolution.target;

  const containerResolution = await selectContainer(inspection, target, options.container);
  if (!containerResolution.container) return [containerResolution.result!];
  const container = containerResolution.container;
  const results: CheckResult[] = [pass("Xcode container", `Using ${container.relativePath}`)];
  const hasRemotePackages = containerHasRemotePackages(inspection, container, target);
  const resolvedPath = packageResolvedPath(container);
  const initialLockRead = await readSafePackageResolvedSnapshot(
    inspection.root,
    container.absolutePath,
    resolvedPath,
  );
  if (!initialLockRead.snapshot) {
    results.push(
      fail(
        "Swift packages",
        "The shared Package.resolved path is unsafe to inspect or update",
        "Replace symbolic links in the package lock path with regular directories before running Xcode verification.",
        initialLockRead.detail,
      ),
    );
    return results;
  }
  let lockSnapshot = initialLockRead.snapshot;
  if (lockSnapshot.status === "invalid") {
    results.push(
      fail(
        "Swift packages",
        "The existing shared Package.resolved is invalid or unsafe to use",
        "Replace it with a regular valid Package.resolved, or remove it manually after reviewing the package graph, then rerun the command.",
        relativeIOSPath(inspection.root, resolvedPath),
      ),
    );
    return results;
  }
  if (!options.resolvePackages && hasRemotePackages && lockSnapshot.status === "missing") {
    results.push(
      fail(
        "Swift packages",
        "Remote Swift packages are not recorded in a shared Package.resolved",
        "Rerun with --resolve-packages --build after reviewing the package requirements.",
      ),
    );
    return results;
  }

  if ((dependencies.platform ?? process.platform) !== "darwin") {
    results.push(
      fail(
        "Xcode toolchain",
        "Xcode verification requires macOS",
        "Run this command on a Mac with Xcode installed.",
      ),
    );
    return results;
  }

  const runner = dependencies.runner ?? runIOSXcodeCommand;
  const xcrun = dependencies.xcrunPath ?? XCRUN;
  const env = createIOSXcodeChildEnvironment(dependencies.environment ?? process.env);
  const run = async (argv: readonly string[], timeoutMs: number, maxOutputBytes?: number) =>
    runner(argv, {
      cwd: inspection.root,
      env,
      timeoutMs,
      ...(maxOutputBytes ? { maxOutputBytes } : {}),
    });

  const toolchain = await run([xcrun, "xcodebuild", "-version"], TOOLCHAIN_TIMEOUT_MS);
  if (!isCommandSuccess(toolchain)) {
    results.push(
      commandFailure(
        "Xcode toolchain",
        "Xcode discovery",
        toolchain,
        "Install Xcode, accept its license, and select it with xcode-select.",
      ),
    );
    return results;
  }
  const version = sanitizeIOSXcodeDiagnostic(toolchain.stdout).split("\n")[0];
  results.push(pass("Xcode toolchain", version || "Xcode is available"));

  const customTemp = dependencies.makeTemporaryDirectory != null;
  const makeTemporaryDirectory =
    dependencies.makeTemporaryDirectory ?? makeDefaultTemporaryDirectory;
  const removeTemporaryDirectory =
    dependencies.removeTemporaryDirectory ??
    (customTemp ? async () => {} : removeDefaultTemporaryDirectory);
  let temporaryDirectory: string;
  try {
    temporaryDirectory = await makeTemporaryDirectory();
  } catch (error) {
    results.push(
      fail(
        "Xcode temporary files",
        "Could not create an isolated Xcode build directory",
        "Check the system temporary-directory permissions.",
        errorMessage(error),
      ),
    );
    return results;
  }

  const sourcePackagesPath = join(temporaryDirectory, "SourcePackages");
  const derivedDataPath = join(temporaryDirectory, "DerivedData");
  const containerArgs = [container.flag, container.absolutePath];

  try {
    if (options.resolvePackages) {
      const before = lockSnapshot;
      const resolution = await run(
        [
          xcrun,
          "xcodebuild",
          ...containerArgs,
          "-resolvePackageDependencies",
          "-clonedSourcePackagesDirPath",
          sourcePackagesPath,
          "-quiet",
        ],
        RESOLUTION_TIMEOUT_MS,
      );
      if (!isCommandSuccess(resolution)) {
        results.push(
          commandFailure(
            "Swift packages",
            "Swift package resolution",
            resolution,
            "Resolve packages in Xcode, then rerun clerk doctor.",
          ),
        );
        return results;
      }
      const resolvedLockRead = await readSafePackageResolvedSnapshot(
        inspection.root,
        container.absolutePath,
        resolvedPath,
      );
      if (!resolvedLockRead.snapshot) {
        results.push(
          fail(
            "Swift packages",
            "Xcode left the shared Package.resolved path unsafe",
            "Inspect the package lock path without following symbolic links before continuing.",
            resolvedLockRead.detail,
          ),
        );
        return results;
      }
      lockSnapshot = resolvedLockRead.snapshot;
      if (hasRemotePackages && lockSnapshot.status !== "valid") {
        results.push(
          fail(
            "Swift packages",
            "Xcode completed without producing a valid shared Package.resolved",
            "Open the selected container in Xcode and resolve its package graph.",
          ),
        );
        return results;
      }
      const change = packageSnapshotChange(before, lockSnapshot);
      if (change === "invalid" || change === "removed") {
        results.push(
          fail(
            "Swift packages",
            `Package.resolved became ${change} during resolution`,
            "Inspect the package-resolution changes before building.",
          ),
        );
        return results;
      }
      results.push(
        pass(
          "Swift packages",
          `Package resolution completed; Package.resolved ${change}`,
          relativeIOSPath(inspection.root, resolvedPath),
        ),
      );
    } else if (hasRemotePackages && lockSnapshot.status !== "valid") {
      results.push(
        fail(
          "Swift packages",
          lockSnapshot.status === "missing"
            ? "Remote Swift packages are not recorded in a shared Package.resolved"
            : "The shared Package.resolved is not safe to use",
          "Rerun with --resolve-packages --build after reviewing the package requirements.",
        ),
      );
      return results;
    } else if (hasRemotePackages) {
      results.push(pass("Swift packages", "Remote Swift packages are locked"));
    } else {
      results.push(pass("Swift packages", "No remote Swift package lock is required"));
    }

    const buildRequested = options.build === true || options.simulator === true;
    if (!buildRequested) return results;

    const safetyArgs = packageSafetyArgs(sourcePackagesPath, hasRemotePackages);
    const listResult = await run(
      [xcrun, "xcodebuild", ...containerArgs, "-list", "-json", ...safetyArgs],
      DISCOVERY_TIMEOUT_MS,
      JSON_OUTPUT_LIMIT_BYTES,
    );
    if (!isCommandSuccess(listResult) || listResult.truncated) {
      results.push(
        commandFailure(
          "Xcode scheme",
          "Scheme discovery",
          listResult,
          "Open the selected container in Xcode and confirm its shared or automatic schemes.",
        ),
      );
      return results;
    }
    const availableSchemes = parseSchemeNames(listResult.stdout, container.kind);
    if (!availableSchemes || availableSchemes.length === 0) {
      results.push(
        fail(
          "Xcode scheme",
          "Xcode did not report any build schemes for the selected container",
          "Share the application scheme or enable automatic scheme creation in Xcode.",
        ),
      );
      return results;
    }
    const schemeResolution = await chooseScheme(
      inspection,
      container,
      target,
      options.scheme,
      availableSchemes,
    );
    if (!("scheme" in schemeResolution)) {
      results.push(schemeResolution.result);
      return results;
    }
    const scheme = schemeResolution.scheme;

    const destination = "generic/platform=iOS Simulator";
    const buildBaseArgs = [
      ...containerArgs,
      "-scheme",
      scheme,
      "-destination",
      destination,
      "-derivedDataPath",
      derivedDataPath,
      ...safetyArgs,
      "CODE_SIGNING_ALLOWED=NO",
    ];
    const settingsResult = await run(
      [xcrun, "xcodebuild", ...buildBaseArgs, "-showBuildSettings", "-json"],
      DISCOVERY_TIMEOUT_MS,
      JSON_OUTPUT_LIMIT_BYTES,
    );
    if (!isCommandSuccess(settingsResult) || settingsResult.truncated) {
      results.push(
        commandFailure(
          "Xcode scheme",
          "Scheme validation",
          settingsResult,
          "Open the selected scheme in Xcode and confirm it builds the selected application target.",
        ),
      );
      return results;
    }
    const buildSettings = await verifyBuildSettings(
      settingsResult.stdout,
      inspection,
      target,
      schemeResolution.blueprintProven,
    );
    if (!buildSettings) {
      results.push(
        fail(
          "Xcode scheme",
          `Scheme ${scheme} could not be proven to build the selected application target`,
          "Pass --scheme with a scheme whose application target matches --target.",
        ),
      );
      return results;
    }
    results.push(schemeResolution.result);

    const beforeBuildRead = await readSafePackageResolvedSnapshot(
      inspection.root,
      container.absolutePath,
      resolvedPath,
    );
    if (!beforeBuildRead.snapshot) {
      results.push(
        fail(
          "Xcode build",
          "The Package.resolved path became unsafe before the frozen build",
          "Inspect the package lock path without following symbolic links before continuing.",
          beforeBuildRead.detail,
        ),
      );
      return results;
    }
    const beforeBuildLock = beforeBuildRead.snapshot;
    const preBuildLockChange = packageSnapshotChange(lockSnapshot, beforeBuildLock);
    if (preBuildLockChange !== "unchanged") {
      results.push(
        fail(
          "Xcode build",
          `Package.resolved became ${preBuildLockChange} before the frozen build`,
          "Review the package change and rerun doctor from a stable checkout.",
        ),
      );
      return results;
    }
    const buildResult = await run(
      [xcrun, "xcodebuild", ...buildBaseArgs, "-quiet", "build"],
      BUILD_TIMEOUT_MS,
      DEFAULT_OUTPUT_LIMIT_BYTES,
    );
    if (!isCommandSuccess(buildResult)) {
      results.push(
        commandFailure(
          "Xcode build",
          "iOS Simulator build",
          buildResult,
          "Open the selected scheme's build log in Xcode and fix the reported compilation error.",
        ),
      );
      return results;
    }
    const afterBuildRead = await readSafePackageResolvedSnapshot(
      inspection.root,
      container.absolutePath,
      resolvedPath,
    );
    if (!afterBuildRead.snapshot) {
      results.push(
        fail(
          "Xcode build",
          "The frozen build left the Package.resolved path unsafe",
          "Inspect the package lock path without following symbolic links before continuing.",
          afterBuildRead.detail,
        ),
      );
      return results;
    }
    const afterBuildLock = afterBuildRead.snapshot;
    const lockChange = packageSnapshotChange(beforeBuildLock, afterBuildLock);
    if (lockChange !== "unchanged") {
      results.push(
        fail(
          "Xcode build",
          `The frozen build unexpectedly left Package.resolved ${lockChange}`,
          "Review the package change; doctor will not restore or continue from unexpected Xcode mutations.",
        ),
      );
      return results;
    }
    results.push(pass("Xcode build", `Scheme ${scheme} built for iOS Simulator`));

    if (!options.simulator) return results;

    if (
      target.swift.configureCalls.some(
        (call) => call.publishableKeyWiring === "process-info-environment",
      )
    ) {
      results.push(
        fail(
          "iOS Simulator",
          "The app requires its Xcode Run-scheme Clerk environment variable",
          `Run scheme ${scheme} from Xcode. simctl launch does not safely reproduce arbitrary LaunchAction environment settings.`,
        ),
      );
      return results;
    }

    const application = await validateBuiltApplication(derivedDataPath, buildSettings);
    if (!application.appPath || !application.bundleIdentifier) {
      results.push(application.result!);
      return results;
    }
    const inspectedBundleIdentifiers = resolvedTargetBundleIdentifiers(target);
    if (
      inspectedBundleIdentifiers.length === 1 &&
      inspectedBundleIdentifiers[0] !== application.bundleIdentifier
    ) {
      results.push(
        fail(
          "iOS Simulator",
          "The built application's Bundle ID differs from the inspected target",
          "Review the scheme configuration and target build settings in Xcode.",
        ),
      );
      return results;
    }

    const simulatorList = await run(
      [xcrun, "simctl", "list", "devices", "available", "--json"],
      SIMULATOR_LIST_TIMEOUT_MS,
      JSON_OUTPUT_LIMIT_BYTES,
    );
    if (!isCommandSuccess(simulatorList) || simulatorList.truncated) {
      results.push(
        commandFailure(
          "iOS Simulator",
          "Simulator discovery",
          simulatorList,
          "Open Simulator.app and pass --device with an available iOS simulator UDID.",
        ),
      );
      return results;
    }
    const devices = parseSimulatorDevices(simulatorList.stdout);
    if (!devices) {
      results.push(
        fail(
          "iOS Simulator",
          "CoreSimulator returned malformed device information",
          "Run `xcrun simctl list devices available` and verify CoreSimulator is healthy.",
        ),
      );
      return results;
    }
    const deviceResolution = selectSimulatorDevice(devices, options.device);
    if (!deviceResolution.device) {
      results.push(deviceResolution.result!);
      return results;
    }
    const device = deviceResolution.device;

    const boot = await run(
      [xcrun, "simctl", "bootstatus", device.udid, "-b"],
      SIMULATOR_BOOT_TIMEOUT_MS,
    );
    if (!isCommandSuccess(boot)) {
      results.push(
        commandFailure(
          "iOS Simulator",
          "Simulator boot",
          boot,
          "Open Simulator.app, boot the selected device, and rerun the command.",
        ),
      );
      return results;
    }

    const install = await run(
      [xcrun, "simctl", "install", device.udid, application.appPath],
      SIMULATOR_OPERATION_TIMEOUT_MS,
    );
    if (!isCommandSuccess(install)) {
      results.push(
        commandFailure(
          "iOS Simulator",
          "Application install",
          install,
          "Inspect the selected simulator and the built app product in Xcode.",
        ),
      );
      return results;
    }

    const launch = await run(
      [xcrun, "simctl", "launch", device.udid, application.bundleIdentifier],
      SIMULATOR_OPERATION_TIMEOUT_MS,
    );
    if (!isCommandSuccess(launch)) {
      results.push(
        commandFailure(
          "iOS Simulator",
          "Application launch",
          launch,
          "Open Simulator.app and launch the installed application manually.",
        ),
      );
      return results;
    }
    results.push(
      pass(
        "iOS Simulator",
        `Launched ${application.bundleIdentifier} on ${device.name} (${device.runtime})`,
        "Manually verify sign-in, sign-out, app relaunch, and every redirect-based method you enabled.",
      ),
    );
    return results;
  } catch (error) {
    results.push(
      fail(
        "Xcode verification",
        "The optional Xcode verification could not complete",
        "Rerun with --verbose, or run the selected scheme directly in Xcode.",
        errorMessage(error),
      ),
    );
    return results;
  } finally {
    try {
      await removeTemporaryDirectory(temporaryDirectory);
    } catch (error) {
      results.push(
        warn(
          "Xcode temporary files",
          "The isolated Xcode build directory could not be removed",
          `Remove ${temporaryDirectory} after confirming no build is still running.`,
          errorMessage(error),
        ),
      );
    }
  }
}

import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { errorMessage } from "../../lib/errors.ts";
import { isRecord } from "../../lib/objects.ts";
import { interruptSignal } from "../../lib/signals.ts";
import {
  inspectWorkspace,
  maskXMLComments,
  pathIsSafelyWithinIOSRoot,
  relativeIOSPath,
  xmlAttribute as parseXMLAttribute,
} from "../init/ios/discovery.ts";
import type {
  IOSAppTarget,
  IOSProjectInspectionResult,
  IOSWorkspaceInspection,
} from "../init/ios/types.ts";
import type { CheckResult } from "./types.ts";

const XCRUN = "/usr/bin/xcrun";
const PLUTIL = "/usr/bin/plutil";
const TOOLCHAIN_TIMEOUT_MS = 10_000;
const DISCOVERY_TIMEOUT_MS = 30_000;
const RESOLUTION_TIMEOUT_MS = 5 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const SIMULATOR_LIST_TIMEOUT_MS = 15_000;
const SIMULATOR_BOOT_TIMEOUT_MS = 2 * 60_000;
const SIMULATOR_OPERATION_TIMEOUT_MS = 60_000;
const FORCE_KILL_DELAY_MS = 2_000;
const PROCESS_GROUP_EXIT_TIMEOUT_MS = 2_000;
const PROCESS_GROUP_EXIT_POLL_MS = 10;
const LEADER_EXIT_SETTLEMENT_GRACE_MS = 250;
const OUTPUT_DRAIN_GRACE_MS = 250;
const OUTPUT_CANCEL_SETTLEMENT_GRACE_MS = 250;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const JSON_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_RESOLVED_BYTES = 2 * 1024 * 1024;
const MAX_SCHEME_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 2 * 1024 * 1024;
const MAX_BUILT_INFO_PLIST_BYTES = 4 * 1024 * 1024;
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
  /** Destructive cleanup is unsafe because subprocess shutdown could not be proven. */
  artifactCleanupUnsafe?: boolean;
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
  forcedClosed: boolean;
}

interface BoundedOutputDrain {
  completion: Promise<void>;
  cancel: () => void;
  snapshot: () => BoundedOutput;
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

interface IsolatedXcodeContainer {
  container: SelectedContainer;
  lockSnapshot: PackageResolvedSnapshot;
  path: string;
  device: number;
  inode: number;
}

type OwnedTemporaryDirectory = Pick<IsolatedXcodeContainer, "path" | "device" | "inode">;

interface OwnedDirectoryBoundary extends OwnedTemporaryDirectory {
  realPath: string;
}

interface OwnedTemporaryBuildDirectory extends OwnedDirectoryBoundary {
  parent: OwnedDirectoryBoundary;
}

interface BuiltInfoPlistSnapshot {
  device: number;
  inode: number;
  hash: string;
}

interface ClaimedBuiltApplication extends OwnedTemporaryDirectory {
  boundary: OwnedDirectoryBoundary;
  originalPath: string;
  infoPlistPath: string;
  buildSettingsBundleIdentifier: string;
  infoPlistSnapshot?: BuiltInfoPlistSnapshot;
}

class IsolatedWorkspaceReplacementError extends Error {
  constructor(readonly preservedPath: string) {
    super(
      `The isolated Xcode workspace was replaced before cleanup. Its replacement was preserved at ${preservedPath}.`,
    );
    this.name = "IsolatedWorkspaceReplacementError";
  }
}

class BuiltApplicationReplacementError extends Error {
  constructor(readonly preservedPath: string) {
    super(
      `The claimed simulator application changed during verification. Its replacement was preserved at ${preservedPath}.`,
    );
    this.name = "BuiltApplicationReplacementError";
  }
}

class TemporaryBuildDirectoryReplacementError extends Error {
  constructor(readonly preservedPath: string) {
    super(
      `The isolated Xcode build directory changed during cleanup. Its replacement was preserved at ${preservedPath}.`,
    );
    this.name = "TemporaryBuildDirectoryReplacementError";
  }
}

class TemporaryBuildDirectoryCleanupError extends Error {
  constructor(
    readonly preservedPath: string,
    error: unknown,
  ) {
    super(`The quarantined Xcode build directory could not be removed: ${errorMessage(error)}`);
    this.name = "TemporaryBuildDirectoryCleanupError";
  }
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

function splitStructuralURLSuffix(value: string): { token: string; suffix: string } {
  const suffix = value.match(/[\])},.;]+$/)?.[0] ?? "";
  return {
    token: suffix ? value.slice(0, -suffix.length) : value,
    suffix,
  };
}

function sanitizeSupportedURLTokens(value: string): string {
  return value.replace(/\b(?:https?|ssh|git(?:\+ssh)?):\/\/[^\s"'`<>]+/gi, (matched) => {
    const { token, suffix } = splitStructuralURLSuffix(matched);
    const secretIndex = [token.indexOf("?"), token.indexOf("#")]
      .filter((index) => index >= 0)
      .reduce((lowest, index) => Math.min(lowest, index), token.length);
    const withoutQueryOrFragment = token.slice(0, secretIndex);
    const parsed = withoutQueryOrFragment.match(
      /^((?:https?|ssh|git(?:\+ssh)?):\/\/)([^/]*)(.*)$/i,
    );
    if (!parsed) return suffix;

    const scheme = parsed[1] ?? "";
    const rawAuthority = parsed[2] ?? "";
    const pathname = parsed[3] ?? "";
    const userInfoIndex = rawAuthority.lastIndexOf("@");
    const host = rawAuthority.slice(userInfoIndex + 1);
    const authority = userInfoIndex >= 0 ? `<redacted>@${host}` : host;
    const redactedPath = pathname && pathname !== "/" ? "/<redacted>" : pathname;
    return `${scheme}${authority}${redactedPath}${suffix}`;
  });
}

function sanitizeScpStyleURLTokens(value: string): string {
  return value.replace(
    /(^|[^A-Za-z0-9._~%+-])[A-Za-z0-9._~%+-]+@((?:\[[^\]\s"'`<>/]+\]|[^@:\s/[\]"'`<>]+)):[^\s"'`<>]+/gm,
    (matched, prefix: string, host: string) => {
      const { suffix } = splitStructuralURLSuffix(matched);
      return `${prefix}<redacted>@${host}:<redacted>${suffix}`;
    },
  );
}

function redactPEMPrivateKeys(value: string): string {
  const completePrivateKey =
    /-----BEGIN ((?:[A-Z0-9]+[ -]+)*PRIVATE KEY(?:[ -]+[A-Z0-9]+)*)-----[\s\S]*?-----END \1-----/gi;
  const unterminatedPrivateKey =
    /-----BEGIN (?:[A-Z0-9]+[ -]+)*PRIVATE KEY(?:[ -]+[A-Z0-9]+)*-----[\s\S]*$/gi;

  return value
    .replace(completePrivateKey, "<redacted>")
    .replace(unterminatedPrivateKey, "<redacted>");
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

  return sanitizeScpStyleURLTokens(
    sanitizeSupportedURLTokens(redactPEMPrivateKeys(withoutControls)),
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
    : result.artifactCleanupUnsafe
      ? `${action} left subprocess cleanup unverified`
      : result.spawnError
        ? `${action} could not start`
        : `${action} exited with code ${result.exitCode ?? "unknown"}`;
  return fail(name, reason, remedy, diagnosticDetail(result));
}

const SWIFT_PACKAGE_RECOVERY =
  "Check network access and credentials for the Swift package repositories, then rerun the command. To intentionally change package versions, rerun with --resolve-packages and review Package.resolved.";

function isSwiftPackageResolutionFailure(result: IOSXcodeCommandResult): boolean {
  const output = sanitizeIOSXcodeDiagnostic(
    [result.stderr, result.stdout, result.spawnError ?? ""].join("\n"),
  );
  return [
    /could not resolve package dependencies/i,
    /(?:package dependency|package graph|package resolution).*(?:error|failed|failure)/i,
    /(?:error|failed|failure).*(?:package dependency|package graph|package resolution)/i,
    /(?:could(?:n['’]t| not)|failed to|unable to)\s+(?:clone|fetch|update|check\s*out)\b[^\n]{0,160}\b(?:package|repository|repositories|revision)\b/i,
    /(?:invalid|corrupt|malformed).*Package\.resolved/i,
    /Package\.resolved.*(?:invalid|corrupt|malformed)/i,
  ].some((pattern) => pattern.test(output));
}

function swiftPackageCommandFailure(action: string, result: IOSXcodeCommandResult): CheckResult {
  return commandFailure("Swift packages", action, result, SWIFT_PACKAGE_RECOVERY);
}

function isCommandSuccess(result: IOSXcodeCommandResult): boolean {
  return (
    !result.timedOut && !result.spawnError && !result.artifactCleanupUnsafe && result.exitCode === 0
  );
}

function startBoundedStreamDrain(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): BoundedOutputDrain {
  const reader = stream.getReader();
  let retained = new Uint8Array(0);
  let total = 0;
  let forcedClosed = false;
  let readFailed = false;
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    if (forcedClosed) return;
    forcedClosed = true;
    try {
      cancellation = reader.cancel();
    } catch (error) {
      cancellation = Promise.reject(
        error instanceof Error ? error : new Error(errorMessage(error)),
      );
    }
    // The aggregate completion below observes this rejection too. This
    // additional handler keeps a cancellation that never rejoins the runner
    // from becoming an unhandled rejection later.
    void cancellation.catch(() => {});
  };
  const completion = (async (): Promise<void> => {
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
    } catch (error) {
      if (!forcedClosed) {
        readFailed = true;
        throw error;
      }
    } finally {
      try {
        await cancellation;
      } finally {
        reader.releaseLock();
      }
    }
  })();
  return {
    completion,
    cancel,
    snapshot: () => ({
      text: new TextDecoder().decode(retained),
      truncated: total > limit || forcedClosed || readFailed,
      forcedClosed,
    }),
  };
}

type TimedPromiseSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timed-out" };

async function settlePromiseWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<TimedPromiseSettlement<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = promise.then<TimedPromiseSettlement<T>, TimedPromiseSettlement<T>>(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  try {
    return await Promise.race([
      observed,
      new Promise<TimedPromiseSettlement<T>>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ status: "timed-out" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Default bounded, non-interactive command runner used by iOS doctor. */
export const runIOSXcodeCommand: IOSXcodeCommandRunner = async (argv, options) => {
  const usesIsolatedProcessGroup = globalThis.process.platform !== "win32";
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: options.env,
      // Xcode can launch package plugins and project-controlled build scripts.
      // A separate POSIX process group lets a timeout stop that whole tree
      // without signaling the Clerk CLI itself.
      detached: usesIsolatedProcessGroup,
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

  const signalProcessTree = (signal: NodeJS.Signals): void => {
    if (usesIsolatedProcessGroup) {
      try {
        globalThis.process.kill(-child.pid, signal);
        return;
      } catch {
        // If the isolated group disappeared there is nothing left to stop. If
        // the leader still exists, fall back to Bun's direct-child signal.
        if (child.exitCode !== null) return;
      }
    }
    try {
      child.kill(signal);
    } catch {}
  };

  const processTreeIsAlive = (): boolean => {
    if (!usesIsolatedProcessGroup) return child.exitCode === null;
    try {
      globalThis.process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      );
    }
  };

  const waitForProcessTreeExit = async (): Promise<boolean> => {
    const deadline = performance.now() + PROCESS_GROUP_EXIT_TIMEOUT_MS;
    while (processTreeIsAlive() && performance.now() < deadline) {
      await Bun.sleep(PROCESS_GROUP_EXIT_POLL_MS);
    }
    return !processTreeIsAlive();
  };

  type LeaderExitOutcome =
    | { status: "exited"; exitCode: number }
    | { status: "failed"; reason: unknown }
    | { status: "timed-out" };
  const observedLeaderExit = child.exited.then<LeaderExitOutcome, LeaderExitOutcome>(
    (exitCode) => ({ status: "exited", exitCode }),
    (reason) => ({ status: "failed", reason }),
  );
  let resolveLeaderExitDeadline: (outcome: LeaderExitOutcome) => void = () => {};
  const leaderExitDeadline = new Promise<LeaderExitOutcome>((resolveDeadline) => {
    resolveLeaderExitDeadline = resolveDeadline;
  });
  let leaderExitDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let interrupted = false;
  let timedOut = false;
  let forceKillSent = false;
  const forceKillLeader = (): void => {
    if (!forceKillSent) {
      forceKillSent = true;
      signalProcessTree("SIGKILL");
    }
    leaderExitDeadlineTimer ??= setTimeout(
      () => resolveLeaderExitDeadline({ status: "timed-out" }),
      LEADER_EXIT_SETTLEMENT_GRACE_MS,
    );
  };
  const sharedInterrupt = interruptSignal();
  const stopForInterrupt = (): void => {
    interrupted = true;
    // The CLI exits after only a short telemetry flush. Kill synchronously so
    // detached Xcode build scripts cannot outlive that shutdown window.
    forceKillLeader();
  };
  const stopForProcessExit = (): void => {
    // In an interactive terminal, clack owns raw-mode Ctrl-C while its spinner
    // is active and exits directly instead of emitting SIGINT. Process-exit
    // cleanup covers that path as well as any other early parent shutdown.
    signalProcessTree("SIGKILL");
  };

  globalThis.process.once("exit", stopForProcessExit);
  if (sharedInterrupt.aborted) stopForInterrupt();
  else sharedInterrupt.addEventListener("abort", stopForInterrupt, { once: true });

  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    signalProcessTree("SIGTERM");
    forceKillTimer = setTimeout(forceKillLeader, FORCE_KILL_DELAY_MS);
  }, options.timeoutMs);

  const outputLimit = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  const stdoutDrain = startBoundedStreamDrain(
    child.stdout as ReadableStream<Uint8Array>,
    outputLimit,
  );
  const stderrDrain = startBoundedStreamDrain(
    child.stderr as ReadableStream<Uint8Array>,
    outputLimit,
  );
  // allSettled observes both drain rejections immediately, including if a
  // stubborn stream remains pending after the runner's cancellation deadline.
  const settledDrains = Promise.allSettled([stdoutDrain.completion, stderrDrain.completion]);
  let exitCode: number | null = null;
  let spawnError: string | undefined;
  let artifactCleanupUnsafe = false;
  const leaderExit = await Promise.race([observedLeaderExit, leaderExitDeadline]);
  if (leaderExit.status === "exited") {
    exitCode = leaderExit.exitCode;
  } else if (leaderExit.status === "failed") {
    artifactCleanupUnsafe = true;
    spawnError = sanitizeIOSXcodeDiagnostic(errorMessage(leaderExit.reason));
  } else {
    artifactCleanupUnsafe = true;
    spawnError = "The Xcode command leader did not exit after forced termination.";
  }
  sharedInterrupt.removeEventListener("abort", stopForInterrupt);
  globalThis.process.removeListener("exit", stopForProcessExit);
  clearTimeout(timeout);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  if (leaderExitDeadlineTimer) clearTimeout(leaderExitDeadlineTimer);
  // The command leader can exit while a descendant that closed its stdio
  // remains alive. Force the group down and wait for it to disappear before
  // the caller can remove temporary build files that descendants may hold.
  if (timedOut && !forceKillSent) {
    forceKillSent = true;
    signalProcessTree("SIGKILL");
  }
  let shouldWaitForProcessTree = timedOut || interrupted;
  if (usesIsolatedProcessGroup && processTreeIsAlive()) {
    signalProcessTree("SIGKILL");
    shouldWaitForProcessTree = true;
  }
  if (shouldWaitForProcessTree && !(await waitForProcessTreeExit())) {
    artifactCleanupUnsafe = true;
    spawnError ??= "The Xcode subprocess group could not be confirmed stopped.";
  }

  const initialDrainSettlement = await settlePromiseWithin(settledDrains, OUTPUT_DRAIN_GRACE_MS);
  const drainsFinished = initialDrainSettlement.status === "fulfilled";
  let finalDrainSettlement = initialDrainSettlement;
  if (!drainsFinished) {
    stdoutDrain.cancel();
    stderrDrain.cancel();
    finalDrainSettlement = await settlePromiseWithin(
      settledDrains,
      OUTPUT_CANCEL_SETTLEMENT_GRACE_MS,
    );
  }
  const stdout = stdoutDrain.snapshot();
  const stderr = stderrDrain.snapshot();
  let outputError: unknown;
  if (finalDrainSettlement.status === "fulfilled") {
    const [stdoutResult, stderrResult] = finalDrainSettlement.value;
    outputError =
      stdoutResult.status === "rejected"
        ? stdoutResult.reason
        : stderrResult.status === "rejected"
          ? stderrResult.reason
          : undefined;
  } else if (finalDrainSettlement.status === "rejected") {
    outputError = finalDrainSettlement.reason;
  }
  if (outputError !== undefined) {
    artifactCleanupUnsafe = true;
    spawnError ??= sanitizeIOSXcodeDiagnostic(errorMessage(outputError));
  }
  artifactCleanupUnsafe ||=
    !drainsFinished ||
    finalDrainSettlement.status !== "fulfilled" ||
    stdout.forcedClosed ||
    stderr.forcedClosed;
  return {
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    timedOut,
    truncated: stdout.truncated || stderr.truncated,
    ...(artifactCleanupUnsafe ? { artifactCleanupUnsafe: true } : {}),
    ...(spawnError ? { spawnError } : {}),
  };
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

type ContainerPackageGraph = "direct-remote" | "incomplete" | "local-unknown" | "none";

interface WorkspacePackageReferences {
  complete: boolean;
  hasLocalPackage: boolean;
}

function resolveWorkspaceReference(
  base: string,
  location: string,
  workspaceDirectory: string,
): string {
  const separatorIndex = location.indexOf(":");
  const scheme = separatorIndex === -1 ? "group" : location.slice(0, separatorIndex);
  const rawPath = separatorIndex === -1 ? location : location.slice(separatorIndex + 1);
  if (scheme === "absolute") return resolve(rawPath);
  if (scheme === "container") return resolve(workspaceDirectory, rawPath);
  return resolve(base, rawPath);
}

async function classifyWorkspaceNonProjectReference(
  root: string,
  path: string,
): Promise<"harmless" | "local-package" | "unknown"> {
  if (path.endsWith(".xcodeproj")) return "harmless";
  if (!(await pathIsSafelyWithinIOSRoot(root, path))) return "unknown";

  let info;
  try {
    info = await lstat(path);
  } catch {
    return "unknown";
  }
  if (info.isSymbolicLink()) return "unknown";
  if (info.isFile()) return basename(path) === "Package.swift" ? "local-package" : "harmless";
  if (!info.isDirectory()) return "unknown";
  if (path.endsWith(".xcworkspace")) return "harmless";

  const manifestPath = join(path, "Package.swift");
  if (!(await pathIsSafelyWithinIOSRoot(root, manifestPath))) return "unknown";
  try {
    const manifest = await lstat(manifestPath);
    if (manifest.isSymbolicLink()) return "unknown";
    return manifest.isFile() ? "local-package" : "unknown";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "harmless";
    return "unknown";
  }
}

async function inspectWorkspacePackageReferences(
  root: string,
  workspacePath: string,
): Promise<WorkspacePackageReferences> {
  const contentsPath = join(workspacePath, "contents.xcworkspacedata");
  if (!(await pathIsSafelyWithinIOSRoot(root, contentsPath))) {
    return { complete: false, hasLocalPackage: false };
  }

  let source: string;
  try {
    const info = await lstat(contentsPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_WORKSPACE_BYTES) {
      return { complete: false, hasLocalPackage: false };
    }
    source = maskXMLComments(await readFile(contentsPath, "utf8"));
  } catch {
    return { complete: false, hasLocalPackage: false };
  }

  const workspaceDirectory = dirname(workspacePath);
  const groupBases = [workspaceDirectory];
  let complete = true;
  let hasLocalPackage = false;
  let workspaceOpen = false;
  const elementPattern = /<(\/)?(Workspace|Group|FileRef)\b([^>]*)>/g;
  for (const match of source.matchAll(elementPattern)) {
    const closing = match[1] === "/";
    const tag = match[2];
    const attributes = match[3] ?? "";
    const selfClosing = attributes.trimEnd().endsWith("/");
    if (tag === "Workspace") {
      workspaceOpen = !closing && !selfClosing;
      continue;
    }
    if (!workspaceOpen) {
      complete = false;
      continue;
    }
    if (tag === "Group") {
      if (closing) {
        if (groupBases.length > 1) groupBases.pop();
        else complete = false;
      } else {
        const location = parseXMLAttribute(attributes, "location") ?? "group:";
        groupBases.push(
          resolveWorkspaceReference(
            groupBases.at(-1) ?? workspaceDirectory,
            location,
            workspaceDirectory,
          ),
        );
        if (selfClosing) groupBases.pop();
      }
      continue;
    }
    if (closing) continue;
    const location = parseXMLAttribute(attributes, "location");
    if (!location) {
      complete = false;
      continue;
    }
    const referencePath = resolveWorkspaceReference(
      groupBases.at(-1) ?? workspaceDirectory,
      location,
      workspaceDirectory,
    );
    const state = await classifyWorkspaceNonProjectReference(root, referencePath);
    if (state === "local-package") hasLocalPackage = true;
    if (state === "unknown") complete = false;
  }
  return { complete: complete && !workspaceOpen && groupBases.length === 1, hasLocalPackage };
}

async function containerPackageGraph(
  inspection: IOSProjectInspectionResult,
  container: SelectedContainer,
  target: IOSAppTarget,
): Promise<ContainerPackageGraph> {
  let complete = true;
  let hasDirectRemotePackage = false;
  let hasLocalPackage = false;
  const projectPaths = new Set([target.projectPath]);
  if (container.kind === "workspace") {
    const [workspace, packageReferences] = await Promise.all([
      inspectWorkspace(inspection.root, container.absolutePath),
      inspectWorkspacePackageReferences(inspection.root, container.absolutePath),
    ]);
    complete = workspace.complete && packageReferences.complete;
    hasLocalPackage = packageReferences.hasLocalPackage;
    for (const projectPath of workspace.inspection.projectPaths) projectPaths.add(projectPath);
  }

  const inspectedProjects = new Map(inspection.projects.map((project) => [project.path, project]));
  for (const projectPath of projectPaths) {
    const project = inspectedProjects.get(projectPath);
    if (!project) {
      complete = false;
      continue;
    }
    for (const reference of project.packages) {
      if (reference.kind === "remote") hasDirectRemotePackage = true;
      else hasLocalPackage = true;
    }
  }
  if (!complete) return "incomplete";
  if (hasDirectRemotePackage) return "direct-remote";
  return hasLocalPackage ? "local-unknown" : "none";
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

function encodeXMLAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function createIsolatedFrozenContainer(
  inspectionRoot: string,
  source: SelectedContainer,
  sourceLock: PackageResolvedSnapshot,
): Promise<IsolatedXcodeContainer> {
  const shadowPath = join(
    dirname(source.absolutePath),
    `.clerk-doctor-${randomUUID()}.xcworkspace`,
  );
  let ownership: OwnedTemporaryDirectory | undefined;

  try {
    await mkdir(shadowPath, { mode: 0o700 });
    const created = await lstat(shadowPath);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new Error("The isolated Xcode workspace is not a local directory.");
    }
    ownership = {
      path: shadowPath,
      device: created.dev,
      inode: created.ino,
    };

    if (source.kind === "workspace") {
      for (const entry of await readdir(source.absolutePath)) {
        await cp(join(source.absolutePath, entry), join(shadowPath, entry), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
    } else {
      await writeFile(
        join(shadowPath, "contents.xcworkspacedata"),
        `<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version="1.0"><FileRef location="absolute:${encodeXMLAttribute(
          source.absolutePath,
        )}"></FileRef></Workspace>\n`,
        { mode: 0o600 },
      );
      if (sourceLock.status === "valid") {
        const shadowLockPath = join(shadowPath, "xcshareddata", "swiftpm", "Package.resolved");
        await mkdir(dirname(shadowLockPath), { recursive: true, mode: 0o700 });
        await copyFile(sourceLock.path, shadowLockPath);
      }
    }

    if (!(await pathIsSafelyWithinIOSRoot(inspectionRoot, shadowPath))) {
      throw new Error("The isolated Xcode workspace escaped the inspected project root.");
    }
    const info = await lstat(shadowPath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("The isolated Xcode workspace is not a local directory.");
    }
    if (info.dev !== ownership.device || info.ino !== ownership.inode) {
      throw new Error("The isolated Xcode workspace was replaced while it was being prepared.");
    }

    const container: SelectedContainer = {
      kind: "workspace",
      flag: "-workspace",
      absolutePath: shadowPath,
      relativePath: source.relativePath,
      ...(source.workspace ? { workspace: source.workspace } : {}),
    };
    const shadowLockPath = packageResolvedPath(container);
    const shadowRead = await readSafePackageResolvedSnapshot(
      inspectionRoot,
      shadowPath,
      shadowLockPath,
    );
    if (!shadowRead.snapshot) {
      throw new Error(
        shadowRead.detail ?? "The isolated Package.resolved could not be inspected safely.",
      );
    }
    if (packageSnapshotChange(sourceLock, shadowRead.snapshot) !== "unchanged") {
      throw new Error("Package.resolved changed while the isolated workspace was being prepared.");
    }

    return {
      container,
      lockSnapshot: shadowRead.snapshot,
      path: shadowPath,
      device: info.dev,
      inode: info.ino,
    };
  } catch (error) {
    if (ownership) {
      try {
        await removeIsolatedFrozenContainer(ownership);
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)} Cleanup also failed: ${errorMessage(cleanupError)}`,
        );
      }
    }
    throw error;
  }
}

async function removeIsolatedFrozenContainer(isolated: OwnedTemporaryDirectory): Promise<void> {
  const cleanupPath = join(
    dirname(isolated.path),
    `.clerk-doctor-cleanup-${randomUUID()}.xcworkspace`,
  );
  try {
    await rename(isolated.path, cleanupPath);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }

  const info = await lstat(cleanupPath);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== isolated.device ||
    info.ino !== isolated.inode
  ) {
    throw new IsolatedWorkspaceReplacementError(cleanupPath);
  }
  await rm(cleanupPath, { recursive: true, force: false });
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

function packageIsolationArgs(sourcePackagesPath: string, packageCachePath: string): string[] {
  return [
    "-clonedSourcePackagesDirPath",
    sourcePackagesPath,
    "-packageCachePath",
    packageCachePath,
  ];
}

function packageSafetyArgs(
  sourcePackagesPath: string,
  packageCachePath: string,
  requireResolvedVersions: boolean,
): string[] {
  return [
    ...packageIsolationArgs(sourcePackagesPath, packageCachePath),
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
        xml = maskXMLComments(await readFile(path, "utf8"));
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

async function verifiedClaimedApplicationRealPath(
  application: Pick<ClaimedBuiltApplication, "path" | "device" | "inode" | "boundary">,
): Promise<string | undefined> {
  try {
    const boundaryInfo = await lstat(application.boundary.path);
    if (
      !boundaryInfo.isDirectory() ||
      boundaryInfo.isSymbolicLink() ||
      boundaryInfo.dev !== application.boundary.device ||
      boundaryInfo.ino !== application.boundary.inode ||
      (await realpath(application.boundary.path)) !== application.boundary.realPath
    ) {
      return undefined;
    }
    const appInfo = await lstat(application.path);
    if (
      !appInfo.isDirectory() ||
      appInfo.isSymbolicLink() ||
      appInfo.dev !== application.device ||
      appInfo.ino !== application.inode
    ) {
      return undefined;
    }
    const realApp = await realpath(application.path);
    if (!isWithin(application.boundary.realPath, realApp)) return undefined;
    return realApp;
  } catch {
    return undefined;
  }
}

async function readBuiltInfoPlistSnapshot(
  application: Pick<
    ClaimedBuiltApplication,
    "path" | "device" | "inode" | "boundary" | "infoPlistPath"
  >,
): Promise<BuiltInfoPlistSnapshot | undefined> {
  try {
    const realApp = await verifiedClaimedApplicationRealPath(application);
    if (!realApp) return undefined;
    const before = await lstat(application.infoPlistPath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size <= 0 ||
      before.size > MAX_BUILT_INFO_PLIST_BYTES
    ) {
      return undefined;
    }
    const realInfoPlist = await realpath(application.infoPlistPath);
    if (!isWithin(realApp, realInfoPlist)) return undefined;
    const bytes = await readFile(application.infoPlistPath);
    const after = await lstat(application.infoPlistPath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      bytes.byteLength !== before.size
    ) {
      return undefined;
    }
    return {
      device: after.dev,
      inode: after.ino,
      hash: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return undefined;
  }
}

async function claimedBuiltApplicationStillMatches(
  application: ClaimedBuiltApplication,
): Promise<boolean> {
  if (!application.infoPlistSnapshot) return false;
  const current = await readBuiltInfoPlistSnapshot(application);
  return (
    current?.device === application.infoPlistSnapshot.device &&
    current.inode === application.infoPlistSnapshot.inode &&
    current.hash === application.infoPlistSnapshot.hash
  );
}

async function claimBuiltApplication(
  derivedDataPath: string,
  settings: VerifiedBuildSettings,
): Promise<{
  application?: ClaimedBuiltApplication;
  result?: CheckResult;
}> {
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
  let boundary: OwnedDirectoryBoundary;
  let originalInfo;
  try {
    const boundaryInfo = await lstat(derivedDataPath);
    if (!boundaryInfo.isDirectory() || boundaryInfo.isSymbolicLink()) {
      throw new Error("not a local DerivedData directory");
    }
    const realDerivedData = await realpath(derivedDataPath);
    boundary = {
      path: derivedDataPath,
      realPath: realDerivedData,
      device: boundaryInfo.dev,
      inode: boundaryInfo.ino,
    };
    originalInfo = await lstat(appPath);
    if (!originalInfo.isDirectory() || originalInfo.isSymbolicLink()) {
      throw new Error("not a local app directory");
    }
    const resolvedApp = await realpath(appPath);
    if (!isWithin(realDerivedData, resolvedApp)) throw new Error("external app directory");
  } catch {
    return {
      result: fail(
        "iOS Simulator",
        "The expected simulator application was not produced safely",
        "Open Xcode's build log for the selected scheme.",
      ),
    };
  }

  const claimedPath = join(dirname(appPath), `.clerk-doctor-built-${randomUUID()}.app`);
  try {
    await rename(appPath, claimedPath);
  } catch {
    return {
      result: fail(
        "iOS Simulator",
        "The built simulator application changed before Doctor could claim it",
        "Stop concurrent builds, then rerun the selected scheme verification.",
      ),
    };
  }

  const application: ClaimedBuiltApplication = {
    path: claimedPath,
    boundary,
    originalPath: appPath,
    device: originalInfo.dev,
    inode: originalInfo.ino,
    infoPlistPath: join(claimedPath, "Info.plist"),
    buildSettingsBundleIdentifier: settings.bundleIdentifier,
  };
  const infoPlistSnapshot = await readBuiltInfoPlistSnapshot(application);
  if (!infoPlistSnapshot) {
    return {
      application,
      result: fail(
        "iOS Simulator",
        "The built application's Info.plist is missing or unsafe, or changed during claiming",
        "Open Xcode's build log and inspect the selected application product.",
      ),
    };
  }
  application.infoPlistSnapshot = infoPlistSnapshot;
  return { application };
}

async function removeClaimedBuiltApplication(application: ClaimedBuiltApplication): Promise<void> {
  const currentMatches = application.infoPlistSnapshot
    ? await claimedBuiltApplicationStillMatches(application)
    : (await verifiedClaimedApplicationRealPath(application)) != null;
  if (!currentMatches) {
    throw new BuiltApplicationReplacementError(application.path);
  }

  const quarantinePath = await mkdtemp(
    join(dirname(application.path), ".clerk-doctor-built-cleanup-"),
  );
  const quarantineInfo = await lstat(quarantinePath);
  const quarantineRealPath = await realpath(quarantinePath);
  if (
    !quarantineInfo.isDirectory() ||
    quarantineInfo.isSymbolicLink() ||
    !isWithin(application.boundary.realPath, quarantineRealPath)
  ) {
    throw new BuiltApplicationReplacementError(quarantinePath);
  }
  const quarantine: OwnedDirectoryBoundary = {
    path: quarantinePath,
    realPath: quarantineRealPath,
    device: quarantineInfo.dev,
    inode: quarantineInfo.ino,
  };
  const cleanupPath = join(quarantinePath, "application.app");
  try {
    await rename(application.path, cleanupPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new BuiltApplicationReplacementError(application.path);
    }
    throw error;
  }

  const cleanupApplication: ClaimedBuiltApplication = {
    ...application,
    path: cleanupPath,
    boundary: quarantine,
    infoPlistPath: join(cleanupPath, "Info.plist"),
  };
  const cleanupMatches = application.infoPlistSnapshot
    ? await claimedBuiltApplicationStillMatches(cleanupApplication)
    : (await verifiedClaimedApplicationRealPath(cleanupApplication)) != null;
  if (!cleanupMatches) {
    throw new BuiltApplicationReplacementError(quarantinePath);
  }
  await rm(quarantinePath, { recursive: true, force: false });

  for (const exposedPath of [application.originalPath, application.path]) {
    try {
      await lstat(exposedPath);
      throw new BuiltApplicationReplacementError(exposedPath);
    } catch (error) {
      if (error instanceof BuiltApplicationReplacementError) throw error;
      if (!isMissingPathError(error)) throw error;
    }
  }
}

function parseBuiltBundleIdentifier(output: string): string | undefined {
  const value = output;
  if (
    !value ||
    value.length > 255 ||
    value.includes("\n") ||
    value.includes("\r") ||
    !/^[A-Za-z0-9.-]+$/.test(value)
  ) {
    return undefined;
  }
  return value;
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

async function captureOwnedTemporaryBuildDirectory(
  path: string,
): Promise<OwnedTemporaryBuildDirectory | undefined> {
  try {
    const absolutePath = resolve(path);
    const parentPath = dirname(absolutePath);
    const [info, parentInfo, realPath, parentRealPath] = await Promise.all([
      lstat(absolutePath),
      lstat(parentPath),
      realpath(absolutePath),
      realpath(parentPath),
    ]);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !parentInfo.isDirectory() ||
      parentInfo.isSymbolicLink() ||
      dirname(realPath) !== parentRealPath
    ) {
      return undefined;
    }
    return {
      path: absolutePath,
      realPath,
      device: info.dev,
      inode: info.ino,
      parent: {
        path: parentPath,
        realPath: parentRealPath,
        device: parentInfo.dev,
        inode: parentInfo.ino,
      },
    };
  } catch {
    return undefined;
  }
}

async function ownedDirectoryStillMatches(directory: OwnedDirectoryBoundary): Promise<boolean> {
  try {
    const info = await lstat(directory.path);
    return (
      info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.dev === directory.device &&
      info.ino === directory.inode &&
      (await realpath(directory.path)) === directory.realPath
    );
  } catch {
    return false;
  }
}

async function removeOwnedTemporaryBuildDirectory(
  directory: OwnedTemporaryBuildDirectory,
  removeDirectory: (path: string) => Promise<void>,
): Promise<void> {
  if (
    !(await ownedDirectoryStillMatches(directory.parent)) ||
    !(await ownedDirectoryStillMatches(directory))
  ) {
    throw new TemporaryBuildDirectoryReplacementError(directory.path);
  }

  const quarantinePath = await mkdtemp(join(directory.parent.path, ".clerk-doctor-ios-cleanup-"));
  const quarantine = await captureOwnedTemporaryBuildDirectory(quarantinePath);
  if (
    !quarantine ||
    quarantine.parent.device !== directory.parent.device ||
    quarantine.parent.inode !== directory.parent.inode ||
    quarantine.parent.realPath !== directory.parent.realPath
  ) {
    throw new TemporaryBuildDirectoryReplacementError(quarantinePath);
  }

  const cleanupPath = join(quarantine.path, "build");
  try {
    await rename(directory.path, cleanupPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new TemporaryBuildDirectoryReplacementError(directory.path);
    }
    throw error;
  }

  const cleanupDirectory: OwnedDirectoryBoundary = {
    ...directory,
    path: cleanupPath,
    realPath: join(quarantine.realPath, "build"),
  };
  if (
    !(await ownedDirectoryStillMatches(quarantine)) ||
    !(await ownedDirectoryStillMatches(cleanupDirectory))
  ) {
    throw new TemporaryBuildDirectoryReplacementError(quarantine.path);
  }

  try {
    await removeDirectory(quarantine.path);
  } catch (error) {
    throw new TemporaryBuildDirectoryCleanupError(quarantine.path, error);
  }

  for (const exposedPath of [directory.path, quarantine.path]) {
    try {
      await lstat(exposedPath);
      throw new TemporaryBuildDirectoryReplacementError(exposedPath);
    } catch (error) {
      if (error instanceof TemporaryBuildDirectoryReplacementError) throw error;
      if (!isMissingPathError(error)) throw error;
    }
  }
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
  const packageGraph = await containerPackageGraph(inspection, container, target);
  if (packageGraph === "incomplete") {
    results.push(
      fail(
        "Swift packages",
        "The Xcode container's Swift package graph could not be inspected completely",
        "Keep workspace project and package references inside the project root, repair malformed workspace metadata, then rerun the command.",
      ),
    );
    return results;
  }
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
  const originalLockSnapshot = initialLockRead.snapshot;
  let lockSnapshot = originalLockSnapshot;
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
  let usesResolvedPackageLock =
    packageGraph === "direct-remote" ||
    (packageGraph === "local-unknown" && lockSnapshot.status === "valid");
  if (!options.resolvePackages && packageGraph !== "none" && lockSnapshot.status === "missing") {
    results.push(
      fail(
        "Swift packages",
        packageGraph === "direct-remote"
          ? "Remote Swift packages are not recorded in a shared Package.resolved"
          : "Swift package dependencies could not be proven local-only, and no shared Package.resolved was found",
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
  let artifactCleanupUnsafe = false;
  const run = async (argv: readonly string[], timeoutMs: number, maxOutputBytes?: number) => {
    const result = await runner(argv, {
      cwd: inspection.root,
      env,
      timeoutMs,
      ...(maxOutputBytes ? { maxOutputBytes } : {}),
    });
    artifactCleanupUnsafe ||= result.artifactCleanupUnsafe === true;
    return result;
  };

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
  const shouldRemoveTemporaryDirectory =
    dependencies.removeTemporaryDirectory != null || !customTemp;
  const makeTemporaryDirectory =
    dependencies.makeTemporaryDirectory ?? makeDefaultTemporaryDirectory;
  const removeTemporaryDirectory =
    dependencies.removeTemporaryDirectory ??
    (customTemp ? async () => {} : removeDefaultTemporaryDirectory);
  let temporaryDirectory: string;
  let ownedTemporaryDirectory: OwnedTemporaryBuildDirectory;
  try {
    temporaryDirectory = await makeTemporaryDirectory();
    const captured = await captureOwnedTemporaryBuildDirectory(temporaryDirectory);
    if (!captured) throw new Error("The created directory is not an owned local directory.");
    ownedTemporaryDirectory = captured;
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
  const packageCachePath = join(temporaryDirectory, "PackageCache");
  const derivedDataPath = join(temporaryDirectory, "DerivedData");
  let executionContainer = container;
  let executionResolvedPath = resolvedPath;
  let containerArgs = [executionContainer.flag, executionContainer.absolutePath];
  let isolatedContainer: IsolatedXcodeContainer | undefined;
  let claimedApplication: ClaimedBuiltApplication | undefined;

  try {
    if (options.resolvePackages) {
      const before = lockSnapshot;
      const resolution = await run(
        [
          xcrun,
          "xcodebuild",
          ...containerArgs,
          "-resolvePackageDependencies",
          ...packageIsolationArgs(sourcePackagesPath, packageCachePath),
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
      if (packageGraph === "direct-remote" && lockSnapshot.status !== "valid") {
        results.push(
          fail(
            "Swift packages",
            "Xcode completed without producing a valid shared Package.resolved",
            "Open the selected container in Xcode and resolve its package graph.",
          ),
        );
        return results;
      }
      usesResolvedPackageLock = lockSnapshot.status === "valid";
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
        lockSnapshot.status === "missing"
          ? pass(
              "Swift packages",
              "Package resolution completed; no remote package lock was produced",
            )
          : pass(
              "Swift packages",
              `Package resolution completed; Package.resolved ${change}`,
              relativeIOSPath(inspection.root, resolvedPath),
            ),
      );
    } else if (usesResolvedPackageLock && lockSnapshot.status !== "valid") {
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
    } else if (packageGraph === "none") {
      results.push(pass("Swift packages", "No remote Swift package lock is required"));
    }

    const buildRequested = options.build === true || options.simulator === true;
    if (!buildRequested) return results;

    if (!options.resolvePackages) {
      isolatedContainer = await createIsolatedFrozenContainer(
        inspection.root,
        container,
        lockSnapshot,
      );
      executionContainer = isolatedContainer.container;
      executionResolvedPath = packageResolvedPath(executionContainer);
      lockSnapshot = isolatedContainer.lockSnapshot;
      containerArgs = [executionContainer.flag, executionContainer.absolutePath];
    }

    const safetyArgs = packageSafetyArgs(
      sourcePackagesPath,
      packageCachePath,
      usesResolvedPackageLock,
    );
    if (!options.resolvePackages && usesResolvedPackageLock) {
      const beforeHydrationRead = await readSafePackageResolvedSnapshot(
        inspection.root,
        executionContainer.absolutePath,
        executionResolvedPath,
      );
      if (!beforeHydrationRead.snapshot) {
        results.push(
          fail(
            "Swift packages",
            "The Package.resolved path became unsafe before fetching locked packages",
            "Inspect the package lock path without following symbolic links before continuing.",
            beforeHydrationRead.detail,
          ),
        );
        return results;
      }
      const beforeHydrationLock = beforeHydrationRead.snapshot;
      const preHydrationLockChange = packageSnapshotChange(lockSnapshot, beforeHydrationLock);
      if (preHydrationLockChange !== "unchanged") {
        results.push(
          fail(
            "Swift packages",
            `Package.resolved became ${preHydrationLockChange} before fetching locked packages`,
            "Review the package change and rerun doctor from a stable checkout.",
          ),
        );
        return results;
      }

      const hydration = await run(
        [
          xcrun,
          "xcodebuild",
          ...containerArgs,
          "-resolvePackageDependencies",
          ...safetyArgs,
          "-quiet",
        ],
        RESOLUTION_TIMEOUT_MS,
      );
      if (!isCommandSuccess(hydration)) {
        results.push(swiftPackageCommandFailure("Fetching locked Swift packages", hydration));
        return results;
      }

      const afterHydrationRead = await readSafePackageResolvedSnapshot(
        inspection.root,
        executionContainer.absolutePath,
        executionResolvedPath,
      );
      if (!afterHydrationRead.snapshot) {
        results.push(
          fail(
            "Swift packages",
            "Fetching locked packages left the Package.resolved path unsafe",
            "Inspect the package lock path without following symbolic links before continuing.",
            afterHydrationRead.detail,
          ),
        );
        return results;
      }
      const afterHydrationLock = afterHydrationRead.snapshot;
      const hydrationLockChange = packageSnapshotChange(beforeHydrationLock, afterHydrationLock);
      if (hydrationLockChange !== "unchanged") {
        results.push(
          fail(
            "Swift packages",
            `Fetching locked packages changed the isolated Package.resolved (${hydrationLockChange})`,
            "The original Package.resolved was left unchanged. Rerun with --resolve-packages only if you intend to update it.",
          ),
        );
        return results;
      }
      lockSnapshot = afterHydrationLock;
      results.push(
        pass("Swift packages", "Fetched the locked remote Swift packages for verification"),
      );
    }

    const listResult = await run(
      [xcrun, "xcodebuild", ...containerArgs, "-list", "-json", ...safetyArgs],
      DISCOVERY_TIMEOUT_MS,
      JSON_OUTPUT_LIMIT_BYTES,
    );
    if (!isCommandSuccess(listResult) || listResult.truncated) {
      results.push(
        isSwiftPackageResolutionFailure(listResult)
          ? swiftPackageCommandFailure("Swift package checkout during scheme discovery", listResult)
          : commandFailure(
              "Xcode scheme",
              "Scheme discovery",
              listResult,
              "Open the selected container in Xcode and confirm its shared or automatic schemes.",
            ),
      );
      return results;
    }
    const availableSchemes = parseSchemeNames(listResult.stdout, executionContainer.kind);
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
        isSwiftPackageResolutionFailure(settingsResult)
          ? swiftPackageCommandFailure(
              "Swift package checkout during scheme validation",
              settingsResult,
            )
          : commandFailure(
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
      executionContainer.absolutePath,
      executionResolvedPath,
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
        isSwiftPackageResolutionFailure(buildResult)
          ? swiftPackageCommandFailure("Swift package checkout during the build", buildResult)
          : commandFailure(
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
      executionContainer.absolutePath,
      executionResolvedPath,
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
          `The frozen build changed the isolated Package.resolved (${lockChange})`,
          "The original Package.resolved was left unchanged. Rerun with --resolve-packages only if you intend to update it.",
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

    const applicationResolution = await claimBuiltApplication(derivedDataPath, buildSettings);
    claimedApplication = applicationResolution.application;
    if (!claimedApplication?.infoPlistSnapshot) {
      results.push(applicationResolution.result!);
      return results;
    }
    const bundleIdentifierResult = await run(
      [
        PLUTIL,
        "-extract",
        "CFBundleIdentifier",
        "raw",
        "-expect",
        "string",
        "-n",
        "--",
        claimedApplication.infoPlistPath,
      ],
      TOOLCHAIN_TIMEOUT_MS,
      4_096,
    );
    if (!isCommandSuccess(bundleIdentifierResult)) {
      results.push(
        commandFailure(
          "iOS Simulator",
          "Built application Bundle ID inspection",
          bundleIdentifierResult,
          "Open Xcode's build log and inspect CFBundleIdentifier in the selected application product.",
        ),
      );
      return results;
    }
    if (!(await claimedBuiltApplicationStillMatches(claimedApplication))) {
      results.push(
        fail(
          "iOS Simulator",
          "The claimed simulator application changed during Bundle ID inspection",
          "Stop concurrent builds and rerun the selected scheme verification.",
        ),
      );
      return results;
    }
    const artifactBundleIdentifier = bundleIdentifierResult.truncated
      ? undefined
      : parseBuiltBundleIdentifier(bundleIdentifierResult.stdout);
    if (!artifactBundleIdentifier) {
      results.push(
        fail(
          "iOS Simulator",
          "The built application's Info.plist has an invalid Bundle ID",
          "Open Xcode's build log and inspect CFBundleIdentifier in the selected application product.",
        ),
      );
      return results;
    }
    if (artifactBundleIdentifier !== claimedApplication.buildSettingsBundleIdentifier) {
      results.push(
        fail(
          "iOS Simulator",
          "The built application's Bundle ID differs from Xcode's build settings",
          "Review the target's Info.plist processing and PRODUCT_BUNDLE_IDENTIFIER setting in Xcode.",
        ),
      );
      return results;
    }
    const inspectedBundleIdentifiers = resolvedTargetBundleIdentifiers(target);
    if (!inspectedBundleIdentifiers.includes(artifactBundleIdentifier)) {
      results.push(
        fail(
          "iOS Simulator",
          "The built application's Bundle ID does not match the inspected target",
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

    if (!(await claimedBuiltApplicationStillMatches(claimedApplication))) {
      results.push(
        fail(
          "iOS Simulator",
          "The claimed simulator application changed before installation",
          "Stop concurrent builds and rerun the selected scheme verification.",
        ),
      );
      return results;
    }

    const install = await run(
      [xcrun, "simctl", "install", device.udid, claimedApplication.path],
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
    if (!(await claimedBuiltApplicationStillMatches(claimedApplication))) {
      results.push(
        fail(
          "iOS Simulator",
          "The claimed simulator application changed during installation",
          "Stop concurrent builds and rerun the selected scheme verification.",
        ),
      );
      return results;
    }

    const launch = await run(
      [xcrun, "simctl", "launch", device.udid, artifactBundleIdentifier],
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
        `Launched ${artifactBundleIdentifier} on ${device.name} (${device.runtime})`,
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
    let preserveTemporaryDirectory = artifactCleanupUnsafe;
    if (artifactCleanupUnsafe) {
      results.push(
        warn(
          "Xcode temporary files",
          "Subprocess cleanup could not be confirmed",
          `Inspect ${temporaryDirectory} before removing it. Doctor preserved its temporary build artifacts because another process may still be using them.${isolatedContainer ? ` The isolated workspace at ${isolatedContainer.path} was also preserved.` : ""}`,
        ),
      );
    }
    if (isolatedContainer && !artifactCleanupUnsafe) {
      try {
        await removeIsolatedFrozenContainer(isolatedContainer);
      } catch (error) {
        const remedy =
          error instanceof IsolatedWorkspaceReplacementError
            ? `Inspect ${error.preservedPath} and move any user-owned files back to their intended location.`
            : `Remove ${isolatedContainer.path} after confirming it still belongs to this Doctor run.`;
        results.push(
          warn(
            "Xcode temporary files",
            "The isolated Xcode workspace could not be removed safely",
            remedy,
            errorMessage(error),
          ),
        );
      }
    }
    if (claimedApplication && !artifactCleanupUnsafe) {
      try {
        await removeClaimedBuiltApplication(claimedApplication);
      } catch (error) {
        preserveTemporaryDirectory = true;
        const remedy =
          error instanceof BuiltApplicationReplacementError
            ? `Inspect ${error.preservedPath}; Doctor preserved the replacement and its temporary build directory.`
            : `Inspect ${temporaryDirectory}; Doctor left the temporary build directory intact because claimed-app cleanup failed.`;
        results.push(
          warn(
            "Xcode temporary files",
            "The claimed simulator application could not be removed safely",
            remedy,
            errorMessage(error),
          ),
        );
      }
    }
    try {
      if (!preserveTemporaryDirectory && shouldRemoveTemporaryDirectory) {
        await removeOwnedTemporaryBuildDirectory(ownedTemporaryDirectory, removeTemporaryDirectory);
      }
    } catch (error) {
      const remedy =
        error instanceof TemporaryBuildDirectoryReplacementError
          ? `Inspect ${error.preservedPath}; Doctor preserved the replacement and did not recursively remove the exposed path.`
          : error instanceof TemporaryBuildDirectoryCleanupError
            ? `Inspect ${error.preservedPath}; Doctor left the quarantined build directory intact after cleanup failed.`
            : `Remove ${temporaryDirectory} after confirming no build is still running.`;
      results.push(
        warn(
          "Xcode temporary files",
          "The isolated Xcode build directory could not be removed",
          remedy,
          errorMessage(error),
        ),
      );
    }
    if (!options.resolvePackages) {
      const finalOriginalRead = await readSafePackageResolvedSnapshot(
        inspection.root,
        container.absolutePath,
        resolvedPath,
      );
      if (!finalOriginalRead.snapshot) {
        results.push(
          fail(
            "Swift packages",
            "The original Package.resolved path changed while Doctor was running",
            "Review the project change; Doctor ran Xcode against an isolated workspace and did not restore or overwrite it.",
            finalOriginalRead.detail,
          ),
        );
      } else {
        const originalChange = packageSnapshotChange(
          originalLockSnapshot,
          finalOriginalRead.snapshot,
        );
        if (originalChange !== "unchanged") {
          results.push(
            fail(
              "Swift packages",
              `The original Package.resolved became ${originalChange} while Doctor was running`,
              "Review the concurrent project change; Doctor ran Xcode against an isolated workspace and did not restore or overwrite it.",
            ),
          );
        }
      }
    }
  }
}

import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isAgent } from "../mode.ts";
import { CONFIG_FILE, CREDENTIALS_FILE } from "./constants.ts";
import { errorMessage } from "./errors.ts";
import { log } from "./log.ts";

export type HostCapability =
  | "home-fs"
  | "keychain"
  | "network"
  | "browser-launch"
  | "localhost-bind";

export type HostOperation = "read" | "write" | "delete" | "connect" | "open" | "listen";

export interface HostCapabilityDetails {
  operation?: HostOperation;
  target?: string;
  label?: string;
}

export interface HostStateProbeFailure {
  label: string;
  path: string;
  error: string;
}

export interface HostStateProbeResult {
  ok: boolean;
  failures: HostStateProbeFailure[];
}

let cachedAgentHostStateProbe: Promise<HostStateProbeResult> | undefined;
let warnedAboutSandbox = false;

function getProbeTargets(): Array<{ label: string; dir: string }> {
  const clerkConfigDir = process.env.CLERK_CONFIG_DIR;
  const configFile = clerkConfigDir ? join(clerkConfigDir, "config.json") : CONFIG_FILE;
  const credentialsFile = clerkConfigDir ? join(clerkConfigDir, "credentials") : CREDENTIALS_FILE;

  return [
    { label: "CLI config directory", dir: dirname(configFile) },
    { label: "credential fallback directory", dir: dirname(credentialsFile) },
  ];
}

async function probeDirectoryWrite(
  label: string,
  dir: string,
): Promise<HostStateProbeFailure | null> {
  const probePath = join(dir, `.clerk-write-probe-${process.pid}-${randomUUID()}`);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probePath, `${new Date().toISOString()}\n`);
    await unlink(probePath);
    return null;
  } catch (error) {
    return {
      label,
      path: probePath,
      error: errorMessage(error),
    };
  }
}

async function probeHomeFsAccess(details: HostCapabilityDetails): Promise<HostStateProbeResult> {
  const target = details.target;
  if (!target) {
    return { ok: true, failures: [] };
  }

  const failure = await probeDirectoryWrite(details.label ?? "host directory", dirname(target));
  return { ok: failure === null, failures: failure ? [failure] : [] };
}

function formatCapabilityContext(
  capability: HostCapability,
  details: HostCapabilityDetails,
  error?: unknown,
): string {
  const parts = [`capability=${capability}`];
  if (details.operation) parts.push(`operation=${details.operation}`);
  if (details.target) parts.push(`target=${details.target}`);
  if (error !== undefined) parts.push(`error=${errorMessage(error)}`);
  return parts.join(", ");
}

function warnAboutSandbox(detail?: string): void {
  if (warnedAboutSandbox) return;
  warnedAboutSandbox = true;

  log.warn(
    "Host-only Clerk state or capabilities may be unavailable in agent mode (possible sandboxed run). If this looks wrong, re-run on the host shell before trusting auth, link, env, or API failures.",
  );

  if (detail) {
    log.debug(detail);
  }
}

const PERMISSION_PATTERNS = [
  /\bEPERM\b/i,
  /\bEACCES\b/i,
  /operation not permitted/i,
  /permission denied/i,
  /sandbox/i,
  /interaction is not allowed/i,
  /access denied/i,
];

function matchesPermissionPattern(s: string): boolean {
  return PERMISSION_PATTERNS.some((pattern) => pattern.test(s));
}

function isPermissionLikeFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return matchesPermissionPattern(String(error));
  }

  if (matchesPermissionPattern(error.message)) return true;

  const code = (error as NodeJS.ErrnoException).code;
  if (code && matchesPermissionPattern(code)) return true;

  if (error.cause instanceof Error && isPermissionLikeFailure(error.cause)) return true;

  return false;
}

function isLikelySandboxFailure(capability: HostCapability, error: unknown): boolean {
  // browser-launch and localhost-bind only ever fail for host-capability
  // reasons, so any failure is a meaningful sandbox signal. Network failures
  // are different: a plain unreachable host (VPN, DNS, ECONNREFUSED) is not a
  // sandbox, so require a permission-like error before hinting at a sandbox.
  if (capability === "browser-launch" || capability === "localhost-bind") {
    return true;
  }

  return isPermissionLikeFailure(error);
}

async function maybeWarnForCapability(
  capability: HostCapability,
  details: HostCapabilityDetails,
): Promise<void> {
  if (!isAgent() || warnedAboutSandbox) return;
  if (capability !== "home-fs") return;

  const probe = await probeHomeFsAccess(details);
  if (!probe.ok) {
    warnAboutSandbox(`sandbox probe failures:\n${formatHostStateProbeFailures(probe.failures)}`);
  }
}

export async function withHostCapability<T>(
  capability: HostCapability,
  details: HostCapabilityDetails,
  fn: () => Promise<T>,
): Promise<T> {
  await maybeWarnForCapability(capability, details);

  try {
    return await fn();
  } catch (error) {
    observeHostCapabilityFailure(capability, error, details);
    throw error;
  }
}

export async function withHomeFsAccess<T>(
  details: HostCapabilityDetails,
  fn: () => Promise<T>,
): Promise<T> {
  return withHostCapability("home-fs", details, fn);
}

export async function withKeychainAccess<T>(
  details: HostCapabilityDetails,
  fn: () => Promise<T>,
): Promise<T> {
  return withHostCapability("keychain", details, fn);
}

export async function withNetworkAccess<T>(
  details: HostCapabilityDetails,
  fn: () => Promise<T>,
): Promise<T> {
  return withHostCapability("network", details, fn);
}

export async function withBrowserLaunch<T>(
  details: HostCapabilityDetails,
  fn: () => Promise<T>,
): Promise<T> {
  return withHostCapability("browser-launch", details, fn);
}

export function observeHostCapabilityFailure(
  capability: HostCapability,
  error: unknown,
  details: HostCapabilityDetails = {},
): void {
  if (!isAgent() || warnedAboutSandbox) return;
  if (!isLikelySandboxFailure(capability, error)) return;

  warnAboutSandbox(
    `sandbox capability failure: ${formatCapabilityContext(capability, details, error)}`,
  );
}

export async function probeHostStateAccess(): Promise<HostStateProbeResult> {
  const failures = (
    await Promise.all(
      getProbeTargets().map((target) => probeDirectoryWrite(target.label, target.dir)),
    )
  ).filter((failure): failure is HostStateProbeFailure => failure !== null);

  return { ok: failures.length === 0, failures };
}

export async function getAgentHostStateProbe(): Promise<HostStateProbeResult> {
  if (!isAgent()) {
    return { ok: true, failures: [] };
  }

  if (!cachedAgentHostStateProbe) {
    cachedAgentHostStateProbe = probeHostStateAccess();
  }

  return cachedAgentHostStateProbe;
}

export function formatHostStateProbeFailures(failures: HostStateProbeFailure[]): string {
  return failures
    .map((failure) => `${failure.label}: ${failure.error} (${failure.path})`)
    .join("\n");
}

export function _resetAgentHostStateProbe(): void {
  cachedAgentHostStateProbe = undefined;
  warnedAboutSandbox = false;
}

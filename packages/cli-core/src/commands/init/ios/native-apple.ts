import { isDeepStrictEqual } from "node:util";
import { bundleIdentifiersEqual } from "../../../lib/apple-native-identity.ts";
import { ApiError, CliError, ERROR_CODE, type ErrorCode } from "../../../lib/errors.ts";
import {
  fetchInstanceConfig,
  fetchInstanceConfigSchema,
  patchInstanceConfig,
  type InstanceConfigSchema,
} from "../../../lib/plapi.ts";
import { withNativeSpinner as withSpinner } from "./progress.ts";
import type { IOSNativePlatform } from "./types.ts";

const APPLE_CONNECTION_KEY = "connection_oauth_apple";
const CONFIG_VERSION_PATTERN = /^v1_[0-9a-f]{8}$/;
const NATIVE_APPLE_PATCH_FIELDS = new Set(["enabled", "authenticatable", "bundle_id"]);

function platformName(platform: IOSNativePlatform | undefined): "iOS" | "macOS" {
  return platform === "macos" ? "macOS" : "iOS";
}

function iosAppleError(
  message: string,
  code: ErrorCode = ERROR_CODE.IOS_REMOTE_APPLY_FAILED,
): CliError {
  return new CliError(message, { code });
}

function rethrowKnownAppleError(error: unknown): void {
  if (error instanceof CliError || error instanceof ApiError) throw error;
}

type AppleConnectionState = {
  enabled: boolean;
  authenticatable: boolean;
};

export type IOSNativeAppleBlockerCode =
  | "native-application-not-ready"
  | "bundle-identifier-unavailable"
  | "apple-config-unsupported"
  | "apple-config-invalid"
  | "apple-config-version-unavailable"
  | "apple-authenticatable-conflict"
  | "apple-bundle-identifier-conflict";

export interface IOSNativeAppleBlocker {
  code: IOSNativeAppleBlockerCode;
  message: string;
}

/**
 * Serializable, credential-free preview of the remote Apple connection work.
 * The raw Platform Config response must never be attached to this value.
 */
export type IOSNativeApplePlan = {
  schemaVersion: 1;
  kind: "clerk-ios-native-apple-connection";
  status: "ready" | "satisfied" | "blocked";
  applicationId: string;
  instanceId: string;
  platform?: IOSNativePlatform;
  bundleIdentifier: string;
  configVersion?: string;
  connection: "required" | "satisfied" | "blocked";
  bundleIdentifierConfiguration: "required" | "satisfied" | "blocked";
  current?: AppleConnectionState;
  desired: AppleConnectionState;
  actions: string[];
  blockers: IOSNativeAppleBlocker[];
};

const preservedAppleFieldFingerprints = new WeakMap<
  IOSNativeApplePlan,
  ReadonlyMap<string, string>
>();

export interface IOSNativeApplePatchOptions {
  dryRun: boolean;
  /** Required for every mutation attempt, including the server dry run. */
  ifMatch: string;
}

export interface IOSNativeAppleAPI {
  fetchInstanceConfig(
    applicationId: string,
    instanceId: string,
    keys?: string[],
  ): Promise<Record<string, unknown>>;
  fetchInstanceConfigSchema(
    applicationId: string,
    instanceId: string,
    keys?: string[],
  ): Promise<InstanceConfigSchema>;
  patchInstanceConfig(
    applicationId: string,
    instanceId: string,
    config: Record<string, unknown>,
    options: IOSNativeApplePatchOptions,
  ): Promise<Record<string, unknown>>;
}

export interface ApplyIOSNativeAppleConnectionOptions {
  api?: IOSNativeAppleAPI;
  /** Rechecks caller-owned local state immediately before the remote mutation. */
  revalidateLocalPreconditions?: () => Promise<void>;
}

/** GET-only Apple connection API surface used by read-only diagnostics. */
export type IOSNativeAppleReadAPI = Pick<
  IOSNativeAppleAPI,
  "fetchInstanceConfig" | "fetchInstanceConfigSchema"
>;

export interface AuditIOSNativeAppleHealthOptions {
  applicationId: string;
  instanceId: string;
  platform?: IOSNativePlatform;
  bundleIdentifier: string;
}

/**
 * Credential-free health projection of the current Apple runtime state. The
 * ability to automate a repair is reported separately so an unsupported patch
 * schema cannot make an already-correct runtime configuration look broken.
 */
export interface IOSNativeAppleHealthAudit {
  schemaVersion: 1;
  kind: "clerk-ios-native-apple-health";
  applicationId: string;
  instanceId: string;
  platform?: IOSNativePlatform;
  bundleIdentifier: string;
  runtime: {
    status: "required" | "satisfied" | "blocked";
    connection: "required" | "satisfied" | "blocked";
    bundleIdentifierConfiguration: "required" | "satisfied" | "blocked";
    current?: AppleConnectionState;
    blockers: IOSNativeAppleBlocker[];
  };
  automation: {
    status: "supported" | "unsupported";
    configVersion?: string;
    blockers: IOSNativeAppleBlocker[];
  };
}

const defaultAPI: IOSNativeAppleAPI = {
  fetchInstanceConfig,
  fetchInstanceConfigSchema,
  patchInstanceConfig: async (applicationId, instanceId, config, options) =>
    patchInstanceConfig(applicationId, instanceId, config, {
      dryRun: options.dryRun,
      ifMatch: options.ifMatch,
    }),
};

export interface IOSNativeAppleOptions {
  applicationId: string;
  instanceId: string;
  platform?: IOSNativePlatform;
  bundleIdentifier: string;
  /**
   * The exact selected target's registration is already satisfied or is an
   * approved prerequisite which the caller will apply before this plan.
   */
  nativeApplicationReady: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalConfigValue(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const items = value.map(canonicalConfigValue);
    return items.some((item) => item == null) ? undefined : `[${items.join(",")}]`;
  }
  if (!isRecord(value)) return undefined;

  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const item = canonicalConfigValue(value[key]);
    if (item == null) return undefined;
    entries.push(`${JSON.stringify(key)}:${item}`);
  }
  return `{${entries.join(",")}}`;
}

function preservedFieldFingerprints(
  container: Record<string, unknown>,
): ReadonlyMap<string, string> | undefined {
  const connection = container[APPLE_CONNECTION_KEY];
  if (!isRecord(connection)) return undefined;

  const fingerprints = new Map<string, string>();
  for (const [key, value] of Object.entries(connection)) {
    if (NATIVE_APPLE_PATCH_FIELDS.has(key)) continue;
    const canonical = canonicalConfigValue(value);
    if (canonical == null) return undefined;
    fingerprints.set(key, new Bun.CryptoHasher("sha256").update(canonical).digest("hex"));
  }
  return fingerprints;
}

function preservedFieldsMatch(before: IOSNativeApplePlan, after: IOSNativeApplePlan): boolean {
  const beforeFingerprints = preservedAppleFieldFingerprints.get(before);
  const afterFingerprints = preservedAppleFieldFingerprints.get(after);
  if (!beforeFingerprints || !afterFingerprints) return false;
  return [...beforeFingerprints].every(
    ([key, fingerprint]) => afterFingerprints.get(key) === fingerprint,
  );
}

function blocker(code: IOSNativeAppleBlockerCode, message: string): IOSNativeAppleBlocker {
  return { code, message };
}

function schemaSupportsNarrowApplePatch(schema: InstanceConfigSchema): boolean {
  const connection = schema.properties?.[APPLE_CONNECTION_KEY];
  return (
    connection?.type === "object" &&
    connection.properties?.enabled?.type === "boolean" &&
    connection.properties?.authenticatable?.type === "boolean" &&
    connection.properties?.bundle_id?.type === "string"
  );
}

type ParsedConnection =
  | { status: "valid"; value: AppleConnectionState; bundleIdentifier?: string }
  | { status: "invalid" };

function parseConnection(container: unknown): ParsedConnection {
  if (!isRecord(container)) return { status: "invalid" };
  const connection = container[APPLE_CONNECTION_KEY];
  if (!isRecord(connection)) return { status: "invalid" };
  if (typeof connection.enabled !== "boolean" || typeof connection.authenticatable !== "boolean") {
    return { status: "invalid" };
  }

  const bundleIdentifier = connection.bundle_id;
  if (bundleIdentifier !== undefined && typeof bundleIdentifier !== "string") {
    return { status: "invalid" };
  }
  return {
    status: "valid",
    value: {
      enabled: connection.enabled,
      authenticatable: connection.authenticatable,
    },
    ...(typeof bundleIdentifier === "string" && bundleIdentifier.trim()
      ? { bundleIdentifier: bundleIdentifier.trim() }
      : {}),
  };
}

function parseConfigVersion(
  container: Record<string, unknown>,
): { status: "missing" } | { status: "valid"; value: string } | { status: "invalid" } {
  const value = container.config_version;
  if (value == null) return { status: "missing" };
  if (typeof value !== "string" || !CONFIG_VERSION_PATTERN.test(value)) {
    return { status: "invalid" };
  }
  return { status: "valid", value };
}

function buildIOSNativeAppleHealthAudit(
  options: AuditIOSNativeAppleHealthOptions & {
    config: Record<string, unknown>;
    schema: InstanceConfigSchema;
  },
): IOSNativeAppleHealthAudit {
  const bundleIdentifier = options.bundleIdentifier.trim();
  const runtimeBlockers: IOSNativeAppleBlocker[] = [];
  if (!bundleIdentifier) {
    runtimeBlockers.push(
      blocker(
        "bundle-identifier-unavailable",
        `Resolve one Bundle ID for the selected ${platformName(options.platform)} target before verifying native Sign in with Apple.`,
      ),
    );
  }

  const parsed = parseConnection(options.config);
  if (parsed.status === "invalid") {
    runtimeBlockers.push(
      blocker(
        "apple-config-invalid",
        "The existing Apple connection configuration could not be interpreted safely. Review it in the Clerk Dashboard before continuing.",
      ),
    );
  }
  if (
    parsed.status === "valid" &&
    parsed.bundleIdentifier &&
    bundleIdentifier &&
    !bundleIdentifiersEqual(parsed.bundleIdentifier, bundleIdentifier)
  ) {
    runtimeBlockers.push(
      blocker(
        "apple-bundle-identifier-conflict",
        `The existing Apple connection references a different ${platformName(options.platform)} Bundle ID. clerk init will not replace it.`,
      ),
    );
  }
  if (parsed.status === "valid" && parsed.value.enabled && !parsed.value.authenticatable) {
    runtimeBlockers.push(
      blocker(
        "apple-authenticatable-conflict",
        "Apple is enabled but intentionally unavailable for authentication. clerk init will not override that policy automatically.",
      ),
    );
  }

  const current = parsed.status === "valid" ? parsed.value : undefined;
  const bundleIdentifierConfiguration =
    runtimeBlockers.length > 0
      ? "blocked"
      : parsed.status !== "valid"
        ? "blocked"
        : parsed.bundleIdentifier === bundleIdentifier
          ? "satisfied"
          : "required";
  const connection =
    runtimeBlockers.length > 0
      ? "blocked"
      : current?.enabled === true &&
          current.authenticatable === true &&
          bundleIdentifierConfiguration === "satisfied"
        ? "satisfied"
        : "required";
  const runtimeStatus =
    connection === "blocked" ? "blocked" : connection === "satisfied" ? "satisfied" : "required";

  const automationBlockers: IOSNativeAppleBlocker[] = [];
  if (!schemaSupportsNarrowApplePatch(options.schema)) {
    automationBlockers.push(
      blocker(
        "apple-config-unsupported",
        "This Clerk instance does not expose the narrow native Apple connection configuration required for automatic repair. Review the Apple connection in the Clerk Dashboard or contact Clerk support.",
      ),
    );
  }
  const configVersion = parseConfigVersion(options.config);
  if (configVersion.status === "invalid") {
    automationBlockers.push(
      blocker(
        "apple-config-invalid",
        "The Apple connection configuration version could not be interpreted safely. Review the Apple connection in the Clerk Dashboard or contact Clerk support before making remote changes.",
      ),
    );
  }
  if (configVersion.status === "missing" && runtimeStatus === "required") {
    automationBlockers.push(
      blocker(
        "apple-config-version-unavailable",
        "The Apple connection configuration did not include the version required to protect a remote change. Review the Apple connection in the Clerk Dashboard or contact Clerk support.",
      ),
    );
  }

  return {
    schemaVersion: 1,
    kind: "clerk-ios-native-apple-health",
    applicationId: options.applicationId,
    instanceId: options.instanceId,
    ...(options.platform ? { platform: options.platform } : {}),
    bundleIdentifier,
    runtime: {
      status: runtimeStatus,
      connection,
      bundleIdentifierConfiguration,
      ...(current ? { current } : {}),
      blockers: runtimeBlockers,
    },
    automation: {
      status: automationBlockers.length === 0 ? "supported" : "unsupported",
      ...(configVersion.status === "valid" ? { configVersion: configVersion.value } : {}),
      blockers: automationBlockers,
    },
  };
}

async function readIOSNativeAppleState(
  applicationId: string,
  instanceId: string,
  api: IOSNativeAppleReadAPI,
): Promise<{ config: Record<string, unknown>; schema: InstanceConfigSchema }> {
  const [config, schema] = await Promise.all([
    api.fetchInstanceConfig(applicationId, instanceId, [APPLE_CONNECTION_KEY]),
    api.fetchInstanceConfigSchema(applicationId, instanceId, [APPLE_CONNECTION_KEY]),
  ]);
  return { config, schema };
}

/**
 * Reads Apple connection configuration without a spinner, prompt, mutation,
 * or error wrapping. Raw config and schema responses remain internal; only a
 * credential-free health projection is returned.
 */
export async function auditIOSNativeAppleHealth(
  options: AuditIOSNativeAppleHealthOptions,
  api: IOSNativeAppleReadAPI = defaultAPI,
): Promise<IOSNativeAppleHealthAudit> {
  const state = await readIOSNativeAppleState(options.applicationId, options.instanceId, api);
  return buildIOSNativeAppleHealthAudit({ ...options, ...state });
}

export function buildIOSNativeApplePlan(
  options: IOSNativeAppleOptions & {
    config: Record<string, unknown>;
    schema: InstanceConfigSchema;
  },
): IOSNativeApplePlan {
  const health = buildIOSNativeAppleHealthAudit(options);
  const { bundleIdentifier, runtime, automation } = health;
  const blockers = [...runtime.blockers];
  if (!options.nativeApplicationReady) {
    blockers.push(
      blocker(
        "native-application-not-ready",
        `Verify the exact selected ${platformName(options.platform)} target's Clerk Native Application registration before enabling native Sign in with Apple.`,
      ),
    );
  }
  for (const automationBlocker of automation.blockers) {
    // A missing version matters only when an otherwise eligible repair remains.
    if (automationBlocker.code === "apple-config-version-unavailable" && blockers.length > 0)
      continue;
    blockers.push(automationBlocker);
  }

  const connection = blockers.length > 0 ? "blocked" : runtime.connection;
  const bundleIdentifierConfiguration =
    blockers.length > 0 ? "blocked" : runtime.bundleIdentifierConfiguration;
  const status =
    connection === "blocked" ? "blocked" : connection === "satisfied" ? "satisfied" : "ready";
  const actions =
    status === "ready"
      ? [
          `Enable native Sign in with Apple for ${bundleIdentifier} by setting enabled, authenticatable, and the exact registered Bundle ID; preserve all existing web credential fields.`,
        ]
      : [];

  const plan: IOSNativeApplePlan = {
    schemaVersion: 1,
    kind: "clerk-ios-native-apple-connection",
    status,
    applicationId: options.applicationId,
    instanceId: options.instanceId,
    ...(options.platform ? { platform: options.platform } : {}),
    bundleIdentifier,
    ...(automation.configVersion ? { configVersion: automation.configVersion } : {}),
    connection,
    bundleIdentifierConfiguration,
    ...(runtime.current ? { current: runtime.current } : {}),
    desired: { enabled: true, authenticatable: true },
    actions,
    blockers,
  };
  const fingerprints = preservedFieldFingerprints(options.config);
  if (fingerprints) preservedAppleFieldFingerprints.set(plan, fingerprints);
  return plan;
}

async function readIOSNativeApplePlan(
  options: IOSNativeAppleOptions,
  api: IOSNativeAppleAPI,
): Promise<IOSNativeApplePlan> {
  const state = await withSpinner("Auditing Clerk Sign in with Apple settings...", async () =>
    readIOSNativeAppleState(options.applicationId, options.instanceId, api),
  );
  return buildIOSNativeApplePlan({ ...options, ...state });
}

export async function auditIOSNativeAppleConnection(
  options: IOSNativeAppleOptions,
  api: IOSNativeAppleAPI = defaultAPI,
): Promise<IOSNativeApplePlan> {
  try {
    return await readIOSNativeApplePlan(options, api);
  } catch (error) {
    rethrowKnownAppleError(error);
    throw iosAppleError(
      "Clerk Sign in with Apple settings could not be inspected safely. No remote Apple connection changes were made; verify application access and rerun clerk init.",
      ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
    );
  }
}

function patchOptions(plan: IOSNativeApplePlan, dryRun: boolean): IOSNativeApplePatchOptions {
  if (!plan.configVersion) {
    throw iosAppleError(
      "The approved native Apple connection plan is missing the configuration version required to protect a remote change.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  return {
    dryRun,
    ifMatch: plan.configVersion,
  };
}

function applePatch(bundleIdentifier: string): Record<string, unknown> {
  // This intentionally excludes client_id, client_secret, team_id, key_id,
  // and every other hosted/web credential field. The exact registered native
  // Bundle ID is the only provider setting written. PLAPI's nested merge
  // semantics preserve fields which are not explicitly provided.
  return {
    [APPLE_CONNECTION_KEY]: {
      enabled: true,
      authenticatable: true,
      bundle_id: bundleIdentifier,
    },
  };
}

function validatePatchProjection(
  response: Record<string, unknown>,
  expectedBefore: AppleConnectionState,
  expectedBundleConfiguration: IOSNativeApplePlan["bundleIdentifierConfiguration"],
  bundleIdentifier: string,
  dryRun: boolean,
): void {
  if (response.dry_run !== dryRun || !isRecord(response.before) || !isRecord(response.after)) {
    throw iosAppleError(
      "Clerk returned an invalid Apple configuration projection.",
      ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    );
  }
  const beforeConnection = response.before[APPLE_CONNECTION_KEY];
  const afterConnection = response.after[APPLE_CONNECTION_KEY];
  if (
    !isRecord(beforeConnection) ||
    !isRecord(afterConnection) ||
    Object.entries(beforeConnection).some(
      ([key, value]) =>
        !Object.hasOwn(afterConnection, key) ||
        (!NATIVE_APPLE_PATCH_FIELDS.has(key) && !isDeepStrictEqual(afterConnection[key], value)),
    )
  ) {
    throw iosAppleError(
      "Clerk returned an Apple configuration projection that removed or changed existing fields.",
      ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    );
  }
  const before = parseConnection(response.before);
  const after = parseConnection(response.after);
  const beforeBundleConfiguration =
    before.status !== "valid"
      ? "blocked"
      : before.bundleIdentifier === bundleIdentifier
        ? "satisfied"
        : before.bundleIdentifier == null
          ? "required"
          : bundleIdentifiersEqual(before.bundleIdentifier, bundleIdentifier)
            ? "required"
            : "blocked";
  if (
    before.status !== "valid" ||
    after.status !== "valid" ||
    before.value.enabled !== expectedBefore.enabled ||
    before.value.authenticatable !== expectedBefore.authenticatable ||
    beforeBundleConfiguration !== expectedBundleConfiguration ||
    !after.value.enabled ||
    !after.value.authenticatable ||
    after.bundleIdentifier !== bundleIdentifier
  ) {
    throw iosAppleError(
      "Clerk returned an Apple configuration projection that did not match the approved change.",
      ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    );
  }
  if (parseConfigVersion(response).status === "invalid") {
    throw iosAppleError(
      "Clerk returned an invalid Apple configuration version.",
      ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    );
  }
}

async function validateServerPatch(
  plan: IOSNativeApplePlan,
  api: IOSNativeAppleAPI,
  dryRun: boolean,
): Promise<void> {
  if (!plan.current) {
    throw iosAppleError(
      "The approved native Apple connection plan is missing its current state.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  const response = await api.patchInstanceConfig(
    plan.applicationId,
    plan.instanceId,
    applePatch(plan.bundleIdentifier),
    patchOptions(plan, dryRun),
  );
  validatePatchProjection(
    response,
    plan.current,
    plan.bundleIdentifierConfiguration,
    plan.bundleIdentifier,
    dryRun,
  );
}

async function preflightIOSNativeAppleConnection(
  plan: IOSNativeApplePlan,
  api: IOSNativeAppleAPI,
): Promise<void> {
  try {
    await withSpinner("Validating the native Apple connection change...", async () =>
      validateServerPatch(plan, api, true),
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw iosAppleError(
      "Clerk could not safely validate native Sign in with Apple. No remote Apple connection changes were made; verify the Native Application registration and existing Apple connection, then rerun clerk init.",
      error instanceof CliError && error.code ? error.code : ERROR_CODE.IOS_REMOTE_APPLY_FAILED,
    );
  }
}

function planIdentityMatches(approved: IOSNativeApplePlan, current: IOSNativeApplePlan): boolean {
  return (
    current.applicationId === approved.applicationId &&
    current.instanceId === approved.instanceId &&
    current.platform === approved.platform &&
    bundleIdentifiersEqual(current.bundleIdentifier, approved.bundleIdentifier)
  );
}

function planVersionMatches(approved: IOSNativeApplePlan, current: IOSNativeApplePlan): boolean {
  return approved.configVersion != null && current.configVersion === approved.configVersion;
}

async function auditApprovedAppleConnection(
  plan: IOSNativeApplePlan,
  api: IOSNativeAppleAPI,
  failureMessage: string,
): Promise<IOSNativeApplePlan> {
  try {
    return await readIOSNativeApplePlan(
      {
        applicationId: plan.applicationId,
        instanceId: plan.instanceId,
        platform: plan.platform,
        bundleIdentifier: plan.bundleIdentifier,
        nativeApplicationReady: true,
      },
      api,
    );
  } catch (error) {
    rethrowKnownAppleError(error);
    throw iosAppleError(failureMessage, ERROR_CODE.IOS_REMOTE_VERIFY_FAILED);
  }
}

export async function applyIOSNativeAppleConnection(
  plan: IOSNativeApplePlan,
  options: ApplyIOSNativeAppleConnectionOptions = {},
): Promise<void> {
  const { api = defaultAPI, revalidateLocalPreconditions } = options;
  if (
    plan.status === "blocked" ||
    !plan.current ||
    !plan.bundleIdentifier ||
    (plan.status === "ready" && !plan.configVersion)
  ) {
    throw iosAppleError(
      "The approved native Apple connection plan is incomplete. No remote Apple connection changes were made; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  const current = await auditApprovedAppleConnection(
    plan,
    api,
    "Clerk Sign in with Apple settings could not be rechecked. No remote Apple connection changes were made; rerun clerk init.",
  );

  if (!planIdentityMatches(plan, current)) {
    throw iosAppleError(
      "The approved native Apple connection target changed. No remote Apple connection changes were made; rerun clerk init to review the new plan.",
      ERROR_CODE.IOS_SETUP_STALE,
    );
  }
  if (current.status === "satisfied") {
    await revalidateLocalPreconditions?.();
    return;
  }
  if (
    plan.status === "satisfied" ||
    current.status !== "ready" ||
    !current.current ||
    !planVersionMatches(plan, current) ||
    current.current.enabled !== plan.current.enabled ||
    current.current.authenticatable !== plan.current.authenticatable
  ) {
    throw iosAppleError(
      "The Clerk Apple connection changed after the approved preview. No remote Apple connection changes were made; rerun clerk init to review the current state.",
      ERROR_CODE.IOS_SETUP_STALE,
    );
  }

  await preflightIOSNativeAppleConnection(current, api);
  await revalidateLocalPreconditions?.();

  try {
    await withSpinner("Enabling native Sign in with Apple in Clerk...", async () =>
      validateServerPatch(current, api, false),
    );
  } catch (error) {
    rethrowKnownAppleError(error);
    throw iosAppleError(
      "Native Sign in with Apple could not be enabled or confirmed. No credential material was exposed; rerun clerk init to reconcile the remote state safely.",
    );
  }

  const finalPlan = await auditApprovedAppleConnection(
    plan,
    api,
    "Native Sign in with Apple was submitted but its final Clerk state could not be verified. Rerun clerk init to inspect it safely.",
  );
  if (finalPlan.status !== "satisfied" || !preservedFieldsMatch(current, finalPlan)) {
    throw iosAppleError(
      "Native Sign in with Apple did not pass final verification. Rerun clerk init to reconcile the remote state safely.",
      ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
    );
  }
}

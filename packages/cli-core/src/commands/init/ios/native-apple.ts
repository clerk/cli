import { dim, yellow } from "../../../lib/color.ts";
import { CliError, throwUsageError, throwUserAbort } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import {
  fetchInstanceConfig,
  fetchInstanceConfigSchema,
  patchInstanceConfig,
  type InstanceConfigSchema,
} from "../../../lib/plapi.ts";
import { confirm } from "../../../lib/prompts.ts";
import { withSpinner } from "../../../lib/spinner.ts";

const APPLE_CONNECTION_KEY = "connection_oauth_apple";
const CONFIG_VERSION_PATTERN = /^v1_[0-9a-f]{8}$/;

type AppleConnectionState = {
  enabled: boolean;
  authenticatable: boolean;
};

export type IOSNativeAppleBlockerCode =
  | "native-application-not-ready"
  | "bundle-identifier-unavailable"
  | "apple-config-unsupported"
  | "apple-config-invalid"
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
  bundleIdentifier: string;
  configVersion?: string;
  connection: "required" | "satisfied" | "blocked";
  bundleIdentifierConfiguration: "required" | "satisfied" | "blocked";
  current?: AppleConnectionState;
  desired: AppleConnectionState;
  actions: string[];
  blockers: IOSNativeAppleBlocker[];
};

export type IOSNativeAppleSkipped = {
  schemaVersion: 1;
  kind: "clerk-ios-native-apple-connection";
  status: "skipped";
  reason: "not-requested" | "declined";
};

export type IOSNativeApplePreparation = IOSNativeApplePlan | IOSNativeAppleSkipped;

export interface IOSNativeApplePatchOptions {
  dryRun: boolean;
  /** Forwarded only by clients which explicitly advertise support. */
  ifMatch?: string;
}

export interface IOSNativeAppleAPI {
  /**
   * PLAPI supports both server dry-run and If-Match. Test or alternate
   * adapters may opt out of If-Match; config-version revalidation remains
   * mandatory either way.
   */
  supportsIfMatch?: boolean;
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

/** GET-only Apple connection API surface used by read-only diagnostics. */
export type IOSNativeAppleReadAPI = Pick<
  IOSNativeAppleAPI,
  "fetchInstanceConfig" | "fetchInstanceConfigSchema"
>;

export interface AuditIOSNativeAppleHealthOptions {
  applicationId: string;
  instanceId: string;
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
  supportsIfMatch: true,
  fetchInstanceConfig,
  fetchInstanceConfigSchema,
  patchInstanceConfig: async (applicationId, instanceId, config, options) =>
    patchInstanceConfig(applicationId, instanceId, config, {
      dryRun: options.dryRun,
      ifMatch: options.ifMatch,
    }),
};

export interface IOSNativeApplePrompts {
  enableNativeApple(bundleIdentifier: string): Promise<boolean>;
  confirmChanges(): Promise<boolean>;
}

const defaultPrompts: IOSNativeApplePrompts = {
  enableNativeApple: async (bundleIdentifier) =>
    confirm({
      message: `Enable native Sign in with Apple for ${bundleIdentifier}?`,
      default: false,
    }),
  confirmChanges: async () =>
    confirm({
      message: "Apply this remote Clerk Sign in with Apple change?",
      default: false,
    }),
};

export interface IOSNativeAppleOptions {
  applicationId: string;
  instanceId: string;
  bundleIdentifier: string;
  /**
   * The exact selected target's registration is already satisfied or is an
   * approved prerequisite which the caller will apply before this plan.
   */
  nativeApplicationReady: boolean;
}

export interface PrepareIOSNativeAppleOptions extends IOSNativeAppleOptions {
  /**
   * `undefined` prompts a human but defaults to skipped in agent mode. `--yes`
   * is mutation consent only and never opts a project into Apple by itself.
   */
  requested?: boolean;
  agent: boolean;
  yes: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
        "Resolve one Bundle ID for the selected iOS target before verifying native Sign in with Apple.",
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
    parsed.bundleIdentifier !== bundleIdentifier
  ) {
    runtimeBlockers.push(
      blocker(
        "apple-bundle-identifier-conflict",
        "The existing Apple connection references a different iOS Bundle ID. clerk init will not replace it.",
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
        "This Clerk instance does not expose the narrow native Apple connection configuration required by clerk init.",
      ),
    );
  }
  const configVersion = parseConfigVersion(options.config);
  if (configVersion.status === "invalid") {
    automationBlockers.push(
      blocker(
        "apple-config-invalid",
        "The Apple connection configuration version could not be interpreted safely. Rerun clerk init before making remote changes.",
      ),
    );
  }

  return {
    schemaVersion: 1,
    kind: "clerk-ios-native-apple-health",
    applicationId: options.applicationId,
    instanceId: options.instanceId,
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
  const blockers: IOSNativeAppleBlocker[] = [];
  const bundleIdentifier = options.bundleIdentifier.trim();
  if (!bundleIdentifier) {
    blockers.push(
      blocker(
        "bundle-identifier-unavailable",
        "Resolve one Bundle ID for the selected iOS target before enabling native Sign in with Apple.",
      ),
    );
  }
  if (!options.nativeApplicationReady) {
    blockers.push(
      blocker(
        "native-application-not-ready",
        "Verify the exact selected iOS target's Clerk Native Application registration before enabling native Sign in with Apple.",
      ),
    );
  }
  if (!schemaSupportsNarrowApplePatch(options.schema)) {
    blockers.push(
      blocker(
        "apple-config-unsupported",
        "This Clerk instance does not expose the narrow native Apple connection configuration required by clerk init.",
      ),
    );
  }

  const parsed = parseConnection(options.config);
  if (parsed.status === "invalid") {
    blockers.push(
      blocker(
        "apple-config-invalid",
        "The existing Apple connection configuration could not be interpreted safely. Review it in the Clerk Dashboard before continuing.",
      ),
    );
  }

  const configVersion = parseConfigVersion(options.config);
  if (configVersion.status === "invalid") {
    blockers.push(
      blocker(
        "apple-config-invalid",
        "The Apple connection configuration version could not be interpreted safely. Rerun clerk init before making remote changes.",
      ),
    );
  }

  if (
    parsed.status === "valid" &&
    parsed.bundleIdentifier &&
    bundleIdentifier &&
    parsed.bundleIdentifier !== bundleIdentifier
  ) {
    blockers.push(
      blocker(
        "apple-bundle-identifier-conflict",
        "The existing Apple connection references a different iOS Bundle ID. clerk init will not replace it.",
      ),
    );
  }

  if (parsed.status === "valid" && parsed.value.enabled && !parsed.value.authenticatable) {
    blockers.push(
      blocker(
        "apple-authenticatable-conflict",
        "Apple is enabled but intentionally unavailable for authentication. clerk init will not override that policy automatically.",
      ),
    );
  }

  const current = parsed.status === "valid" ? parsed.value : undefined;
  const desired: AppleConnectionState = { enabled: true, authenticatable: true };
  const bundleIdentifierConfiguration =
    blockers.length > 0
      ? "blocked"
      : parsed.status !== "valid"
        ? "blocked"
        : parsed.bundleIdentifier === bundleIdentifier
          ? "satisfied"
          : "required";
  const connection =
    blockers.length > 0
      ? "blocked"
      : current?.enabled === true &&
          current.authenticatable === true &&
          bundleIdentifierConfiguration === "satisfied"
        ? "satisfied"
        : "required";
  const status =
    connection === "blocked" ? "blocked" : connection === "satisfied" ? "satisfied" : "ready";
  const actions =
    status === "ready"
      ? [
          `Enable native Sign in with Apple for ${bundleIdentifier} by setting enabled, authenticatable, and the exact registered Bundle ID; preserve all existing web credential fields.`,
        ]
      : [];

  return {
    schemaVersion: 1,
    kind: "clerk-ios-native-apple-connection",
    status,
    applicationId: options.applicationId,
    instanceId: options.instanceId,
    bundleIdentifier,
    ...(configVersion.status === "valid" ? { configVersion: configVersion.value } : {}),
    connection,
    bundleIdentifierConfiguration,
    ...(current ? { current } : {}),
    desired,
    actions,
    blockers,
  };
}

export async function auditIOSNativeAppleConnection(
  options: IOSNativeAppleOptions,
  api: IOSNativeAppleAPI = defaultAPI,
): Promise<IOSNativeApplePlan> {
  let config: Record<string, unknown>;
  let schema: InstanceConfigSchema;
  try {
    ({ config, schema } = await withSpinner(
      "Auditing Clerk Sign in with Apple settings...",
      async () => readIOSNativeAppleState(options.applicationId, options.instanceId, api),
    ));
  } catch {
    throw new CliError(
      "Clerk Sign in with Apple settings could not be inspected safely. No remote Apple connection changes were made; verify application access and rerun clerk init.",
    );
  }

  return buildIOSNativeApplePlan({ ...options, config, schema });
}

function skipped(reason: IOSNativeAppleSkipped["reason"]): IOSNativeAppleSkipped {
  return {
    schemaVersion: 1,
    kind: "clerk-ios-native-apple-connection",
    status: "skipped",
    reason,
  };
}

function formatBlockers(plan: IOSNativeApplePlan): string {
  return plan.blockers.map((item) => `  • ${item.message}`).join("\n");
}

function patchOptions(
  api: IOSNativeAppleAPI,
  plan: IOSNativeApplePlan,
  dryRun: boolean,
): IOSNativeApplePatchOptions {
  return {
    dryRun,
    ...(api.supportsIfMatch && plan.configVersion ? { ifMatch: plan.configVersion } : {}),
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
    throw new Error("invalid Apple config patch response");
  }
  const beforeConnection = response.before[APPLE_CONNECTION_KEY];
  const afterConnection = response.after[APPLE_CONNECTION_KEY];
  if (
    !isRecord(beforeConnection) ||
    !isRecord(afterConnection) ||
    Object.keys(beforeConnection).some((key) => !Object.hasOwn(afterConnection, key))
  ) {
    throw new Error("Apple config patch projection removed existing fields");
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
    throw new Error("unexpected Apple config patch projection");
  }
  if (parseConfigVersion(response).status === "invalid") {
    throw new Error("invalid Apple config patch version");
  }
}

async function validateServerPatch(
  plan: IOSNativeApplePlan,
  api: IOSNativeAppleAPI,
  dryRun: boolean,
): Promise<void> {
  if (!plan.current) throw new Error("missing approved Apple connection state");
  const response = await api.patchInstanceConfig(
    plan.applicationId,
    plan.instanceId,
    applePatch(plan.bundleIdentifier),
    patchOptions(api, plan, dryRun),
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
  } catch {
    throw new CliError(
      "Clerk could not safely validate native Sign in with Apple. No remote Apple connection changes were made; verify the Native Application registration and existing Apple connection, then rerun clerk init.",
    );
  }
}

export async function prepareIOSNativeAppleConnection(
  options: PrepareIOSNativeAppleOptions,
  dependencies: {
    api?: IOSNativeAppleAPI;
    prompts?: IOSNativeApplePrompts;
  } = {},
): Promise<IOSNativeApplePreparation> {
  const api = dependencies.api ?? defaultAPI;
  const prompts = dependencies.prompts ?? defaultPrompts;

  if (options.requested === false || (options.requested == null && options.agent)) {
    return skipped("not-requested");
  }
  if (
    options.requested == null &&
    !(await prompts.enableNativeApple(options.bundleIdentifier.trim()))
  ) {
    return skipped("declined");
  }

  const plan = await auditIOSNativeAppleConnection(options, api);
  if (plan.status === "blocked") {
    throw new CliError(
      `Native Sign in with Apple could not be enabled safely. No remote Apple connection changes were made:\n${formatBlockers(plan)}`,
    );
  }
  if (plan.status === "satisfied") {
    log.info(dim("Native Sign in with Apple is already enabled in Clerk."));
    return plan;
  }

  log.info("\nclerk init will make the following remote Clerk change:\n");
  for (const action of plan.actions) log.info(`  ${yellow("REMOTE")}  ${action}`);
  log.info(
    dim(
      "\n  This native-only setup will not request, replace, or print an Apple Services ID, Team ID, Key ID, or private key.",
    ),
  );
  log.blank();

  if (options.agent && !options.yes) {
    throwUsageError(
      "Changing the Clerk Apple connection in agent mode requires explicit mutation consent. Rerun the same command with --yes after reviewing the plan.",
    );
  }
  if (!options.yes && !(await prompts.confirmChanges())) throwUserAbort();
  return plan;
}

function planIdentityMatches(approved: IOSNativeApplePlan, current: IOSNativeApplePlan): boolean {
  return (
    current.applicationId === approved.applicationId &&
    current.instanceId === approved.instanceId &&
    current.bundleIdentifier === approved.bundleIdentifier
  );
}

function planVersionMatches(approved: IOSNativeApplePlan, current: IOSNativeApplePlan): boolean {
  if (!approved.configVersion) return true;
  return current.configVersion === approved.configVersion;
}

export async function applyIOSNativeAppleConnection(
  plan: IOSNativeApplePlan,
  api: IOSNativeAppleAPI = defaultAPI,
): Promise<void> {
  if (plan.status === "blocked" || !plan.current || !plan.bundleIdentifier) {
    throw new CliError(
      "The approved native Apple connection plan is incomplete. No remote Apple connection changes were made; rerun clerk init.",
    );
  }
  const approvedWasSatisfied = plan.status === "satisfied";

  let current: IOSNativeApplePlan;
  try {
    current = await auditIOSNativeAppleConnection(
      {
        applicationId: plan.applicationId,
        instanceId: plan.instanceId,
        bundleIdentifier: plan.bundleIdentifier,
        nativeApplicationReady: true,
      },
      api,
    );
  } catch {
    throw new CliError(
      "Clerk Sign in with Apple settings could not be rechecked. No remote Apple connection changes were made; rerun clerk init.",
    );
  }

  if (!planIdentityMatches(plan, current)) {
    throw new CliError(
      "The approved native Apple connection target changed. No remote Apple connection changes were made; rerun clerk init to review the new plan.",
    );
  }
  if (approvedWasSatisfied) {
    if (current.status !== "satisfied") {
      throw new CliError(
        "The Clerk Apple connection changed after the approved preview. No remote Apple connection changes were made; rerun clerk init to review the current state.",
      );
    }
    return;
  }
  if (current.status === "satisfied") return;
  if (
    current.status !== "ready" ||
    !current.current ||
    !planVersionMatches(plan, current) ||
    current.current.enabled !== plan.current.enabled ||
    current.current.authenticatable !== plan.current.authenticatable
  ) {
    throw new CliError(
      "The Clerk Apple connection changed after the approved preview. No remote Apple connection changes were made; rerun clerk init to review the current state.",
    );
  }

  await preflightIOSNativeAppleConnection(current, api);

  try {
    await withSpinner("Enabling native Sign in with Apple in Clerk...", async () =>
      validateServerPatch(current, api, false),
    );
  } catch {
    throw new CliError(
      "Native Sign in with Apple could not be enabled or confirmed. No credential material was exposed; rerun clerk init to reconcile the remote state safely.",
    );
  }

  let finalPlan: IOSNativeApplePlan;
  try {
    finalPlan = await auditIOSNativeAppleConnection(
      {
        applicationId: plan.applicationId,
        instanceId: plan.instanceId,
        bundleIdentifier: plan.bundleIdentifier,
        nativeApplicationReady: true,
      },
      api,
    );
  } catch {
    throw new CliError(
      "Native Sign in with Apple was submitted but its final Clerk state could not be verified. Rerun clerk init to inspect it safely.",
    );
  }
  if (finalPlan.status !== "satisfied") {
    throw new CliError(
      "Native Sign in with Apple did not pass final verification. Rerun clerk init to reconcile the remote state safely.",
    );
  }
  log.success("Native Sign in with Apple enabled in Clerk");
}

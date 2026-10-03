import { isDeepStrictEqual } from "node:util";
import { bundleIdentifiersEqual } from "../../../lib/apple-native-identity.ts";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";
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
// The only fields native setup writes; every hosted credential field is left alone.
const NATIVE_APPLE_FIELDS = new Set(["enabled", "authenticatable", "bundle_id"]);

type AppleConnectionState = { enabled: boolean; authenticatable: boolean };

export interface IOSNativeAppleBlocker {
  code:
    | "bundle-identifier-unavailable"
    | "apple-config-unsupported"
    | "apple-config-invalid"
    | "apple-config-version-unavailable"
    | "apple-authenticatable-conflict"
    | "apple-bundle-identifier-conflict";
  message: string;
}

export interface IOSNativeAppleTarget {
  applicationId: string;
  instanceId: string;
  platform?: IOSNativePlatform;
  bundleIdentifier: string;
}

/** Credential-free view of the Apple connection; raw config never leaves this module. */
export interface IOSNativeAppleHealthAudit {
  runtime: {
    status: "required" | "satisfied" | "blocked";
    bundleIdentifierConfiguration: "required" | "satisfied" | "blocked";
    current?: AppleConnectionState;
    blockers: IOSNativeAppleBlocker[];
  };
}

export type IOSNativeApplePlan = IOSNativeAppleTarget & {
  status: "ready" | "satisfied" | "blocked";
  configVersion?: string;
  bundleIdentifierConfiguration: "required" | "satisfied" | "blocked";
  current?: AppleConnectionState;
  actions: string[];
  blockers: IOSNativeAppleBlocker[];
};

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
    options: { dryRun: boolean; ifMatch: string },
  ): Promise<Record<string, unknown>>;
}

const defaultAPI: IOSNativeAppleAPI = {
  fetchInstanceConfig,
  fetchInstanceConfigSchema,
  patchInstanceConfig,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function platformName(platform: IOSNativePlatform | undefined): "iOS" | "macOS" {
  return platform === "macos" ? "macOS" : "iOS";
}

function parseConnection(
  container: unknown,
): { current: AppleConnectionState; bundleIdentifier?: string } | undefined {
  const connection = isRecord(container) ? container[APPLE_CONNECTION_KEY] : undefined;
  if (
    !isRecord(connection) ||
    typeof connection.enabled !== "boolean" ||
    typeof connection.authenticatable !== "boolean" ||
    (connection.bundle_id !== undefined && typeof connection.bundle_id !== "string")
  )
    return undefined;
  const bundleIdentifier = connection.bundle_id?.trim();
  return {
    current: { enabled: connection.enabled, authenticatable: connection.authenticatable },
    ...(bundleIdentifier ? { bundleIdentifier } : {}),
  };
}

function runtimeHealth(
  target: IOSNativeAppleTarget,
  config: Record<string, unknown>,
): IOSNativeAppleHealthAudit["runtime"] {
  const bundleIdentifier = target.bundleIdentifier.trim();
  const platform = platformName(target.platform);
  const parsed = parseConnection(config);
  const blockers: IOSNativeAppleBlocker[] = [];
  if (!bundleIdentifier)
    blockers.push({
      code: "bundle-identifier-unavailable",
      message: `Resolve one Bundle ID for the selected ${platform} target before verifying native Sign in with Apple.`,
    });
  if (!parsed)
    blockers.push({
      code: "apple-config-invalid",
      message:
        "The existing Apple connection configuration could not be interpreted safely. Review it in the Clerk Dashboard before continuing.",
    });
  // A case-only difference is repaired to the registration's spelling; anything else is someone else's app.
  if (
    parsed?.bundleIdentifier &&
    bundleIdentifier &&
    !bundleIdentifiersEqual(parsed.bundleIdentifier, bundleIdentifier)
  )
    blockers.push({
      code: "apple-bundle-identifier-conflict",
      message: `The existing Apple connection references a different ${platform} Bundle ID. clerk init will not replace it.`,
    });
  if (parsed?.current.enabled && !parsed.current.authenticatable)
    blockers.push({
      code: "apple-authenticatable-conflict",
      message:
        "Apple is enabled but intentionally unavailable for authentication. clerk init will not override that policy automatically.",
    });

  const bundleIdentifierConfiguration = blockers.length
    ? "blocked"
    : parsed?.bundleIdentifier === bundleIdentifier
      ? "satisfied"
      : "required";
  const status = blockers.length
    ? "blocked"
    : parsed?.current.enabled &&
        parsed.current.authenticatable &&
        bundleIdentifierConfiguration === "satisfied"
      ? "satisfied"
      : "required";
  return {
    status,
    bundleIdentifierConfiguration,
    ...(parsed ? { current: parsed.current } : {}),
    blockers,
  };
}

/** Reads the Apple connection without a spinner, prompt, or mutation. */
export async function auditIOSNativeAppleHealth(
  target: IOSNativeAppleTarget,
  api: Pick<IOSNativeAppleAPI, "fetchInstanceConfig"> = defaultAPI,
): Promise<IOSNativeAppleHealthAudit> {
  const config = await api.fetchInstanceConfig(target.applicationId, target.instanceId, [
    APPLE_CONNECTION_KEY,
  ]);
  return { runtime: runtimeHealth(target, config) };
}

export async function auditIOSNativeAppleConnection(
  target: IOSNativeAppleTarget,
  api: IOSNativeAppleAPI = defaultAPI,
): Promise<IOSNativeApplePlan> {
  const [config, schema] = await withSpinner(
    "Auditing Clerk Sign in with Apple settings...",
    async () =>
      Promise.all([
        api.fetchInstanceConfig(target.applicationId, target.instanceId, [APPLE_CONNECTION_KEY]),
        api.fetchInstanceConfigSchema(target.applicationId, target.instanceId, [
          APPLE_CONNECTION_KEY,
        ]),
      ]),
  );
  const runtime = runtimeHealth(target, config);
  const blockers = [...runtime.blockers];
  const configVersion =
    typeof config.config_version === "string" && CONFIG_VERSION_PATTERN.test(config.config_version)
      ? config.config_version
      : undefined;
  // Only a needed repair depends on the patch schema and the If-Match version.
  if (runtime.status === "required") {
    const properties = schema.properties?.[APPLE_CONNECTION_KEY]?.properties;
    if (
      properties?.enabled?.type !== "boolean" ||
      properties.authenticatable?.type !== "boolean" ||
      properties.bundle_id?.type !== "string"
    )
      blockers.push({
        code: "apple-config-unsupported",
        message:
          "This Clerk instance does not expose the native Apple connection settings needed for automatic setup. Review the Apple connection in the Clerk Dashboard.",
      });
    if (!configVersion)
      blockers.push({
        code: "apple-config-version-unavailable",
        message:
          "Clerk did not return the configuration version needed to protect this change. Review the Apple connection in the Clerk Dashboard.",
      });
  }
  const status = blockers.length
    ? "blocked"
    : runtime.status === "satisfied"
      ? "satisfied"
      : "ready";
  const bundleIdentifier = target.bundleIdentifier.trim();
  return {
    applicationId: target.applicationId,
    instanceId: target.instanceId,
    ...(target.platform ? { platform: target.platform } : {}),
    bundleIdentifier,
    status,
    ...(configVersion ? { configVersion } : {}),
    bundleIdentifierConfiguration: blockers.length
      ? "blocked"
      : runtime.bundleIdentifierConfiguration,
    ...(runtime.current ? { current: runtime.current } : {}),
    actions:
      status === "ready"
        ? [
            `Enable native Sign in with Apple for ${bundleIdentifier} by setting enabled, authenticatable, and the exact registered Bundle ID; preserve all existing web credential fields.`,
          ]
        : [],
    blockers,
  };
}

/** Checks a PATCH projection: every other field (web credentials included) survives the merge. */
function checkProjection(
  response: Record<string, unknown>,
  bundleIdentifier: string,
  dryRun: boolean,
): void {
  const before = isRecord(response.before) ? response.before[APPLE_CONNECTION_KEY] : undefined;
  const after = isRecord(response.after) ? response.after[APPLE_CONNECTION_KEY] : undefined;
  const parsed = parseConnection(response.after);
  if (
    response.dry_run !== dryRun ||
    !isRecord(before) ||
    !isRecord(after) ||
    Object.entries(before).some(
      ([key, value]) =>
        !Object.hasOwn(after, key) ||
        (!NATIVE_APPLE_FIELDS.has(key) && !isDeepStrictEqual(after[key], value)),
    ) ||
    !parsed?.current.enabled ||
    !parsed.current.authenticatable ||
    parsed.bundleIdentifier !== bundleIdentifier
  )
    throw new CliError(
      "Clerk's Apple configuration response did not match the approved change. No further Apple changes were made.",
      { code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE },
    );
}

export async function applyIOSNativeAppleConnection(
  plan: IOSNativeApplePlan,
  options: {
    api?: IOSNativeAppleAPI;
    /** Rechecks caller-owned local state immediately before the remote write. */
    revalidateLocalPreconditions?: () => Promise<void>;
  } = {},
): Promise<void> {
  const { api = defaultAPI, revalidateLocalPreconditions } = options;
  if (plan.status === "satisfied") {
    await revalidateLocalPreconditions?.();
    return;
  }
  const ifMatch = plan.configVersion;
  if (plan.status !== "ready" || !ifMatch)
    throw new CliError(
      "The approved Sign in with Apple plan can't be applied; rerun clerk init to review it.",
      { code: ERROR_CODE.IOS_SETUP_PLAN_INVALID },
    );
  const patch = {
    [APPLE_CONNECTION_KEY]: {
      enabled: true,
      authenticatable: true,
      bundle_id: plan.bundleIdentifier,
    },
  };
  const send = async (dryRun: boolean) =>
    api.patchInstanceConfig(plan.applicationId, plan.instanceId, patch, { dryRun, ifMatch });

  // The dry run proves the server's merge keeps every other field before anything is written.
  const preview = await withSpinner("Validating the Sign in with Apple change...", async () =>
    send(true),
  );
  checkProjection(preview, plan.bundleIdentifier, true);
  await revalidateLocalPreconditions?.();
  const written = await withSpinner("Enabling native Sign in with Apple in Clerk...", async () =>
    send(false),
  );
  checkProjection(written, plan.bundleIdentifier, false);

  if ((await auditIOSNativeAppleConnection(plan, api)).status !== "satisfied")
    throw new CliError(
      "Native Sign in with Apple did not pass final verification. Rerun clerk init to reconcile it.",
      { code: ERROR_CODE.IOS_REMOTE_VERIFY_FAILED },
    );
}

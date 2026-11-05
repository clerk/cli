import { isDeepStrictEqual } from "node:util";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";
import {
  fetchInstanceConfig,
  fetchInstanceConfigSchema,
  patchInstanceConfig,
  type InstanceConfigSchema,
} from "../../../lib/plapi.ts";
import { withNativeSpinner as withSpinner } from "../native/progress.ts";
import { setupError } from "./types.ts";

export const GOOGLE_CONNECTION_KEY = "connection_oauth_google";
const CONFIG_VERSION_PATTERN = /^v1_[0-9a-f]{8}$/;
// The only fields native setup writes; anything else in the connection is left alone.
const NATIVE_GOOGLE_FIELDS = new Set(["enabled", "authenticatable", "client_id", "client_secret"]);
export const GOOGLE_GUIDE =
  "https://clerk.com/docs/guides/configure/auth-strategies/sign-in-with-google";

/** A Google Cloud Web client: the ID the SDK passes to Credential Manager, and its secret. */
export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}

/** Credential-free view of the connection; the secret never leaves this module. */
export interface GoogleConnectionState {
  enabled: boolean;
  authenticatable: boolean;
  /** The custom Web client ID, when one is configured. */
  clientId?: string;
}

export interface GoogleBlocker {
  code:
    | "google-config-invalid"
    | "google-config-unsupported"
    | "google-config-version-unavailable"
    | "google-authenticatable-conflict";
  message: string;
}

export interface GoogleTarget {
  applicationId: string;
  instanceId: string;
}

export interface GoogleHealth {
  status: "required" | "satisfied" | "blocked";
  /** Whether a Web client ID is configured; the Android SDK reads it as the One Tap client ID. */
  credentials: "required" | "satisfied";
  current?: GoogleConnectionState;
  blockers: GoogleBlocker[];
}

export type GooglePlan = GoogleTarget &
  Omit<GoogleHealth, "status"> & {
    status: "ready" | "satisfied" | "blocked";
    configVersion?: string;
    actions: string[];
  };

export interface GoogleAPI {
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

const defaultAPI: GoogleAPI = {
  fetchInstanceConfig,
  fetchInstanceConfigSchema,
  patchInstanceConfig,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConnection(container: unknown): GoogleConnectionState | undefined {
  const connection = isRecord(container) ? container[GOOGLE_CONNECTION_KEY] : undefined;
  if (
    !isRecord(connection) ||
    typeof connection.enabled !== "boolean" ||
    (connection.authenticatable !== undefined && typeof connection.authenticatable !== "boolean") ||
    (connection.client_id !== undefined && typeof connection.client_id !== "string")
  )
    return undefined;
  const clientId = connection.client_id?.trim();
  return {
    enabled: connection.enabled,
    authenticatable: connection.authenticatable ?? true,
    ...(clientId ? { clientId } : {}),
  };
}

function health(config: Record<string, unknown>): GoogleHealth {
  const current = parseConnection(config);
  const blockers: GoogleBlocker[] = [];
  if (!current)
    blockers.push({
      code: "google-config-invalid",
      message:
        "The existing Google connection configuration could not be interpreted safely. Review it in the Clerk Dashboard before continuing.",
    });
  if (current?.enabled && !current.authenticatable)
    blockers.push({
      code: "google-authenticatable-conflict",
      message:
        "Google is enabled but intentionally unavailable for authentication. clerk init will not override that policy automatically.",
    });
  const credentials = current?.clientId ? "satisfied" : "required";
  return {
    status: blockers.length
      ? "blocked"
      : current?.enabled && current.authenticatable && credentials === "satisfied"
        ? "satisfied"
        : "required",
    credentials,
    ...(current ? { current } : {}),
    blockers,
  };
}

/** Reads the Google connection without a spinner, prompt, or mutation. */
export async function auditGoogleHealth(
  target: GoogleTarget,
  api: Pick<GoogleAPI, "fetchInstanceConfig"> = defaultAPI,
): Promise<GoogleHealth> {
  return health(
    await api.fetchInstanceConfig(target.applicationId, target.instanceId, [GOOGLE_CONNECTION_KEY]),
  );
}

export async function auditGoogleConnection(
  target: GoogleTarget,
  api: GoogleAPI = defaultAPI,
): Promise<GooglePlan> {
  const [config, schema] = await withSpinner(
    "Auditing Clerk Sign in with Google settings...",
    async () =>
      Promise.all([
        api.fetchInstanceConfig(target.applicationId, target.instanceId, [GOOGLE_CONNECTION_KEY]),
        api.fetchInstanceConfigSchema(target.applicationId, target.instanceId, [
          GOOGLE_CONNECTION_KEY,
        ]),
      ]),
  );
  const current = health(config);
  const blockers = [...current.blockers];
  const configVersion =
    typeof config.config_version === "string" && CONFIG_VERSION_PATTERN.test(config.config_version)
      ? config.config_version
      : undefined;
  // Only a needed change depends on the patch schema and the If-Match version.
  if (current.status === "required") {
    const properties = schema.properties?.[GOOGLE_CONNECTION_KEY]?.properties;
    if (
      properties?.enabled?.type !== "boolean" ||
      properties.authenticatable?.type !== "boolean" ||
      properties.client_id?.type !== "string" ||
      properties.client_secret?.type !== "string"
    )
      blockers.push({
        code: "google-config-unsupported",
        message:
          "This Clerk instance does not expose the Google connection settings needed for automatic setup. Review the Google connection in the Clerk Dashboard.",
      });
    if (!configVersion)
      blockers.push({
        code: "google-config-version-unavailable",
        message:
          "Clerk did not return the configuration version needed to protect this change. Review the Google connection in the Clerk Dashboard.",
      });
  }
  const status = blockers.length
    ? "blocked"
    : current.status === "satisfied"
      ? "satisfied"
      : "ready";
  const actions: string[] = [];
  if (status === "ready") {
    if (!current.current?.enabled || !current.current.authenticatable)
      actions.push("Enable Google for authentication");
    if (current.credentials === "required")
      actions.push(
        "Set the Google Web client ID and secret as the connection's custom credentials; preserve every other field.",
      );
  }
  return {
    ...target,
    ...current,
    status,
    ...(configVersion ? { configVersion } : {}),
    blockers,
    actions,
  };
}

/** Checks a PATCH projection: every other field survives the merge, and the owned ones took. */
function checkProjection(
  response: Record<string, unknown>,
  expectedClientId: string,
  dryRun: boolean,
): void {
  const before = isRecord(response.before) ? response.before[GOOGLE_CONNECTION_KEY] : undefined;
  const after = isRecord(response.after) ? response.after[GOOGLE_CONNECTION_KEY] : undefined;
  const parsed = parseConnection(response.after);
  if (
    response.dry_run !== dryRun ||
    !isRecord(before) ||
    !isRecord(after) ||
    Object.entries(before).some(
      ([key, value]) =>
        !Object.hasOwn(after, key) ||
        (!NATIVE_GOOGLE_FIELDS.has(key) && !isDeepStrictEqual(after[key], value)),
    ) ||
    !parsed?.enabled ||
    !parsed.authenticatable ||
    parsed.clientId !== expectedClientId
  )
    throw new CliError(
      "Clerk's Google configuration response did not match the approved change. No further Google changes were made.",
      { code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE },
    );
}

/**
 * Enables Google for authentication and, when the connection has no custom Web client yet, sets
 * the supplied credentials: a dry run proves the server's merge keeps every other field, then the
 * same `If-Match` write lands, then a final read verifies. A connection that already has a Web
 * client keeps it; the credentials are then ignored.
 */
export async function applyGoogleConnection(
  plan: GooglePlan,
  credentials: GoogleCredentials | undefined,
  options: {
    api?: GoogleAPI;
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
    throw setupError(
      "The approved Sign in with Google plan can't be applied; rerun clerk init to review it.",
      true,
    );
  const needsCredentials = plan.credentials === "required";
  if (needsCredentials && !credentials)
    throw setupError(
      "Sign in with Google needs the Google Web client ID and secret; pass --google-client-id and --google-client-secret-file, or rerun clerk init at a terminal.",
    );
  const expectedClientId = needsCredentials ? credentials!.clientId : plan.current!.clientId!;
  const patch = {
    [GOOGLE_CONNECTION_KEY]: {
      enabled: true,
      authenticatable: true,
      ...(needsCredentials
        ? { client_id: credentials!.clientId, client_secret: credentials!.clientSecret }
        : {}),
    },
  };
  const send = async (dryRun: boolean) =>
    api.patchInstanceConfig(plan.applicationId, plan.instanceId, patch, { dryRun, ifMatch });

  const preview = await withSpinner("Validating the Sign in with Google change...", async () =>
    send(true),
  );
  checkProjection(preview, expectedClientId, true);
  await revalidateLocalPreconditions?.();
  const written = await withSpinner("Enabling Sign in with Google in Clerk...", async () =>
    send(false),
  );
  checkProjection(written, expectedClientId, false);

  const verified = await auditGoogleConnection(plan, api);
  if (verified.status !== "satisfied" || verified.current?.clientId !== expectedClientId)
    throw new CliError(
      "Sign in with Google did not pass final verification. Rerun clerk init to reconcile it.",
      { code: ERROR_CODE.ANDROID_REMOTE_VERIFY_FAILED },
    );
}

/** The Clerk OAuth callback a Web client must list as an authorized redirect URI. */
export function googleRedirectUri(frontendHost: string): string {
  return `https://${frontendHost}/v1/oauth_callback`;
}

/**
 * What only the user can do in Google Cloud, with the values this project needs. Neither Clerk
 * nor the CLI can create these clients, and nothing can verify the Android one from here.
 */
export function googleCloudSteps(input: {
  packageName: string;
  sha1?: string;
  frontendHost?: string;
}): string[] {
  return [
    "In Google Cloud Console (APIs & Services > Credentials), choose a project and configure its OAuth consent screen if asked; its app name is what users see.",
    `Create an OAuth client ID of type Android with package name ${input.packageName} and SHA-1 certificate fingerprint ${input.sha1 ?? "<SHA-1 of your signing certificate, from ./gradlew signingReport or keytool -list -v>"}. Add one Android client per signing certificate (debug, release, Play App Signing).`,
    `In the same project, create an OAuth client ID of type Web application${input.frontendHost ? ` with ${googleRedirectUri(input.frontendHost)} as an authorized redirect URI` : ""}, and keep its Client ID and Client secret.`,
    `Give clerk init the Web client's ID and secret (--google-client-id and --google-client-secret-file, or the prompts); Clerk serves it to the Android SDK as the One Tap client ID. Guide: ${GOOGLE_GUIDE}`,
  ];
}

import * as plapi from "../../../lib/plapi.ts";
import { CliError, ERROR_CODE, throwUsageError } from "../../../lib/errors.ts";
import {
  idempotencyKey,
  registerNativeApplication,
  resolveInstance as resolveNativeInstance,
  type InstanceContext,
  type InstanceEnvironment,
} from "../native/remote.ts";
import { PACKAGE_NAME } from "./gradle.ts";
import { missingFingerprintsMessage, normalizeFingerprints } from "./identity.ts";
import { setupError } from "./types.ts";

export type NativeAPI = Pick<
  typeof plapi,
  | "fetchApplication"
  | "getNativeSettings"
  | "listAndroidApplications"
  | "createAndroidApplication"
  | "enableNativeApi"
>;
export const nativeAPI: NativeAPI = plapi;

export interface RemoteInput {
  applicationId: string;
  instanceId?: string;
  /** The installed applicationId. */
  packageName: string;
  /** Normalized SHA-256 fingerprints the registration must carry. */
  fingerprints: string[];
}
export type RemoteContext = Omit<RemoteInput, "instanceId"> & InstanceContext;
type RemoteAction = "register-application" | "enable-native-api";
export interface RemotePlan {
  context: RemoteContext;
  actions: RemoteAction[];
  /** The existing registration, when there is one. */
  registration?: plapi.AndroidApplication;
}

export async function resolveInstance(
  input: Pick<RemoteInput, "applicationId" | "instanceId">,
  api: NativeAPI,
  environment: InstanceEnvironment = "development",
): Promise<InstanceContext> {
  return resolveNativeInstance(input, api, environment, setupError);
}

async function resolveRemote(input: RemoteInput, api: NativeAPI): Promise<RemoteContext> {
  if (!input.applicationId || !PACKAGE_NAME.test(input.packageName))
    throwUsageError("Select a Clerk application and confirm the installed applicationId.");
  return { ...input, ...(await resolveInstance(input, api)) };
}

/**
 * The registration for this package, when there is one. Clerk matches package names exactly.
 * A registration without every known fingerprint is a stop: there is no update endpoint yet.
 */
export function matchingRegistration(
  context: RemoteInput,
  registrations: plapi.AndroidApplication[],
): plapi.AndroidApplication | undefined {
  const matches = registrations.filter((app) => app.package_name === context.packageName);
  if (matches.length > 1)
    throw setupError(
      `Clerk has ${matches.length} registrations for ${context.packageName}; review them on the Native Applications page.`,
    );
  const match = matches[0];
  if (!match) return undefined;
  if (match.namespace !== "android_app")
    throw setupError(
      `Clerk registers ${context.packageName} with namespace "${match.namespace}" instead of "android_app"; review it on the Native Applications page.`,
    );
  const registered = normalizeFingerprints(match.fingerprints);
  const missing = context.fingerprints.filter((fingerprint) => !registered.includes(fingerprint));
  if (missing.length)
    throw setupError(missingFingerprintsMessage(context.packageName, missing, registered));
  return match;
}

/** What the instance still needs for this identity, from settings already read. Throws when registrations conflict. */
export function remoteActions(
  context: RemoteInput,
  nativeEnabled: boolean,
  registrations: plapi.AndroidApplication[],
): { actions: RemoteAction[]; registration?: plapi.AndroidApplication } {
  const actions: RemoteAction[] = [];
  const registration = matchingRegistration(context, registrations);
  if (!registration) actions.push("register-application");
  if (!nativeEnabled) actions.push("enable-native-api");
  return { actions, registration };
}

export async function auditRemote(context: RemoteContext, api: NativeAPI): Promise<RemotePlan> {
  const [native, registrations] = await Promise.all([
    api.getNativeSettings(context.applicationId, context.instanceId),
    api.listAndroidApplications(context.applicationId, context.instanceId),
  ]);
  return { context, ...remoteActions(context, native.api_enabled, registrations) };
}

export async function revalidateRemote(plan: RemotePlan, api: NativeAPI): Promise<RemotePlan> {
  const context = await resolveRemote(plan.context, api);
  if (context.publishableKey !== plan.context.publishableKey)
    throw setupError("The instance key changed; review a fresh setup plan.", true);
  const current = await auditRemote(context, api);
  if (current.actions.some((action) => !plan.actions.includes(action)))
    throw setupError("Remote setup now requires an additional action; review a fresh plan.", true);
  return current;
}

export async function applyRemote(
  plan: RemotePlan,
  api: NativeAPI,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const { context, actions } = await revalidateRemote(plan, api);
  if (actions.includes("register-application")) {
    if (!context.fingerprints.length)
      throw setupError(
        "A registration needs at least one signing certificate fingerprint; pass --android-fingerprint.",
      );
    const params = {
      namespace: "android_app" as const,
      package_name: context.packageName,
      fingerprints: context.fingerprints,
    };
    await registerNativeApplication({
      create: async () =>
        api.createAndroidApplication(
          context.applicationId,
          context.instanceId,
          params,
          idempotencyKey("android-init", [context.applicationId, context.instanceId, params]),
        ),
      list: async () => api.listAndroidApplications(context.applicationId, context.instanceId),
      matching: (registrations) => matchingRegistration(context, registrations),
      mismatch: () =>
        new CliError("Clerk did not confirm the requested native identity; retry setup.", {
          code: ERROR_CODE.ANDROID_REMOTE_VERIFY_FAILED,
        }),
    });
  }
  signal?.throwIfAborted();
  // Enable the instance-wide API only once the registration exists.
  if (actions.includes("enable-native-api"))
    await api.enableNativeApi(context.applicationId, context.instanceId);
  signal?.throwIfAborted();
  if ((await auditRemote(context, api)).actions.length)
    throw new CliError("Remote setup is not yet verified; retry setup to reconcile it.", {
      code: ERROR_CODE.ANDROID_REMOTE_VERIFY_FAILED,
    });
}

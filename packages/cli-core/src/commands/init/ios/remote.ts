import * as plapi from "../../../lib/plapi.ts";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import {
  cliStateIOSNativeRegistrationRetryStore,
  type IOSNativeRegistrationRetryStore,
} from "./native-registration-retry.ts";

export type NativeAPI = Pick<
  typeof plapi,
  | "fetchApplication"
  | "getNativeSettings"
  | "listIOSApplications"
  | "createIOSApplication"
  | "enableNativeApi"
>;
export const nativeAPI: NativeAPI = plapi;
export interface RemoteInput {
  applicationId: string;
  instanceId?: string;
  // Concrete identity, discovered from ordinary Xcode settings / Clerk or confirmed by the caller.
  bundleIdentifier: string;
  appIdPrefix: string;
}
export interface RemoteContext extends RemoteInput {
  instanceId: string;
  publishableKey: string;
  frontendHost: string;
}
export type RemoteAction = "register-application" | "enable-native-api";
export interface RemotePlan {
  context: RemoteContext;
  actions: RemoteAction[];
}

export async function resolveRemote(input: RemoteInput, api: NativeAPI): Promise<RemoteContext> {
  if (
    !input.applicationId ||
    !/^[A-Z0-9]{10}$/.test(input.appIdPrefix) ||
    input.bundleIdentifier.length > 255 ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(input.bundleIdentifier)
  ) {
    throw new Error(
      "Select a Clerk application and confirm the final Bundle ID and ten-character App ID Prefix.",
    );
  }
  return { ...input, ...(await resolveInstance(input, api)) };
}

export async function resolveInstance(
  input: Pick<RemoteInput, "applicationId" | "instanceId">,
  api: NativeAPI,
) {
  const application = await api.fetchApplication(input.applicationId, { includeSecretKeys: false });
  if (application.application_id !== input.applicationId)
    throw new Error("Clerk returned a different application; review the linked account.");
  const instances = application.instances.filter(
    (instance) =>
      instance.environment_type === "development" &&
      (!input.instanceId || instance.instance_id === input.instanceId),
  );
  if (instances.length !== 1 || !instances[0]!.instance_id)
    throw new Error("Select exactly one development instance for native setup.");
  const instance = instances[0]!;
  const decoded = decodePublishableKey(instance.publishable_key);
  if (decoded.instanceType !== "development")
    throw new Error("Native setup requires a development publishable key.");
  return {
    applicationId: input.applicationId,
    instanceId: instance.instance_id,
    publishableKey: instance.publishable_key,
    frontendHost: decoded.fapiHost,
  };
}

function matchingApplication(
  context: RemoteContext,
  value: unknown,
): plapi.IOSApplication | undefined {
  const matches = plapi
    .validateIOSApplications(value)
    .filter((app) => app.bundle_id.toLowerCase() === context.bundleIdentifier.toLowerCase());
  if (
    matches.length > 1 ||
    matches.some((app) => app.app_id_prefix !== context.appIdPrefix || !app.id)
  ) {
    throw new Error(
      "Existing native registrations conflict with this identity; review them in the Dashboard.",
    );
  }
  return matches[0];
}

export async function auditRemote(context: RemoteContext, api: NativeAPI): Promise<RemotePlan> {
  const [native, applications] = await Promise.all([
    api.getNativeSettings(context.applicationId, context.instanceId),
    api.listIOSApplications(context.applicationId, context.instanceId),
  ]);
  const actions: RemoteAction[] = [];
  if (!matchingApplication(context, applications)) actions.push("register-application");
  if (!plapi.validateNativeSettings(native).api_enabled) actions.push("enable-native-api");
  return { context, actions };
}

export async function revalidateRemote(plan: RemotePlan, api: NativeAPI): Promise<RemotePlan> {
  const context = await resolveRemote(plan.context, api);
  if (context.publishableKey !== plan.context.publishableKey)
    throw new Error("The instance key changed; review a fresh setup plan.");
  const current = await auditRemote(context, api);
  if (current.actions.some((action) => !plan.actions.includes(action)))
    throw new Error("Remote setup now requires an additional action; review a fresh plan.");
  return current;
}

export async function applyRemote(
  plan: RemotePlan,
  api: NativeAPI,
  retry: IOSNativeRegistrationRetryStore = cliStateIOSNativeRegistrationRetryStore,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const { context, actions } = await revalidateRemote(plan, api);
  let key = actions.length ? await retry.getOrCreate(context) : await retry.peek(context);
  signal?.throwIfAborted();
  if (actions.includes("register-application")) {
    const created = plapi.validateIOSApplication(
      await api.createIOSApplication(
        context.applicationId,
        context.instanceId,
        {
          appIdPrefix: context.appIdPrefix,
          bundleId: context.bundleIdentifier,
        },
        { idempotencyKey: key! },
      ),
    );
    if (!matchingApplication(context, [created]))
      throw new Error(
        "Clerk did not confirm the requested native identity; retry setup to reconcile it.",
      );
  }
  signal?.throwIfAborted();
  // Registration must be observable before enabling the instance-wide API.
  const registered = await auditRemote(context, api);
  if (registered.actions.includes("register-application"))
    throw new Error("Native registration is not yet observable; retry setup.");
  if (registered.actions.includes("enable-native-api")) {
    if (!plan.actions.includes("enable-native-api"))
      throw new Error("Enabling Native API now requires a fresh preview.");
    key ??= await retry.getOrCreate(context);
    signal?.throwIfAborted();
    plapi.validateNativeSettings(
      await api.enableNativeApi(context.applicationId, context.instanceId, {
        idempotencyKey: key!,
      }),
    );
  }
  signal?.throwIfAborted();
  if ((await auditRemote(context, api)).actions.length)
    throw new Error("Remote setup is not yet verified; retry setup to reconcile it.");
  if (key) await retry.clear(context, key);
}

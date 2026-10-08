import { createHash } from "node:crypto";
import * as plapi from "../../../lib/plapi.ts";
import { bundleIdentifiersEqual } from "../../../lib/apple-native-identity.ts";
import {
  ApiError,
  CliError,
  ERROR_CODE,
  PlapiError,
  throwUsageError,
} from "../../../lib/errors.ts";
import { decodePublishableKey } from "../../../lib/fapi.ts";

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
interface RemoteContext extends RemoteInput {
  instanceId: string;
  publishableKey: string;
  frontendHost: string;
}
type RemoteAction = "register-application" | "enable-native-api";
export interface RemotePlan {
  context: RemoteContext;
  actions: RemoteAction[];
}

async function resolveRemote(input: RemoteInput, api: NativeAPI): Promise<RemoteContext> {
  if (
    !input.applicationId ||
    !/^[A-Z0-9]{10}$/.test(input.appIdPrefix) ||
    input.bundleIdentifier.length > 255 ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(input.bundleIdentifier)
  ) {
    throwUsageError(
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
    throw new CliError("Clerk returned a different application; review the linked account.", {
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });
  const instances = application.instances.filter(
    (instance) =>
      instance.environment_type === "development" &&
      (!input.instanceId || instance.instance_id === input.instanceId),
  );
  if (instances.length !== 1 || !instances[0]!.instance_id)
    throw new CliError("Select exactly one development instance for native setup.", {
      code: ERROR_CODE.IOS_SETUP_BLOCKED,
    });
  const instance = instances[0]!;
  const decoded = decodePublishableKey(instance.publishable_key);
  if (decoded.instanceType !== "development")
    throw new CliError("Native setup requires a development publishable key.", {
      code: ERROR_CODE.IOS_SETUP_BLOCKED,
    });
  return {
    applicationId: input.applicationId,
    instanceId: instance.instance_id,
    publishableKey: instance.publishable_key,
    frontendHost: decoded.fapiHost,
  };
}

function matchingApplication(
  context: RemoteContext,
  applications: plapi.IOSApplication[],
): plapi.IOSApplication | undefined {
  const matches = applications.filter((app) =>
    bundleIdentifiersEqual(app.bundle_id, context.bundleIdentifier),
  );
  if (matches.length > 1 || matches.some((app) => app.app_id_prefix !== context.appIdPrefix)) {
    throw new CliError(
      "Existing native registrations conflict with this identity; review them in the Dashboard.",
      { code: ERROR_CODE.IOS_SETUP_BLOCKED },
    );
  }
  const match = matches[0];
  if (match && match.bundle_id !== context.bundleIdentifier) {
    throw new CliError(
      `Bundle ID "${context.bundleIdentifier}" differs in capitalization from Clerk registration "${match.bundle_id}". Match the spelling in Xcode and Clerk, then retry setup.`,
      { code: ERROR_CODE.IOS_SETUP_BLOCKED },
    );
  }
  return match;
}

export async function auditRemote(context: RemoteContext, api: NativeAPI): Promise<RemotePlan> {
  const [native, applications] = await Promise.all([
    api.getNativeSettings(context.applicationId, context.instanceId),
    api.listIOSApplications(context.applicationId, context.instanceId),
  ]);
  const actions: RemoteAction[] = [];
  if (!matchingApplication(context, applications)) actions.push("register-application");
  if (!native.api_enabled) actions.push("enable-native-api");
  return { context, actions };
}

export async function revalidateRemote(plan: RemotePlan, api: NativeAPI): Promise<RemotePlan> {
  const context = await resolveRemote(plan.context, api);
  if (context.publishableKey !== plan.context.publishableKey)
    throw new CliError("The instance key changed; review a fresh setup plan.", {
      code: ERROR_CODE.IOS_SETUP_STALE,
    });
  const current = await auditRemote(context, api);
  if (current.actions.some((action) => !plan.actions.includes(action)))
    throw new CliError("Remote setup now requires an additional action; review a fresh plan.", {
      code: ERROR_CODE.IOS_SETUP_STALE,
    });
  return current;
}

/** A request whose connection failed: Node's fetch throws TypeError, Bun's an Error with a string code such as ECONNRESET. */
function lostConnection(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof Error &&
    !(error instanceof CliError) &&
    !(error instanceof ApiError) &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

export async function applyRemote(
  plan: RemotePlan,
  api: NativeAPI,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const { context, actions } = await revalidateRemote(plan, api);
  if (actions.includes("register-application")) {
    const params = { app_id_prefix: context.appIdPrefix, bundle_id: context.bundleIdentifier };
    // Deterministic, so a rerun within the server's idempotency window replays
    // the original response instead of creating a second registration.
    const key = createHash("sha256")
      .update(JSON.stringify([context.applicationId, context.instanceId, params]))
      .digest("hex");
    try {
      const created = await api.createIOSApplication(
        context.applicationId,
        context.instanceId,
        params,
        `ios-init-${key}`,
      );
      if (!matchingApplication(context, [created]))
        throw new CliError("Clerk did not confirm the requested native identity; retry setup.", {
          code: ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
        });
    } catch (error) {
      // A concurrent creator or a lost successful response can leave the row in
      // place. Reconcile it; never create a second registration.
      if (
        !lostConnection(error) &&
        !(error instanceof PlapiError && (error.status === 422 || error.status >= 500))
      )
        throw error;
      // If the re-read fails too, report the create failure, which says why.
      const current = await api
        .listIOSApplications(context.applicationId, context.instanceId)
        .catch(() => {
          throw error;
        });
      if (!matchingApplication(context, current)) throw error;
    }
  }
  signal?.throwIfAborted();
  // Enable the instance-wide API only once the registration exists.
  if (actions.includes("enable-native-api"))
    await api.enableNativeApi(context.applicationId, context.instanceId);
  signal?.throwIfAborted();
  if ((await auditRemote(context, api)).actions.length)
    throw new CliError("Remote setup is not yet verified; retry setup to reconcile it.", {
      code: ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
    });
}

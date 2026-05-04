import { fetchAppsTolerantly, pickOrCreateApp } from "../../../lib/app-picker.ts";
import {
  resolveAppContext,
  resolveFetchedApplicationInstance,
  resolveProfile,
} from "../../../lib/config.ts";
import {
  BapiError,
  CliError,
  ERROR_CODE,
  throwUsageError,
  withApiContext,
} from "../../../lib/errors.ts";
import { getBapiBaseUrl } from "../../../lib/environment.ts";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import { loggedFetch } from "../../../lib/fetch.ts";
import { fetchApplication, validateKeyPrefix } from "../../../lib/plapi.ts";
import { isHuman } from "../../../mode.ts";

export type UsersInstanceContext = {
  secretKey: string;
  appId?: string;
  appLabel?: string;
  instanceId?: string;
  instanceLabel?: string;
  publishableKey?: string;
  fapiHost?: string;
};

export type ResolveUsersInstanceContextOptions = {
  app?: string;
  instance?: string;
  secretKey?: string;
};

type CurrentBapiInstance = {
  id: string;
  publishableKey?: string;
  instanceLabel: string;
  fapiHost?: string;
};

async function fetchCurrentBapiInstance(secretKey: string): Promise<CurrentBapiInstance> {
  const url = new URL("/v1/instance", getBapiBaseUrl());
  const response = await loggedFetch(url, {
    tag: "bapi",
    method: "GET",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      Accept: "application/json",
    },
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new BapiError(response.status, rawBody, response.headers);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new CliError("BAPI returned non-JSON response from /v1/instance.");
  }

  const instance = body as { id?: unknown; publishable_key?: unknown };
  if (typeof instance.id !== "string" || instance.id.length === 0) {
    throw new CliError("BAPI /v1/instance response did not include an instance id.");
  }

  let instanceLabel = secretKey.startsWith("sk_live_") ? "production" : "development";
  let publishableKey: string | undefined;
  let fapiHost: string | undefined;
  if (typeof instance.publishable_key === "string" && instance.publishable_key.length > 0) {
    publishableKey = instance.publishable_key;
    try {
      const decoded = decodePublishableKey(instance.publishable_key);
      instanceLabel = decoded.instanceType;
      fapiHost = decoded.fapiHost;
    } catch {
      // Fall back to the secret-key prefix when the publishable key is malformed.
    }
  }

  return {
    id: instance.id,
    publishableKey,
    instanceLabel,
    fapiHost,
  };
}

async function resolveExplicitAppLabel(appId: string): Promise<string> {
  const resolved = await resolveProfile(process.cwd());
  if (resolved?.profile.appId === appId) {
    return resolved.profile.appName || appId;
  }
  return appId;
}

function validateSecretKeyInstanceTarget(
  instanceFlag: string | undefined,
  current: CurrentBapiInstance,
): void {
  if (!instanceFlag) return;

  if (instanceFlag === current.id || instanceFlag === current.instanceLabel) {
    return;
  }

  throwUsageError(
    `--instance ${instanceFlag} does not match the supplied --secret-key target (${current.instanceLabel}, ${current.id}).`,
  );
}

export async function resolveUsersInstanceContext(
  options: ResolveUsersInstanceContextOptions,
): Promise<UsersInstanceContext> {
  if (options.secretKey) {
    validateKeyPrefix(options.secretKey, "sk_");
    if (!options.app && !options.instance) {
      return { secretKey: options.secretKey };
    }

    const current = await fetchCurrentBapiInstance(options.secretKey);
    validateSecretKeyInstanceTarget(options.instance, current);

    const ctx: UsersInstanceContext = {
      secretKey: options.secretKey,
      appId: options.app,
      appLabel: options.app ? await resolveExplicitAppLabel(options.app) : undefined,
      instanceId: current.id,
      instanceLabel: current.instanceLabel,
      publishableKey: current.publishableKey,
      fapiHost: current.fapiHost,
    };
    return ctx;
  }

  let appId: string | undefined = options.app;
  let instanceHint: string | undefined = options.instance;

  if (!appId) {
    try {
      const ctx = await resolveAppContext({ instance: options.instance });
      appId = ctx.appId;
      instanceHint = ctx.instanceId;
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== ERROR_CODE.NOT_LINKED) {
        throw error;
      }
      if (isHuman()) {
        const apps = await fetchAppsTolerantly();
        const picked = await pickOrCreateApp({
          apps,
          message: "Select a Clerk application to use:",
        });
        appId = picked.application_id;
      } else {
        throw error;
      }
    }
  }

  const app = await withApiContext(fetchApplication(appId), "Failed to resolve instance context");
  const resolved = resolveFetchedApplicationInstance(appId, app, instanceHint);
  if (!resolved.found) {
    throw new CliError(`Instance ${resolved.instanceId} not found in application.`, {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }
  const instance = resolved.instance;
  if (!instance.secret_key) {
    throw new CliError(`No secret key found for ${resolved.instanceLabel} instance.`, {
      code: ERROR_CODE.NO_SECRET_KEY,
    });
  }

  const ctx: UsersInstanceContext = {
    secretKey: instance.secret_key,
    appId,
    appLabel: app.name || appId,
    instanceId: resolved.instanceId,
    instanceLabel: resolved.instanceLabel,
  };
  if (instance.publishable_key) {
    ctx.publishableKey = instance.publishable_key;
    try {
      ctx.fapiHost = decodePublishableKey(instance.publishable_key).fapiHost;
    } catch {
      // Leave fapiHost undefined if the publishable key is malformed.
    }
  }
  return ctx;
}

/**
 * The Clerk instance a migrate command acts on, and where its key came from.
 *
 * `resolveBapiSecretKey` picks the key. This names what that key points at:
 * the instance ID and environment come from `GET /v1/instance`, so every key
 * source yields the same identity. That identity is what the run store keys
 * resumes and undos on, so an app label or an `--instance` alias is never
 * enough on its own.
 */

import { createHash } from "node:crypto";
import { bapiRequest } from "../../../lib/bapi.ts";
import { dim } from "../../../lib/color.ts";
import { resolveBapiSecretKey } from "../../../lib/bapi-command.ts";
import { resolveAppContext } from "../../../lib/config.ts";
import { resolveKeylessTarget } from "../../../lib/keyless-target.ts";
import { log } from "../../../lib/log.ts";
import { detectInstanceType } from "./instance.ts";
import type { RunTarget } from "./run-store.ts";

export type TargetOptions = {
  secretKey?: string;
  app?: string;
  instance?: string;
};

/** A resolved Clerk instance. Every field a run needs is present. */
export type ClerkTarget = RunTarget & {
  env: string;
  instanceId: string;
  instanceType: "dev" | "prod";
  keySource: string;
};

/**
 * Which rung of `resolveBapiSecretKey`'s chain supplies the key, and the app
 * it belongs to when that rung knows one.
 *
 * Mirrors the chain's order exactly. An exported `CLERK_SECRET_KEY` wins over
 * a linked profile, so the profile's app is not named for it: that key may
 * belong to any app at all.
 */
async function describeKeySource(
  options: TargetOptions,
): Promise<{ keySource: string; appId?: string; appLabel?: string }> {
  if (options.secretKey) return { keySource: "--secret-key" };

  if (options.app) {
    const ctx = await resolveAppContext({ app: options.app, instance: options.instance });
    return { keySource: "--app", appId: ctx.appId, appLabel: ctx.appLabel };
  }

  if (process.env.CLERK_SECRET_KEY) return { keySource: "CLERK_SECRET_KEY env var" };

  const keyless = await resolveKeylessTarget({ instance: options.instance });
  if (keyless) {
    return { keySource: `accountless app (${keyless.source})`, appLabel: "accountless app" };
  }

  const ctx = await resolveAppContext({ instance: options.instance });
  return { keySource: "linked profile", appId: ctx.appId, appLabel: ctx.appLabel };
}

/**
 * The instance behind a key.
 *
 * Falls back to a hash of the key when `GET /v1/instance` cannot be read: the
 * same key always addresses the same instance, so it still tells two
 * instances apart, and nothing is sent anywhere.
 */
async function fetchInstanceIdentity(
  secretKey: string,
): Promise<{ instanceId: string; env: string }> {
  const fallbackEnv = detectInstanceType(secretKey) === "prod" ? "production" : "development";
  try {
    const { body } = await bapiRequest({ method: "GET", path: "/v1/instance", secretKey });
    const instance = body as { id?: unknown; environment_type?: unknown };
    if (typeof instance.id === "string" && instance.id.startsWith("ins_")) {
      return {
        instanceId: instance.id,
        env:
          typeof instance.environment_type === "string" ? instance.environment_type : fallbackEnv,
      };
    }
  } catch (error) {
    log.debug(`migrate: could not read the instance behind the key: ${String(error)}`);
  }
  const digest = createHash("sha256").update(secretKey).digest("hex").slice(0, 16);
  return { instanceId: `key_${digest}`, env: fallbackEnv };
}

/** Resolves the key, then names the instance it addresses. */
export async function resolveClerkTarget(
  options: TargetOptions,
): Promise<{ secretKey: string; target: ClerkTarget }> {
  const secretKey = await resolveBapiSecretKey(options);
  const source = await describeKeySource(options);
  const { instanceId, env } = await fetchInstanceIdentity(secretKey);

  return {
    secretKey,
    target: {
      env,
      instanceId,
      instanceType: detectInstanceType(secretKey),
      ...source,
    },
  };
}

/** One line naming a target, for prose: `My App (development, ins_123)`. */
export function describeTarget(target: RunTarget): string {
  if (target.platform && !target.instanceId) return target.platform;
  const where = [target.env, target.instanceId].filter(Boolean).join(", ");
  const name = target.appLabel ?? (target.platform ? `${target.platform}` : "instance");
  return where ? `${name} (${where})` : name;
}

/** The header every command that acts on an instance prints first. */
export function printTarget(target: RunTarget): void {
  log.info(`Target: ${describeTarget(target)}`);
  if (target.keySource) log.info(dim(`Key from: ${target.keySource}`));
}

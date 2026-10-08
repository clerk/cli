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
import { INSTANCE_ALIASES, resolveAppContext } from "../../../lib/config.ts";
import { throwUsageError } from "../../../lib/errors.ts";
import { resolveKeylessTarget } from "../../../lib/keyless-target.ts";
import { log } from "../../../lib/log.ts";
import { isHuman } from "../../../mode.ts";
import { detectInstanceType } from "./instance.ts";
import { retryOn429 } from "./retry.ts";
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

  // Only the SDK's own file says the app is accountless: a key in `.env`
  // may belong to any app, an account's included.
  const keyless = await resolveKeylessTarget({ instance: options.instance });
  if (keyless) {
    return keyless.source === ".clerk/.tmp/keyless.json"
      ? { keySource: `accountless app (${keyless.source})`, appLabel: "accountless app" }
      : { keySource: keyless.source };
  }

  const ctx = await resolveAppContext({ instance: options.instance });
  return { keySource: "linked profile", appId: ctx.appId, appLabel: ctx.appLabel };
}

/**
 * The instance behind a key.
 *
 * Falls back to a hash of the key when `GET /v1/instance` cannot be read: the
 * same key always addresses the same instance, so it still tells two
 * instances apart, and nothing is sent anywhere. A 429 is retried first: it is
 * most likely straight after a large import, which is when `undo` runs.
 */
export async function fetchInstanceIdentity(
  secretKey: string,
): Promise<{ instanceId: string; env: string }> {
  const fallbackEnv = detectInstanceType(secretKey) === "prod" ? "production" : "development";
  try {
    const { body } = await retryOn429(async () =>
      bapiRequest({ method: "GET", path: "/v1/instance", secretKey }),
    );
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
  return { instanceId: keyInstanceId(secretKey), env: fallbackEnv };
}

/**
 * The stand-in ID for a key whose instance Clerk did not name: a hash of the
 * key. A run recorded under it is matched by the same key later, once
 * `GET /v1/instance` answers again.
 */
export function keyInstanceId(secretKey: string): string {
  return `key_${createHash("sha256").update(secretKey).digest("hex").slice(0, 16)}`;
}

/**
 * Refuses an `--instance` the key does not address.
 *
 * With a key from `--secret-key` or `CLERK_SECRET_KEY`, the key alone picks
 * the instance and `--instance` would be ignored without a word. Migrate
 * writes and deletes in bulk, so `--instance dev` next to an exported
 * `sk_live_` key must not reach production.
 */
export function assertInstanceFlagMatches(
  options: TargetOptions,
  keySource: string,
  identity: { instanceId: string; env: string },
): void {
  const flag = options.instance;
  if (!flag || (keySource !== "--secret-key" && !keySource.startsWith("CLERK_SECRET_KEY"))) return;
  const wanted = INSTANCE_ALIASES[flag];
  const matches = wanted ? identity.env === wanted : identity.instanceId === flag;
  if (matches) return;
  // A `key_` ID means Clerk did not name the instance, so a literal ID cannot
  // be checked; saying it "does not match" would blame the flag.
  if (!wanted && identity.instanceId.startsWith("key_")) {
    throwUsageError(
      `Could not verify that the key from ${keySource} addresses --instance ${flag}: ` +
        "Clerk did not answer GET /v1/instance. Nothing was changed.\n" +
        "Try again, or pass --instance dev or --instance prod.",
    );
  }
  throwUsageError(
    `--instance ${flag} does not match the key from ${keySource}, which addresses the ` +
      `${identity.env} instance ${identity.instanceId}. Nothing was changed.\n` +
      "Pass the key for that instance with --secret-key, or drop --instance.",
  );
}

/** Resolves the key, then names the instance it addresses. */
export async function resolveClerkTarget(
  options: TargetOptions,
): Promise<{ secretKey: string; target: ClerkTarget }> {
  const secretKey = await resolveBapiSecretKey(options);
  const source = await describeKeySource(options);
  const { instanceId, env } = await fetchInstanceIdentity(secretKey);
  assertInstanceFlagMatches(options, source.keySource, { instanceId, env });

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

/**
 * The header every command prints first: which instance it acts on, and where
 * the key came from. An export names its source platform instead, plus the
 * Clerk instance when that is what it reads.
 *
 * `--json` carries the same facts as `target`, so this is for humans only.
 */
export function printTarget(target: RunTarget): void {
  const heading = target.platform ? "Source" : "Target";
  const instance = target.instanceId
    ? `${target.env ?? "unknown"} instance ${target.instanceId}`
    : undefined;
  const app = target.appLabel
    ? `${target.appLabel}${target.appId ? ` (${target.appId})` : ""}`
    : undefined;
  const platform = target.platform && target.platform !== "clerk" ? target.platform : undefined;
  const parts = [platform ?? (target.platform === "clerk" ? "Clerk" : undefined), app, instance];
  log.info(`${heading}: ${parts.filter(Boolean).join(", ")}`);
  if (target.keySource) {
    // Agents read this without `--json` too; an escape code is noise to them.
    const line = `Key from: ${target.keySource}`;
    log.info(isHuman() ? dim(line) : line);
  }
}

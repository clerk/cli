/**
 * The Clerk instance a migrate command acts on, and where its key came from.
 *
 * `resolveBapiSecretKey` picks the key. This names what that key points at:
 * the instance ID and environment come from `GET /v1/instance`, so every key
 * source yields the same identity. When that call fails, `--app` and a linked
 * profile use the instance the Platform API or the profile names. That
 * identity is what the run store keys resumes and undos on, so an app label or
 * an `--instance` alias is never enough on its own.
 */

import { createHash } from "node:crypto";
import { bapiRequest } from "../../../lib/bapi.ts";
import { dim } from "../../../lib/color.ts";
import { resolveBapiSecretKey } from "../../../lib/bapi-command.ts";
import { INSTANCE_ALIASES, resolveAppContext } from "../../../lib/config.ts";
import { throwUsageError } from "../../../lib/errors.ts";
import {
  ENV_VAR_SOURCE_SUFFIX,
  resolveKeylessTarget,
  SDK_KEYLESS_SOURCE,
} from "../../../lib/keyless-target.ts";
import { log } from "../../../lib/log.ts";
import { isHuman } from "../../../mode.ts";
import { detectInstanceType } from "./instance.ts";
import { retryOn429 } from "./retry.ts";
import { type CarryOptions, carryFlags } from "./carry-flags.ts";
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
 * The key sources a run records by name. A `.env` file or a keyless app is
 * recorded by its file, so those stay plain strings.
 */
export const KEY_SOURCE = {
  secretKeyFlag: "--secret-key",
  app: "--app",
  envVar: `CLERK_SECRET_KEY${ENV_VAR_SOURCE_SUFFIX}`,
  linkedProfile: "linked profile",
} as const;

type NamedKeySource = (typeof KEY_SOURCE)[keyof typeof KEY_SOURCE];

type InstanceIdentity = { instanceId: string; env: string };

type KeySource = {
  keySource: string;
  appId?: string;
  appLabel?: string;
  /** No `env` when the instance was named by ID, which is no environment. */
  instance?: { instanceId: string; env?: string };
};

/** The app and instance `--app` or a linked profile names. */
async function fromAppContext(
  keySource: NamedKeySource,
  options: TargetOptions,
): Promise<KeySource> {
  const ctx = await resolveAppContext(options);
  return {
    keySource,
    appId: ctx.appId,
    appLabel: ctx.appLabel,
    instance: {
      instanceId: ctx.instanceId,
      // A profile labels a literal `--instance ins_…` with the ID itself.
      ...(isClerkInstanceId(ctx.instanceLabel) ? {} : { env: ctx.instanceLabel }),
    },
  };
}

/**
 * Which rung of `resolveBapiSecretKey`'s chain supplies the key, and the app
 * it belongs to when that rung knows one. `--app` and a linked profile also
 * know the instance, from the Platform API or the profile.
 *
 * Mirrors the chain's order exactly. An exported `CLERK_SECRET_KEY` wins over
 * a linked profile, so the profile's app is not named for it: that key may
 * belong to any app at all.
 */
async function describeKeySource(options: TargetOptions): Promise<KeySource> {
  if (options.secretKey) return { keySource: KEY_SOURCE.secretKeyFlag };

  if (options.app) return fromAppContext(KEY_SOURCE.app, options);

  if (process.env.CLERK_SECRET_KEY) return { keySource: KEY_SOURCE.envVar };

  // Only the SDK's own file says the app is accountless: a key in `.env`
  // may belong to any app, an account's included.
  const keyless = await resolveKeylessTarget({ instance: options.instance });
  if (keyless) {
    return keyless.source === SDK_KEYLESS_SOURCE
      ? { keySource: `accountless app (${keyless.source})`, appLabel: "accountless app" }
      : { keySource: keyless.source };
  }

  return fromAppContext(KEY_SOURCE.linkedProfile, options);
}

type TargetCarry = Omit<CarryOptions, "runsDir">;
type CarryFor = (target: RunTarget, instance?: string) => TargetCarry;

// The key again, as a placeholder: the key alone picks the instance, from
// any directory. Not `--instance`: in an unlinked directory with a `.env`,
// the keyless rung refuses it before a profile could resolve it.
const keyAgain: CarryFor = () => ({ secretKey: "<key>" });
// The app and the instance. A profile's own link resolves development, and
// only from a directory linked to that app. Without a real instance, the key:
// a bare `--app` resolves development too.
const appAndInstance: CarryFor = (target, instance) =>
  instance ? { app: target.appId, instance } : keyAgain(target);

/**
 * For each named key source, what reaches a recorded target again. Every
 * name needs an entry, so a new one fails to compile until it says how.
 */
const TARGET_CARRY: Record<NamedKeySource, CarryFor> = {
  [KEY_SOURCE.secretKeyFlag]: keyAgain,
  [KEY_SOURCE.envVar]: keyAgain,
  [KEY_SOURCE.app]: appAndInstance,
  [KEY_SOURCE.linkedProfile]: appAndInstance,
};

function isNamedKeySource(source: string | undefined): source is NamedKeySource {
  return source !== undefined && Object.hasOwn(TARGET_CARRY, source);
}

/**
 * The flags a command meant for later needs to reach a run's target and runs
 * folder again: `runs <id>`'s, and an import's or undo's own next steps. The
 * instance goes by ID, not alias (a staging one has none), and only a real
 * one: no `--instance` resolves a stand-in. A framework's own key variable,
 * exported like `CLERK_SECRET_KEY`, gets the key again. A key file (`.env`, a
 * keyless app's) gets nothing: it refuses `--instance`, and run from the same
 * project it names the key itself.
 */
export function laterCarry(runsDir: string | undefined, target: RunTarget): string[] {
  const instance = isClerkInstanceId(target.instanceId) ? target.instanceId : undefined;
  const carry = isNamedKeySource(target.keySource)
    ? TARGET_CARRY[target.keySource](target, instance)
    : target.keySource?.endsWith(ENV_VAR_SOURCE_SUFFIX)
      ? keyAgain(target, instance)
      : {};
  return carryFlags({ runsDir, ...carry });
}

/**
 * The instance behind a key.
 *
 * Falls back to a hash of the key when `GET /v1/instance` cannot be read: the
 * same key always addresses the same instance, so it still tells two
 * instances apart, and nothing is sent anywhere. A 429 is retried first: it is
 * most likely straight after a large import, which is when `undo` runs.
 */
export async function fetchInstanceIdentity(secretKey: string): Promise<InstanceIdentity> {
  const fallbackEnv = detectInstanceType(secretKey) === "prod" ? "production" : "development";
  try {
    const { body } = await retryOn429(async () =>
      bapiRequest({ method: "GET", path: "/v1/instance", secretKey }),
    );
    const instance = body as { id?: unknown; environment_type?: unknown };
    if (typeof instance.id === "string" && isClerkInstanceId(instance.id)) {
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

/** A stand-in for an instance Clerk did not name: {@link keyInstanceId}'s `key_` hash. */
export function isStandInInstanceId(id: string | undefined): boolean {
  return id?.startsWith("key_") === true;
}

/** An instance ID Clerk itself returned. */
export function isClerkInstanceId(id: string | undefined): boolean {
  return id?.startsWith("ins_") === true;
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
  identity: InstanceIdentity,
): void {
  const flag = options.instance;
  if (!flag || (keySource !== KEY_SOURCE.secretKeyFlag && keySource !== KEY_SOURCE.envVar)) return;
  const wanted = INSTANCE_ALIASES[flag];
  const matches = wanted ? identity.env === wanted : identity.instanceId === flag;
  if (matches) return;
  // A `key_` ID means Clerk did not name the instance, so a literal ID cannot
  // be checked; saying it "does not match" would blame the flag.
  if (!wanted && isStandInInstanceId(identity.instanceId)) {
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
  const { instance: named, ...source } = await describeKeySource(options);
  const fetched = await fetchInstanceIdentity(secretKey);
  // The Platform API or the profile already named the instance: recorded
  // instead of a stand-in, a run's commands can reach it with `--instance`.
  // Named by ID, its environment is unknown: the key prefix only guesses it.
  const { instanceId, env } =
    named && isStandInInstanceId(fetched.instanceId) && isClerkInstanceId(named.instanceId)
      ? { instanceId: named.instanceId, env: named.env ?? "unknown" }
      : fetched;
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

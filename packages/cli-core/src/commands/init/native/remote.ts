import { createHash } from "node:crypto";
import type * as plapi from "../../../lib/plapi.ts";
import { ApiError, CliError, ERROR_CODE, PlapiError } from "../../../lib/errors.ts";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import type { SetupErrorFactory } from "./types.ts";

export type InstanceEnvironment = "development" | "production";

/** The Clerk instance a native app is set up against, with its public key and Frontend API host. */
export interface InstanceContext {
  applicationId: string;
  instanceId: string;
  publishableKey: string;
  frontendHost: string;
}

/**
 * Finds the one instance of the linked application in `environment`, and its publishable key.
 * Native setup never reads secret keys. `setupError` names the engine the failure belongs to.
 */
export async function resolveInstance(
  input: { applicationId: string; instanceId?: string },
  api: Pick<typeof plapi, "fetchApplication">,
  environment: InstanceEnvironment,
  setupError: SetupErrorFactory,
): Promise<InstanceContext> {
  const application = await api.fetchApplication(input.applicationId, { includeSecretKeys: false });
  if (application.application_id !== input.applicationId)
    throw new CliError("Clerk returned a different application; review the linked account.", {
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });
  const instances = application.instances.filter(
    (instance) =>
      instance.environment_type === environment &&
      (!input.instanceId || instance.instance_id === input.instanceId),
  );
  if (instances.length !== 1 || !instances[0]!.instance_id)
    throw setupError(`Select exactly one ${environment} instance for native setup.`);
  const instance = instances[0]!;
  const decoded = decodePublishableKey(instance.publishable_key);
  if (decoded.instanceType !== environment)
    throw setupError(`Native setup requires a ${environment} publishable key.`);
  return {
    applicationId: input.applicationId,
    instanceId: instance.instance_id,
    publishableKey: instance.publishable_key,
    frontendHost: decoded.fapiHost,
  };
}

/** A request whose connection failed: Node's fetch throws TypeError, Bun's an Error with a string code such as ECONNRESET. */
export function lostConnection(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof Error &&
    !(error instanceof CliError) &&
    !(error instanceof ApiError) &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

/**
 * A deterministic `Idempotency-Key`, so a rerun within the server's idempotency window replays
 * the original response instead of creating a second registration.
 */
export function idempotencyKey(prefix: string, material: unknown): string {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(material)).digest("hex")}`;
}

/**
 * Creates a native registration and confirms Clerk recorded the requested identity. A concurrent
 * creator or a lost successful response can leave the row in place, so a failed create re-reads
 * the registrations and accepts a matching one; it never creates a second registration.
 */
export async function registerNativeApplication<T>(options: {
  create: () => Promise<T>;
  list: () => Promise<T[]>;
  matching: (registrations: T[]) => T | undefined;
  /** The error for a successful create whose response doesn't carry the requested identity. */
  mismatch: () => CliError;
}): Promise<void> {
  try {
    const created = await options.create();
    if (!options.matching([created])) throw options.mismatch();
  } catch (error) {
    if (
      !lostConnection(error) &&
      !(error instanceof PlapiError && (error.status === 422 || error.status >= 500))
    )
      throw error;
    // If the re-read fails too, report the create failure, which says why.
    const current = await options.list().catch(() => {
      throw error;
    });
    if (!options.matching(current)) throw error;
  }
}

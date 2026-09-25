import { resolveFetchedApplicationInstance } from "../../../lib/config.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../../lib/errors.ts";
import { fetchApplication } from "../../../lib/plapi.ts";

export interface IOSDevelopmentPublicKey {
  applicationId: string;
  instanceId: string;
  publishableKey: string;
}

/** Resolve only the public development identity needed by native iOS setup. */
export async function resolveIOSDevelopmentPublicKey(
  applicationId: string,
): Promise<IOSDevelopmentPublicKey> {
  const application = await withApiContext(
    fetchApplication(applicationId, { includeSecretKeys: false }),
    "Failed to fetch the iOS development publishable key",
  );
  const resolved = resolveFetchedApplicationInstance(applicationId, application);
  if (!resolved.found) {
    throw new CliError(
      `Development instance ${resolved.instanceId} not found in application ${applicationId}.`,
      { code: ERROR_CODE.INSTANCE_NOT_FOUND },
    );
  }
  if (
    resolved.instanceLabel !== "development" ||
    resolved.instance.environment_type !== "development"
  ) {
    throw new CliError(
      "Automatic iOS configuration is limited to the linked development instance. No local setup changes were written.",
      { code: ERROR_CODE.INVALID_ENVIRONMENT },
    );
  }

  return {
    applicationId: application.application_id,
    instanceId: resolved.instanceId,
    publishableKey: resolved.instance.publishable_key,
  };
}

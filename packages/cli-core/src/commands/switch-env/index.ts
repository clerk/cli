/**
 * Switch the active Clerk CLI environment (e.g. production, staging).
 *
 * Persists the choice in ~/.clerk/config.json so all subsequent commands
 * use the selected environment's API endpoints and OAuth credentials.
 * Auth tokens are stored per-environment, so switching back does not
 * require re-authentication.
 */

import type { Need } from "../../lib/deps.ts";
import { CliError } from "../../lib/errors.ts";

export type SwitchEnvDeps = Need<{
  environment: "isValidEnv" | "setCurrentEnv" | "getAvailableEnvs" | "getCurrentEnvName";
  configStore: "setEnvironment";
  credentialStore: "getToken";
  log: "info";
}>;

export async function switchEnv(
  deps: SwitchEnvDeps,
  environment: string | undefined,
): Promise<void> {
  const available = deps.environment.getAvailableEnvs();

  // No argument: print current environment
  if (!environment) {
    const current = deps.environment.getCurrentEnvName();
    deps.log.info(`Current environment: ${current}`);
    deps.log.info(`Available environments: ${available.join(", ")}`);
    return;
  }

  if (!deps.environment.isValidEnv(environment)) {
    throw new CliError(
      `Unknown environment "${environment}". Available environments: ${available.join(", ")}`,
    );
  }

  const previousEnv = deps.environment.getCurrentEnvName();

  if (previousEnv === environment) {
    deps.log.info(`Already on ${environment} environment.`);
    return;
  }

  // Update the in-memory state and persist
  deps.environment.setCurrentEnv(environment);
  await deps.configStore.setEnvironment(environment);

  deps.log.info(`Switched from ${previousEnv} to ${environment}.`);

  // Check if there's a stored token for the target environment
  const token = await deps.credentialStore.getToken();
  if (!token) {
    deps.log.info(
      `No credentials found for ${environment}. Run \`clerk auth login\` to authenticate.`,
    );
  }
}

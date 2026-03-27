/**
 * Switch the active Clerk CLI environment (e.g. production, staging).
 *
 * Persists the choice in ~/.clerk/config.json so all subsequent commands
 * use the selected environment's API endpoints and OAuth credentials.
 * Auth tokens are stored per-environment, so switching back does not
 * require re-authentication.
 */

import { setEnvironment } from "../../lib/config.ts";
import { getToken } from "../../lib/credential-store.ts";
import {
  getCurrentEnvName,
  getAvailableEnvs,
  isValidEnv,
  setCurrentEnv,
} from "../../lib/environment.ts";
import { CliError } from "../../lib/errors.ts";

export async function switchEnv(environment: string | undefined): Promise<void> {
  const available = getAvailableEnvs();

  // No argument: print current environment
  if (!environment) {
    const current = getCurrentEnvName();
    console.log(`Current environment: ${current}`);
    console.log(`Available environments: ${available.join(", ")}`);
    return;
  }

  if (!isValidEnv(environment)) {
    throw new CliError(
      `Unknown environment "${environment}". Available environments: ${available.join(", ")}`,
    );
  }

  const previousEnv = getCurrentEnvName();

  if (previousEnv === environment) {
    console.log(`Already on ${environment} environment.`);
    return;
  }

  // Update the in-memory state and persist
  setCurrentEnv(environment);
  await setEnvironment(environment);

  console.log(`Switched from ${previousEnv} to ${environment}.`);

  // Check if there's a stored token for the target environment
  const token = await getToken();
  if (!token) {
    console.log(
      `No credentials found for ${environment}. Run \`clerk auth login\` to authenticate.`,
    );
  }
}

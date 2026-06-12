/**
 * Switch the active Clerk CLI environment (e.g. production, staging).
 *
 * Persists the choice in the CLI config file so all subsequent commands
 * use the selected environment's API endpoints and OAuth credentials.
 * Auth tokens are stored per-environment, so switching back does not
 * require re-authentication.
 */

import type { Program } from "../../cli-program.ts";
import { setEnvironment } from "../../lib/config.ts";
import { getToken } from "../../lib/credential-store.ts";
import {
  getCurrentEnvName,
  getAvailableEnvs,
  isValidEnv,
  setCurrentEnv,
} from "../../lib/environment.ts";
import { CliError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { isHuman } from "../../mode.ts";
import { select } from "../../lib/listage.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";

export async function switchEnv(environmentArg: string | undefined): Promise<void> {
  const available = getAvailableEnvs();
  const current = getCurrentEnvName();

  intro("Switching environment");

  // No argument: show interactive picker (human) or print info (non-interactive)
  let target = environmentArg;
  if (!target) {
    if (isHuman() && available.length > 1 && process.stdin.isTTY) {
      target = await select<string>({
        message: "Switch to environment:",
        choices: available.map((env) => ({
          name: env === current ? `${env} (current)` : env,
          value: env,
        })),
        default: current,
      });
    } else if (isHuman() && available.length > 1 && !process.stdin.isTTY) {
      throw new CliError(
        "No interactive terminal available — pass an environment name explicitly: `clerk switch-env <name>`",
      );
    } else if (available.length <= 1) {
      log.info(`Current environment: ${current}`);
      log.info("Only one environment configured — nothing to switch to.");
      outro();
      return;
    } else {
      log.info(`Current environment: ${current}`);
      log.info(`Available environments: ${available.join(", ")}`);
      outro();
      return;
    }
  }

  if (!isValidEnv(target)) {
    throw new CliError(
      `Unknown environment "${target}". Available environments: ${available.join(", ")}`,
    );
  }

  const previousEnv = getCurrentEnvName();

  if (previousEnv === target) {
    log.data(`Already on ${target} environment.`);
    outro();
    return;
  }

  // Update the in-memory state and persist
  setCurrentEnv(target);
  await setEnvironment(target);

  log.data(`Switched from ${previousEnv} to ${target}.`);

  const token = await getToken();
  if (!token) {
    log.data(`No credentials found for ${target}.`);
    outro(NEXT_STEPS.SWITCH_ENV_NO_TOKEN);
    return;
  }
  outro(NEXT_STEPS.SWITCH_ENV);
}

export function registerSwitchEnv(program: Program): void {
  program
    .command("switch-env", { hidden: true })
    .description("Switch the active Clerk CLI environment")
    .argument("[environment]", "Environment to switch to (e.g. production, staging)")
    .setExamples([
      { command: "clerk switch-env", description: "Show current environment" },
      { command: "clerk switch-env staging", description: "Switch to staging" },
      { command: "clerk switch-env production", description: "Switch back to production" },
    ])
    .action(switchEnv);
}

import { cyan } from "../../lib/color.ts";
import { CliError, EXIT_CODE } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { activeDeployInProgressMessage, pausedMessage } from "./copy.ts";
import { providerLabel, type OAuthProvider } from "./providers.ts";
import type { DeployOperationState, Profile } from "../../lib/config.ts";

export type DeployContext = {
  profileKey: string;
  profile: Profile;
  appId: string;
  appLabel: string;
  developmentInstanceId: string;
};

export function isDeployStateValid(ctx: DeployContext, state: DeployOperationState): boolean {
  return state.appId === ctx.appId && state.developmentInstanceId === ctx.developmentInstanceId;
}

export function pausedStepDescription(state: DeployOperationState): string {
  if (state.pending.type === "dns") {
    return `DNS verification for ${state.domain}`;
  }
  return `${providerLabel(state.pending.provider as OAuthProvider)} OAuth credential setup`;
}

export function printPausedMessage(state: DeployOperationState): void {
  log.info(`Deploy is paused for ${cyan(state.domain)}.`);
  log.blank();
  log.info(pausedMessage(pausedStepDescription(state)));
}

export class DeployPausedError extends CliError {}

export function activeDeployInProgressError(state: DeployOperationState): DeployPausedError {
  return new DeployPausedError(activeDeployInProgressMessage(pausedStepDescription(state)), {
    exitCode: EXIT_CODE.GENERAL,
  });
}

export function deployPausedError(
  state: DeployOperationState,
  options?: { interrupted?: boolean },
): DeployPausedError {
  return new DeployPausedError(pausedMessage(pausedStepDescription(state)), {
    exitCode: options?.interrupted ? EXIT_CODE.SIGINT : EXIT_CODE.GENERAL,
  });
}

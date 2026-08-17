import { CliError, EXIT_CODE } from "../../lib/errors.ts";
import { pausedMessage } from "./copy.ts";
import type { CnameTarget } from "../../lib/plapi.ts";
import { providerLabel, type OAuthProvider } from "./providers.ts";
import type { Profile } from "../../lib/config.ts";

export type DeployOperationState = {
  appId: string;
  developmentInstanceId: string;
  productionInstanceId?: string;
  productionDomainId?: string;
  domain: string;
  frontendApiUrl?: string;
  pending: { type: "dns" } | { type: "oauth"; provider: string };
  oauthProviders: string[];
  completedOAuthProviders: string[];
  cnameTargets?: readonly CnameTarget[];
};

export type DeployContext = {
  profileKey: string;
  profile: Profile;
  appId: string;
  appLabel: string;
  developmentInstanceId: string;
  productionInstanceId?: string;
};

export function pausedStepDescription(state: DeployOperationState): string {
  if (state.pending.type === "dns") {
    return `DNS verification for ${state.domain}`;
  }
  return `${providerLabel(state.pending.provider as OAuthProvider)} OAuth credential setup`;
}

export class DeployPausedError extends CliError {}

/**
 * Either way the deploy is unfinished, so both codes are nonzero: a production
 * instance exists but DNS or OAuth is incomplete, and `clerk deploy && cutover`
 * must not proceed. `interrupted` (the user stopped it) reports 130 to match
 * every other Ctrl-C; otherwise it is an ordinary failure and reports 1.
 */
export function deployPausedError(
  state: DeployOperationState,
  options?: { interrupted?: boolean },
): DeployPausedError {
  return new DeployPausedError(pausedMessage(pausedStepDescription(state)), {
    exitCode: options?.interrupted ? EXIT_CODE.SIGINT : EXIT_CODE.GENERAL,
  });
}

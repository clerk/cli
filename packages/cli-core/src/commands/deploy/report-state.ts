import type { DeployOperationState } from "./state.ts";
import type { DeployStatusState } from "./status.ts";

/** The states a deploy with a production domain can be in. */
export type ActiveDeployStatusState = Extract<
  DeployStatusState,
  "domain_pending" | "oauth_pending" | "complete"
>;

export type OAuthSetupFacts = Pick<
  DeployOperationState,
  "oauthProviders" | "completedOAuthProviders"
>;

export function pendingOAuthProviders(oauth: OAuthSetupFacts): string[] {
  return oauth.oauthProviders.filter(
    (provider) => !oauth.completedOAuthProviders.includes(provider),
  );
}

/**
 * The one place the three active states are decided, for the report and for
 * telemetry alike. `domainComplete` is the domain-status read's own verdict,
 * not the three component booleans: all three can be verified while Clerk is
 * still finalizing, and that is still `domain_pending`.
 */
export function resolveActiveReportState(
  oauth: OAuthSetupFacts,
  domainComplete: boolean,
): ActiveDeployStatusState {
  if (!domainComplete) return "domain_pending";
  return pendingOAuthProviders(oauth).length === 0 ? "complete" : "oauth_pending";
}

import { CliError, ERROR_CODE, EXIT_CODE, type ErrorCode } from "../../lib/errors.ts";
import { setTelemetryPauseStep } from "../../lib/telemetry.ts";
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
 * Why the deploy stopped. Three situations, not one with modifiers: a skip, an
 * interrupt and a backend wait need three different follow-ups, and each gets
 * its own error code so telling them apart never means reading `exit_code`
 * (which cannot separate `paused` from `finalizing` — both exit 1).
 *
 * One argument rather than two so the reason and the exit code cannot
 * disagree; the shape they share is in {@link PAUSE_REASONS}.
 */
export type DeployPauseReason = "paused" | "cancelled" | "finalizing";

/**
 * Either way the deploy is unfinished, so every exit code here is nonzero: a
 * production instance exists but DNS or OAuth is incomplete, and `clerk deploy
 * && cutover` must not proceed. `cancelled` (the user stopped it) reports 130
 * to match every other Ctrl-C; the rest are ordinary failures and report 1.
 */
const PAUSE_REASONS: Record<
  DeployPauseReason,
  { code: ErrorCode; exitCode: typeof EXIT_CODE.GENERAL | typeof EXIT_CODE.SIGINT }
> = {
  paused: { code: ERROR_CODE.DEPLOY_PAUSED, exitCode: EXIT_CODE.GENERAL },
  cancelled: { code: ERROR_CODE.DEPLOY_CANCELLED, exitCode: EXIT_CODE.SIGINT },
  finalizing: { code: ERROR_CODE.DEPLOY_FINALIZING, exitCode: EXIT_CODE.GENERAL },
};

/**
 * The pause every unfinished `clerk deploy` run throws, and the one place that
 * records which step it stopped on — the only point that knows both, since
 * `state.pending` names the step and `reason` says whether the person stopped
 * there at all. A `finalizing` wait did not: the deploy is waiting on Clerk, so
 * recording `dns` would count a drop-off nobody made, and the code already says
 * everything the step would.
 *
 * The telemetry write is an in-memory assignment that cannot throw, which is
 * the bar for putting one on an error path: instrumentation must never be able
 * to replace the error it is describing.
 */
export function deployPausedError(
  state: DeployOperationState,
  reason: DeployPauseReason = "paused",
): DeployPausedError {
  if (reason !== "finalizing") setTelemetryPauseStep(state.pending.type);
  return new DeployPausedError(pausedMessage(pausedStepDescription(state)), PAUSE_REASONS[reason]);
}

import {
  setTelemetryDomainComponents,
  setTelemetryOAuthComplete,
  setTelemetryStage,
} from "../../lib/telemetry.ts";
import {
  pendingOAuthProviders,
  resolveActiveReportState,
  type OAuthSetupFacts,
} from "./report-state.ts";
// Type-only on purpose: `status.ts` imports the recorders at runtime, so a
// runtime import back would be an initialization-order cycle.
import type { DeployState, DeployStatusOutcome, DeployStatusState } from "./status.ts";
import type { DeployComponentStatus } from "./copy.ts";

/**
 * Record the deploy's state as telemetry's `stage`. Every write goes through
 * this function, {@link recordDeployObservation} or {@link recordDeployPoll},
 * and every value is a report state — what `clerk deploy status` would print
 * for this deploy at this moment — so the wizard, the agent handoff and the
 * status command agree about the same deploy.
 *
 * One rule across every writer of `stage` and of the four `components`: last
 * write wins, and nothing is written without an observation, so a run that
 * ends before any state is known sends null. The endings are walked one by
 * one in `index.test.ts` ("what telemetry records as the stage") and
 * `status-command.test.ts`.
 *
 * This entry takes a state the caller can vouch for without a snapshot — one
 * the CLI's own action established, or a poll's verdict. Anything derived
 * from a snapshot goes through `recordDeployObservation`, which is where the
 * substituted-read check lives. `interrupted` is not a state of the deploy,
 * only of a report, so it cannot be recorded.
 */
export function recordDeployStage(state: Exclude<DeployStatusState, "interrupted">): void {
  setTelemetryStage(state);
}

/** Record whether every required provider has production credentials. */
export function recordOAuthObservation(oauth: OAuthSetupFacts): void {
  setTelemetryOAuthComplete(pendingOAuthProviders(oauth).length === 0);
}

/**
 * Record what one successful domain-status read said about DNS, SSL and email
 * DNS. The initial read and every poll both come through here, so the two
 * cannot drift apart. `oauth` is not this read's to write.
 */
export function recordDomainObservation(status: DeployComponentStatus): void {
  setTelemetryDomainComponents(status);
}

/**
 * Record the stage a state read established. The components are not recorded
 * here: `resolveLiveDeploySnapshot` writes each the moment its own read
 * succeeds, so a failure in the other read cannot discard it. The stage needs
 * both reads, and a substituted domain read establishes none, so this is
 * where that check lives — the callers that read through `resolveDeployState`
 * never trip it today, because that read throws rather than substitutes, and
 * the check is here so that stays true without every call site knowing about
 * the option.
 */
export function recordDeployObservation(state: DeployState): void {
  if (state.kind !== "active") {
    recordDeployStage(state.kind);
    return;
  }
  const { snapshot } = state;
  if (!snapshot.live) return;
  recordDeployStage(resolveActiveReportState(snapshot, snapshot.domainComplete));
}

/**
 * Record what one domain-status poll established: the three domain
 * components and the stage. `oauth` is untouched because the poll did not
 * observe it — not as an optimisation, but so a value the poll never learned
 * cannot overwrite one an earlier read did. A poll is its own observation, so
 * it records whatever the snapshot before it was.
 */
export function recordDeployPoll(oauth: OAuthSetupFacts, polled: DeployStatusOutcome): void {
  recordDomainObservation(polled.status);
  recordDeployStage(resolveActiveReportState(oauth, polled.verified));
}

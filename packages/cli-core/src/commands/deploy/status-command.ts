import { isAgent } from "../../mode.ts";
import { CliError, ERROR_CODE, EXIT_CODE } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { interruptedExitCode } from "../../lib/signals.ts";
import { sleep } from "../../lib/sleep.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { deployComponentLabels, type DeployComponentStatus } from "./copy.ts";
import {
  buildDeployStatusReport,
  buildInterruptedDeployStatusReport,
  loadProductionDomain,
  resolveDeployContext,
  resolveDeployState,
  triggerDeployStatusCheck,
  waitForDeployStatus,
  type DeployState,
  type DeployStatusOutcome,
  type DeployStatusReport,
} from "./status.ts";
import type { DeployContext } from "./state.ts";

type DeployStatusOptions = {
  wait?: boolean;
};

const DEPLOY_STATUS_PREFLIGHT_DELAY_MS = 2000;

export async function deployStatus(options: DeployStatusOptions = {}): Promise<void> {
  // The whole command is covered by one interrupt catch, starting at the first
  // await. `runProgram` returns early the moment an interrupt latches, so
  // nothing below this frame runs and any stretch left outside prints nothing
  // at all — every await here reaches the Platform API or the config file.
  //
  // Both of these are read by the catch, so they live outside the `try`:
  // `state` is what a report can be built from, and `lastPolledStatus` is what
  // the wait loop established. The loop's own status is local to it and Ctrl-C
  // rejects out of the next poll before it returns, so without capturing each
  // poll the report would list components as pending after they verified.
  let state: DeployState | null = null;
  let lastPolledStatus: DeployComponentStatus | undefined;
  try {
    const ctx = await resolveDeployContext();
    // Not an interrupt, so the catch rethrows this untouched.
    if (!ctx.appId || !ctx.developmentInstanceId) {
      throw new CliError(
        "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy status`.",
        { code: ERROR_CODE.NOT_LINKED },
      );
    }

    const preflightTriggered = await runPreflightDeployStatusCheck(ctx);
    state = await resolveDeployState(ctx);
    const shouldWait = options.wait === true || !isAgent();

    let outcome: DeployStatusOutcome | null = null;
    if (state.kind === "active" && shouldWait) {
      outcome = await runWait(state, {
        triggerCheck: !preflightTriggered,
        onStatus: (status) => {
          lastPolledStatus = status;
        },
      });
    }

    const report = buildDeployStatusReport(state, outcome);

    emitReport(report);
    process.exitCode = report.complete ? EXIT_CODE.SUCCESS : EXIT_CODE.GENERAL;
  } catch (error) {
    if (interruptedExitCode() === null) throw error;
    // Report what was established, then rethrow: the exit code stays 130, so no
    // script reads this as a finished deploy.
    emitReport(buildInterruptedReport(state, lastPolledStatus));
    throw error;
  }
}

/**
 * The best report available when Ctrl-C cut the command short. Before
 * `resolveDeployState` answers there is nothing to build one from, so this
 * falls back to the "interrupted" report rather than claiming a state.
 */
function buildInterruptedReport(
  state: DeployState | null,
  lastPolledStatus: DeployComponentStatus | undefined,
): DeployStatusReport {
  if (!state) return buildInterruptedDeployStatusReport();
  const partial = lastPolledStatus ? { verified: false, status: lastPolledStatus } : null;
  return buildDeployStatusReport(state, partial);
}

async function runPreflightDeployStatusCheck(ctx: DeployContext): Promise<boolean> {
  if (!ctx.productionInstanceId) return false;

  const domain = await loadProductionDomain(ctx);
  if (!domain) return false;

  const domainIdOrName = domain.id ?? domain.name;
  await triggerDeployStatusCheck(ctx.appId, domainIdOrName);
  await withSpinner("Waiting for Clerk DNS check to process...", async () =>
    sleep(DEPLOY_STATUS_PREFLIGHT_DELAY_MS),
  );
  return true;
}

async function runWait(
  state: Extract<DeployState, { kind: "active" }>,
  options: { triggerCheck?: boolean; onStatus?: (status: DeployComponentStatus) => void } = {},
): Promise<DeployStatusOutcome> {
  const { snapshot } = state;
  const domainIdOrName = snapshot.productionDomainId ?? snapshot.domain;
  const { onStatus, ...waitOptions } = options;
  return waitForDeployStatus(
    snapshot.appId,
    domainIdOrName,
    snapshot.domain,
    {
      runVerification: async (progressLabel, work) => withSpinner(progressLabel, work),
      onVerified: () => {
        if (!isAgent()) log.success(deployComponentLabels("dns", snapshot.domain).done);
      },
      onStatus,
    },
    waitOptions,
  );
}

function emitReport(report: DeployStatusReport): void {
  if (isAgent()) {
    log.data(JSON.stringify(report, null, 2));
    return;
  }
  renderHuman(report);
}

function renderHuman(report: DeployStatusReport): void {
  log.blank();
  if (report.domain) {
    log.info(`Deploy status for \`${report.domain}\``);
  } else {
    log.info("Deploy status");
  }

  // Nothing was read, so the empty OAuth and domain rows below would read as
  // "checked, found nothing" rather than "never checked". Only the next action
  // is true here.
  if (report.state === "interrupted") {
    log.blank();
    log.info(report.nextAction);
    log.blank();
    return;
  }

  if (report.domainStatus) {
    log.info(
      `  Domain   DNS: ${report.domainStatus.dns}  SSL: ${report.domainStatus.ssl}  Email DNS: ${report.domainStatus.mail}`,
    );
  }

  const oauthStatus = report.oauth.complete
    ? "complete"
    : `pending: ${report.oauth.pending.join(", ") || "none"}`;
  log.info(`  OAuth    ${oauthStatus}`);

  if (report.oauth.unsupported.length > 0) {
    log.warn(
      `  ${report.oauth.unsupported.length} OAuth provider(s) enabled in dev are not supported by automated deploy: ${report.oauth.unsupported.join(", ")}. Configure them from the Clerk Dashboard.`,
    );
  }

  log.blank();
  log.info(formatHumanNextAction(report.nextAction));
  log.blank();
}

function formatHumanNextAction(nextAction: string): string {
  return nextAction.replace(
    /Ask the user to visit the Clerk Dashboard domains page, or offer to open it: (https:\/\/\S+)/,
    "Visit the Clerk Dashboard domains page to monitor its status there: $1",
  );
}

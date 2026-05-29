import { isAgent } from "../../mode.ts";
import { CliError, ERROR_CODE, EXIT_CODE } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { sleep } from "../../lib/sleep.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { deployComponentLabels } from "./copy.ts";
import {
  buildDeployStatusReport,
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
  const ctx = await resolveDeployContext();
  if (!ctx.appId || !ctx.developmentInstanceId) {
    throw new CliError(
      "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy status`.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  const preflightTriggered = await runPreflightDeployStatusCheck(ctx);
  const state = await resolveDeployState(ctx);
  const shouldWait = options.wait === true || !isAgent();
  const outcome =
    state.kind === "active" && shouldWait
      ? await runWait(state, { triggerCheck: !preflightTriggered })
      : null;
  const report = buildDeployStatusReport(state, outcome);

  emitReport(report);
  process.exitCode = report.complete ? EXIT_CODE.SUCCESS : EXIT_CODE.GENERAL;
}

async function runPreflightDeployStatusCheck(ctx: DeployContext): Promise<boolean> {
  if (!ctx.productionInstanceId) return false;

  const domain = await loadProductionDomain(ctx);
  if (!domain) return false;

  const domainIdOrName = domain.id ?? domain.name;
  await triggerDeployStatusCheck(ctx.appId, domainIdOrName);
  await withSpinner("Waiting for Clerk DNS check to process...", () =>
    sleep(DEPLOY_STATUS_PREFLIGHT_DELAY_MS),
  );
  return true;
}

function runWait(
  state: Extract<DeployState, { kind: "active" }>,
  options: { triggerCheck?: boolean } = {},
): Promise<DeployStatusOutcome> {
  const { snapshot } = state;
  const domainIdOrName = snapshot.productionDomainId ?? snapshot.domain;
  return waitForDeployStatus(
    snapshot.appId,
    domainIdOrName,
    snapshot.domain,
    {
      runVerification: (progressLabel, work) => withSpinner(progressLabel, work),
      onVerified: () => {
        if (!isAgent()) log.success(deployComponentLabels("dns", snapshot.domain).done);
      },
    },
    options,
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

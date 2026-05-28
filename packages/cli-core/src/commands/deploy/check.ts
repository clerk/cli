import { isAgent } from "../../mode.ts";
import { CliError, ERROR_CODE, EXIT_CODE } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { deployComponentLabels } from "./copy.ts";
import {
  buildDeployStatusReport,
  resolveDeployContext,
  resolveDeployState,
  waitForDeployStatus,
  type DeployState,
  type DeployStatusOutcome,
  type DeployStatusReport,
} from "./status.ts";

type DeployCheckOptions = Record<string, never>;

export async function deployCheck(_options: DeployCheckOptions = {}): Promise<void> {
  const ctx = await resolveDeployContext();
  if (!ctx.appId || !ctx.developmentInstanceId) {
    throw new CliError(
      "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy check`.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  const state = await resolveDeployState(ctx);
  const outcome = state.kind === "active" ? await runWait(state) : null;
  const report = buildDeployStatusReport(state, outcome);

  emitReport(report);
  process.exitCode = report.complete ? EXIT_CODE.SUCCESS : EXIT_CODE.GENERAL;
}

function runWait(state: Extract<DeployState, { kind: "active" }>): Promise<DeployStatusOutcome> {
  const { snapshot } = state;
  const domainIdOrName = snapshot.productionDomainId ?? snapshot.domain;
  return waitForDeployStatus(snapshot.appId, domainIdOrName, snapshot.domain, {
    runComponent: (_component, progressLabel, work) => withSpinner(progressLabel, work),
    onComponentDone: (component) => {
      if (!isAgent()) log.success(deployComponentLabels(component, snapshot.domain).done);
    },
  });
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
      `  Domain   DNS: ${report.domainStatus.dns}  SSL: ${report.domainStatus.ssl}  Mail: ${report.domainStatus.mail}`,
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
  log.info(report.nextAction);
  log.blank();
}

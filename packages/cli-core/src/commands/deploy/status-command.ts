import { isAgent } from "../../mode.ts";
import { CliError, ERROR_CODE, EXIT_CODE } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { interruptedExitCode } from "../../lib/signals.ts";
import { sleep } from "../../lib/sleep.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { declareSoftExitOutcome } from "../../lib/telemetry.ts";
import { deployComponentLabels, dnsRecords, type DeployComponentStatus } from "./copy.ts";
import {
  buildDeployStatusReport,
  buildInterruptedDeployStatusReport,
  deployNextStep,
  loadProductionDomain,
  resolveDeployContext,
  resolveDeployState,
  triggerDeployStatusCheck,
  waitForDeployStatus,
  type DeployNextStep,
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
    // The check ran and answered; the deploy just isn't finished. The exit
    // code stays 1 so `clerk deploy status && ./cutover.sh` still stops, but
    // telemetry records what happened rather than reading the 1 as a failure.
    // Declared here and not in the error path: a thrown error is a real
    // failure and keeps its own code.
    if (!report.complete) declareSoftExitOutcome("incomplete");
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

/** Exported so the human rendering can be exercised directly. */
export function renderHuman(report: DeployStatusReport): void {
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
    log.info(humanNextAction(deployNextStep(report)));
    log.blank();
    return;
  }

  if (report.domainStatus) {
    log.info(
      `  Domain   DNS: ${report.domainStatus.dns}  SSL: ${report.domainStatus.ssl}  Email DNS: ${report.domainStatus.mail}`,
    );
  }

  // No domain status means no production instance was read, so OAuth was
  // never checked either; "pending: none" would claim it was.
  if (report.domainStatus) {
    const oauthStatus = report.oauth.complete
      ? "complete"
      : `pending: ${report.oauth.pending.join(", ") || "none"}`;
    log.info(`  OAuth    ${oauthStatus}`);
  }

  if (report.oauth.unsupported.length > 0) {
    log.warn(
      `  ${report.oauth.unsupported.length} OAuth provider(s) enabled in dev are not supported by automated deploy: ${report.oauth.unsupported.join(", ")}. Configure them from the Clerk Dashboard.`,
    );
  }

  // The agent gets these as `pendingDnsRecords` in the JSON; a person has no
  // JSON, so print the records themselves before the sentence that refers to
  // them.
  if (report.pendingDnsRecords.length > 0) {
    log.blank();
    const targets = report.pendingDnsRecords.map((record) => ({
      host: record.host,
      value: record.value,
      required: record.required,
    }));
    for (const line of dnsRecords(targets, { afterCheck: true })) log.info(line);
  }

  log.blank();
  log.info(humanNextAction(deployNextStep(report)));
  log.blank();
}

/**
 * The line a person sees under `clerk deploy status`. Rendered from the same
 * {@link DeployNextStep} as the agent's `nextAction`, not from that sentence:
 * the reader is the user (so never "ask the user"), has no JSON (so never
 * `pendingDnsRecords`), already waits (so never `--wait`), and resumes setup
 * with the wizard. The unsupported-provider warning row above says its piece,
 * so it isn't repeated here. Exported so the wording can be tested per state.
 */
export function humanNextAction(step: DeployNextStep): string {
  const domains = (url: string | null): string =>
    url ? ` Visit the Clerk Dashboard domains page to monitor its status there: ${url}` : "";

  switch (step.kind) {
    case "not_started":
      return (
        "No production instance yet. `clerk deploy` configures production interactively and " +
        "needs a terminal. Run `clerk deploy` to set it up."
      );
    case "domain_provisioning":
      return (
        "A production instance exists but its domain is still provisioning. " +
        "Run `clerk deploy status` again shortly, or run `clerk deploy` to finish setup." +
        domains(step.domainsUrl)
      );
    case "interrupted":
      return (
        "Interrupted before the deploy status could be read, so nothing is known about this " +
        "deploy. Run `clerk deploy status` again to check it."
      );
    case "complete":
      return (
        `Clerk's production setup for https://${step.domain} is verified. If you haven't already: ` +
        `run \`clerk env pull --instance prod\`, set those keys on your host alongside the other ` +
        `Clerk variables from your env file, redeploy, then sign up at https://${step.domain} to confirm.` +
        (step.instanceUrl
          ? ` Manage users, settings, and billing for this instance: ${step.instanceUrl}`
          : "")
      );
    case "oauth_pending":
      return (
        `Domain verified, but these OAuth providers are missing production credentials: ` +
        `${step.oauthPending.join(", ")}. Run \`clerk deploy\` to finish setup.`
      );
    case "records_available":
      // The records block printed above already says "add these"; the
      // sentence only needs to say what happens next.
      return (
        `${step.records} records not found yet for ${step.domain}. ` +
        `Once they're added, run \`clerk deploy\` again to resume. Propagation usually takes minutes.` +
        domains(step.domainsUrl)
      );
    case "records_unavailable":
      return (
        `${step.records} records not found yet for ${step.domain}, but Clerk didn't return the list of records to add. ` +
        `Find them on the Domains page in the Clerk Dashboard, add them, then run \`clerk deploy\` again to resume.` +
        domains(step.domainsUrl)
      );
    case "ssl_pending":
      return (
        `SSL certificate still pending for ${step.domain}. Clerk issues it automatically now that ` +
        `DNS is verified; re-run \`clerk deploy status\` in a few minutes.` +
        domains(step.domainsUrl)
      );
    case "finalizing":
      return (
        `Production setup for ${step.domain} is still finalizing on Clerk's side. ` +
        `Re-run \`clerk deploy status\` in a few minutes.` +
        domains(step.domainsUrl)
      );
  }
}

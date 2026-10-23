import { log } from "../../lib/log.ts";
import type { CnameTarget } from "../../lib/plapi.ts";
import { withSpinner } from "../../lib/spinner.ts";
import {
  bindZoneFile,
  deployComponentLabels,
  deployComponentStatus,
  deployStatusPendingFooter,
  dnsDashboardHandoff,
  dnsHandoffNothingToAdd,
  dnsIntro,
  dnsRecords,
  domainsDashboardUrl,
  pendingCnameTargets,
  type DeployComponentStatus,
} from "./copy.ts";
import {
  chooseDnsVerificationAction,
  chooseDnsVerificationRetryAction,
  confirmExportBindZone,
} from "./prompts.ts";
import {
  pauseOnAbort,
  throwDeployPaused,
  type DeployContext,
  type DeployOperationState,
} from "./state.ts";
import {
  waitForDeployStatus,
  type DeployProgressHandlers,
  type DeployStatusOutcome,
  type DomainCheckOptions,
} from "./status.ts";
import { recordDeployPoll } from "./telemetry.ts";

export type DnsVerificationResult = "verified" | "pending";

/**
 * `display` is what the screen lists as records to add; `exportTargets` is
 * what the BIND zone file gets. They differ on resume: the screen shows only
 * the records still outstanding, but a zone file with some of the domain's
 * records is not a zone file anyone should import.
 */
export async function runDnsRecordHandoff(
  state: DeployOperationState,
  options: {
    /** Records printed on screen: only the ones still to add. */
    display: readonly CnameTarget[];
    /** Records offered for the zone-file export: every record for the domain. */
    exportTargets: readonly CnameTarget[];
    status: DeployComponentStatus;
    afterCheck?: boolean;
    oauthNext: boolean;
  },
): Promise<void> {
  const { display, exportTargets, status } = options;
  const handoffInstanceId = state.productionInstanceId;
  const domainsUrl = handoffInstanceId
    ? domainsDashboardUrl(state.appId, handoffInstanceId)
    : undefined;

  // With no records to add, a "Configure DNS" page is the wrong page: say
  // what is actually outstanding instead (certificate, Clerk finalizing, or
  // a record list Clerk didn't return).
  const lines =
    display.length > 0
      ? [
          ...dnsIntro(state.domain),
          "",
          ...dnsRecords(display, { afterCheck: options.afterCheck }),
          "",
          ...dnsDashboardHandoff(state.domain, domainsUrl, { oauthNext: options.oauthNext }),
        ]
      : dnsHandoffNothingToAdd(state.domain, status, domainsUrl, { oauthNext: options.oauthNext });
  for (const line of lines) {
    if (line === "") log.blank();
    else log.info(line);
  }
  log.blank();
  await pauseOnAbort(state, async () => offerBindZoneExport(state.domain, exportTargets));
  log.blank();
}

export async function runExistingDomainDnsVerification(
  ctx: DeployContext,
  state: DeployOperationState,
  componentStatus: DeployComponentStatus,
): Promise<DnsVerificationResult> {
  if (state.verification.clerkManaged) return runDomainVerification(ctx, state);
  // On resume some records may already be verified; only the outstanding ones
  // are records to add, and the user may have added those already.
  const allTargets = state.cnameTargets ?? [];
  // OAuth ran before this on the resume path, so the check is next.
  await runDnsRecordHandoff(state, {
    display: pendingCnameTargets(allTargets, componentStatus),
    exportTargets: allTargets,
    status: componentStatus,
    afterCheck: true,
    oauthNext: false,
  });
  return runDnsVerificationPrompt(ctx, state);
}

export async function runDnsVerificationPrompt(
  ctx: DeployContext,
  state: DeployOperationState,
  options: DomainCheckOptions = {},
): Promise<DnsVerificationResult> {
  const action = await pauseOnAbort(state, chooseDnsVerificationAction);
  if (action === "skip") {
    log.blank();
    log.info("Skipping DNS verification for now.");
    return "pending";
  }
  return runDomainVerification(ctx, state, options);
}

export async function runDomainVerification(
  ctx: DeployContext,
  state: DeployOperationState,
  options: DomainCheckOptions = {},
): Promise<DnsVerificationResult> {
  return pauseOnAbort(state, async () => pollUntilVerifiedOrSkipped(ctx, state, options));
}

async function pollUntilVerifiedOrSkipped(
  ctx: DeployContext,
  state: DeployOperationState,
  options: DomainCheckOptions,
): Promise<DnsVerificationResult> {
  const domainIdOrName = state.productionDomainId ?? state.domain;
  const { verification } = state;

  while (true) {
    // Per poll, not once the wait returns: a Ctrl-C mid-wait is reported by
    // the signal handler with the stage as it stands at that moment.
    const outcome = await pollDeployStatus(
      ctx.appId,
      domainIdOrName,
      state,
      (polled) => recordDeployPoll(state, polled),
      options,
    );

    log.blank();
    log.info(deployComponentStatus(outcome.status, verification));
    if (outcome.verified) return "verified";

    log.blank();
    const productionInstanceId = state.productionInstanceId ?? ctx.productionInstanceId;
    // Computed before the footer so the footer can tell the user when there is
    // no record list to print, instead of saying "add them" over nothing.
    const pendingTargets = pendingCnameTargets(state.cnameTargets ?? [], outcome.status);
    for (const line of deployStatusPendingFooter(
      state.domain,
      outcome.status,
      productionInstanceId ? domainsDashboardUrl(ctx.appId, productionInstanceId) : undefined,
      pendingTargets.length > 0,
    )) {
      if (line === "") log.blank();
      else log.warn(line);
    }

    // When all DNS components are verified but the server has not yet marked the
    // deployment complete, the user cannot influence the remaining wait.
    if (outcome.status.dns && outcome.status.ssl && outcome.status.mail) {
      throwDeployPaused(state, "finalizing");
    }

    if (pendingTargets.length > 0) {
      log.blank();
      for (const line of dnsRecords(pendingTargets, { afterCheck: true })) log.info(line);
    }
    log.blank();
    const action = await chooseDnsVerificationRetryAction(verification.subject);
    if (action === "skip") {
      log.blank();
      log.info(`Skipping ${verification.subject} verification for now.`);
      return "pending";
    }
  }
}

async function pollDeployStatus(
  appId: string,
  domainIdOrName: string,
  state: DeployOperationState,
  onStatus: DeployProgressHandlers["onStatus"],
  options: DomainCheckOptions,
): Promise<DeployStatusOutcome> {
  const { verification } = state;
  return waitForDeployStatus(
    appId,
    domainIdOrName,
    state.domain,
    verification,
    {
      runVerification: async (progressLabel, work) => withSpinner(progressLabel, work),
      onVerified: () =>
        log.success(deployComponentLabels(verification.component, state.domain).done),
      onStatus,
    },
    options,
  );
}

async function offerBindZoneExport(
  domain: string,
  cnameTargets: readonly CnameTarget[] | undefined,
): Promise<void> {
  if (!cnameTargets || cnameTargets.length === 0) return;
  const accepted = await confirmExportBindZone();
  if (!accepted) return;
  const contents = bindZoneFile(domain, cnameTargets, new Date());
  const filePath = `${process.cwd()}/clerk-${domain}.zone`;
  await Bun.write(filePath, contents);
  log.success(`Wrote ${filePath}`);
}

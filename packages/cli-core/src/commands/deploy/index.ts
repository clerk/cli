import { isAgent } from "../../mode.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import { bold, dim } from "../../lib/color.ts";
import { animateHeader } from "../../lib/gradient.ts";
import { bar, intro, outro, pausedOutro, withSpinner } from "../../lib/spinner.ts";
import {
  CliError,
  ERROR_CODE,
  UserAbortError,
  isPromptExitError,
  throwUsageError,
} from "../../lib/errors.ts";
import { setProfile } from "../../lib/config.ts";
import {
  createProductionInstance as apiCreateProductionInstance,
  patchInstanceConfig,
  type CnameTarget,
  type ProductionInstanceResponse,
} from "../../lib/plapi.ts";
import {
  INTRO_PREAMBLE,
  OAUTH_SECTION_INTRO,
  type DeployPlanStep,
  deployComponentLabels,
  deployComponentStatus,
  deployStatusPendingFooter,
  domainAssociationSummary,
  bindZoneFile,
  dnsDashboardHandoff,
  dnsIntro,
  dnsRecords,
  nextStepsBody,
  pendingDnsRecords,
  pausedOperationNotice,
  printPlan,
  productionSummary,
} from "./copy.ts";
import { mapDeployError } from "./errors.ts";
import {
  providerLabel,
  providerSetupIntro,
  showOAuthWalkthrough,
  type OAuthProvider,
  type OAuthProviderDescriptor,
} from "./providers.ts";
import {
  chooseDnsVerificationAction,
  chooseDnsVerificationRetryAction,
  chooseOAuthCredentialAction,
  collectCustomDomain,
  collectOAuthCredentials,
  confirmCreateProductionInstance,
  confirmExportBindZone,
  confirmProceed,
} from "./prompts.ts";
import {
  DeployPausedError,
  deployPausedError,
  type DeployContext,
  type DeployOperationState,
} from "./state.ts";
import {
  buildDeployStatusReport,
  loadDevelopmentOAuthProviders,
  resolveDeployContext,
  resolveDeployState,
  resolveLiveApplicationContext,
  resolveLiveDeploySnapshot,
  waitForDeployStatus,
  type DeployStatusOutcome,
  type DiscoveredOAuthProviders,
  type LiveDeploySnapshot,
} from "./status.ts";

type DeployOptions = Record<string, never>;

export async function deploy(_options: DeployOptions = {}) {
  if (isAgent()) {
    await emitAgentDeployHandoff();
    return;
  }

  intro("clerk deploy");
  try {
    const ctx = await resolveDeployContext();
    await runDeploy(ctx);
  } catch (error) {
    if (error instanceof DeployPausedError && isInsideGutter()) {
      outro("Paused");
    }
    if (isPromptExitError(error) && isInsideGutter()) {
      pausedOutro(pausedOperationNotice());
      throw new UserAbortError();
    }
    throw error;
  } finally {
    // Successful and paused paths call outro themselves. This balances the
    // intro gutter if an unexpected error escapes.
    if (isInsideGutter()) {
      outro("Failed");
    }
  }
}

async function emitAgentDeployHandoff(): Promise<void> {
  const ctx = await resolveDeployContext();
  if (!ctx.appId || !ctx.developmentInstanceId) {
    throw new CliError(
      "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy`.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  const state = await resolveDeployState(ctx);
  const report = buildDeployStatusReport(state, null);
  log.data(JSON.stringify(report, null, 2));
}

async function runDeploy(ctx: DeployContext): Promise<void> {
  if (!ctx.appId || !ctx.developmentInstanceId) {
    throw new CliError(
      "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy`.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  if (ctx.productionInstanceId) {
    await reconcileExistingDeploy(ctx);
    return;
  }

  await startNewDeploy(ctx);
}

async function startNewDeploy(ctx: DeployContext): Promise<void> {
  const { descriptors: oauthProviders, unsupported }: DiscoveredOAuthProviders =
    await loadDevelopmentOAuthProviders(ctx);

  log.blank();
  log.info(INTRO_PREAMBLE);
  log.blank();
  for (const line of printPlan(ctx.appLabel, buildNewDeployPlan(oauthProviders))) {
    log.info(line);
  }
  log.blank();

  warnUnsupportedOAuthProviders(unsupported.length);
  const proceed = await confirmProceed();
  if (!proceed) {
    log.info("No changes were made.");
    outro("Cancelled");
    return;
  }

  bar();
  const domain = await collectCustomDomain();
  const shouldCreateProductionInstance = await confirmProductionInstanceCreation(domain);
  if (!shouldCreateProductionInstance) return;

  const productionOrExists = await createProductionInstance(ctx, domain);
  if (productionOrExists === "exists") {
    log.blank();
    log.info(
      "A production instance already exists for this application. Resuming the existing deploy.",
    );
    log.blank();
    const refreshed = await withSpinner("Refreshing application state...", () =>
      resolveLiveApplicationContext(ctx.profile),
    );
    ctx.productionInstanceId = refreshed.productionInstanceId;
    if (refreshed.productionInstanceId) {
      await persistProductionInstance(ctx, refreshed.productionInstanceId);
    }
    await reconcileExistingDeploy(ctx);
    return;
  }
  const production = productionOrExists;
  await persistProductionInstance(ctx, production.id);

  if (!production.active_domain) {
    throw new CliError(
      "Production instance was created but Clerk did not return a domain. " +
        "Run `clerk deploy` again to retry domain provisioning.",
    );
  }

  log.blank();

  const productionDomain = production.active_domain.name;
  const cnameTargets = production.active_domain.cname_targets ?? [];
  let completedOAuthProviders: OAuthProvider[] = [];
  const operationState: DeployOperationState = {
    appId: ctx.appId,
    developmentInstanceId: ctx.developmentInstanceId,
    productionInstanceId: production.id,
    productionDomainId: production.active_domain.id,
    domain: productionDomain,
    pending: { type: "oauth", provider: oauthProviders[0]?.provider ?? "google" },
    oauthProviders: oauthProviders.map((descriptor) => descriptor.provider),
    completedOAuthProviders,
    cnameTargets,
  };

  await runDnsRecordHandoff({ ...operationState, pending: { type: "dns" } }, cnameTargets);

  bar();
  completedOAuthProviders = await runOAuthSetup(ctx, operationState, oauthProviders);

  bar();
  const dnsStatus = await runDnsVerificationPrompt(ctx, {
    ...operationState,
    pending: { type: "dns" },
    completedOAuthProviders,
  });

  await finishDeploy(ctx, productionDomain, completedOAuthProviders, dnsStatus);
}

async function reconcileExistingDeploy(ctx: DeployContext): Promise<void> {
  if (ctx.productionInstanceId && ctx.profile.instances.production !== ctx.productionInstanceId) {
    await persistProductionInstance(ctx, ctx.productionInstanceId);
  }

  const snapshot = await resolveLiveDeploySnapshot(ctx);
  if (!snapshot) {
    log.blank();
    log.info("A production instance exists, but Clerk did not return a production domain yet.");
    log.info("Run `clerk deploy` again after the domain is available from the API.");
    outro("No deploy actions available");
    return;
  }

  log.blank();
  for (const line of printPlan(ctx.appLabel, buildLiveDeployPlan(snapshot))) {
    log.info(line);
  }
  log.blank();

  warnUnsupportedOAuthProviders(snapshot.unsupportedOAuthProviderCount);

  if (!snapshot.pending) {
    log.info("No deploy actions remain.");
    await finishDeploy(ctx, snapshot.domain, snapshot.completedOAuthProviders, "verified");
    return;
  }

  let dnsStatus: DnsVerificationResult = snapshot.domainComplete ? "verified" : "pending";

  if (
    snapshot.pending.type === "oauth" ||
    snapshot.oauthProviders.length > snapshot.completedOAuthProviders.length
  ) {
    bar();
    const completed = await runOAuthSetup(
      ctx,
      {
        ...snapshot,
        pending: {
          type: "oauth",
          provider:
            snapshot.oauthProviders.find(
              (provider) => !snapshot.completedOAuthProviders.includes(provider),
            ) ??
            snapshot.oauthProviders[0] ??
            "google",
        },
      },
      snapshot.oauthProviderDescriptors,
    );
    snapshot.completedOAuthProviders = completed;
  }

  if (!snapshot.domainComplete) {
    dnsStatus = await runExistingDomainDnsVerification(ctx, {
      ...snapshot,
      pending: { type: "dns" },
    });
  }

  await finishDeploy(ctx, snapshot.domain, snapshot.completedOAuthProviders, dnsStatus);
}

type DnsVerificationResult = "verified" | "pending";

function warnUnsupportedOAuthProviders(count: number): void {
  if (count === 0) return;

  const plural = count === 1 ? "" : "s";
  const verb = count === 1 ? "is" : "are";
  log.warn(
    `${count} OAuth provider${plural} ${verb} enabled in development but not yet supported by automated \`clerk deploy\` setup.`,
  );
  log.warn(
    "These providers may not have working production credentials. Configure them from the Clerk Dashboard before going live, or disable them in development first.",
  );
  log.blank();
}

function buildNewDeployPlan(oauthProviders: readonly OAuthProviderDescriptor[]): DeployPlanStep[] {
  return [
    { label: "Create production instance", status: "pending" },
    { label: "Choose a production domain you own", status: "pending" },
    ...oauthProviders.map((descriptor) => ({
      label: `Configure ${descriptor.label} OAuth credentials`,
      status: "pending" as const,
    })),
    { label: "Verify DNS records", status: "pending" },
  ];
}

function buildLiveDeployPlan(snapshot: LiveDeploySnapshot): DeployPlanStep[] {
  return [
    { label: "Create production instance", status: "done" },
    { label: `Use production domain ${snapshot.domain}`, status: "done" },
    ...snapshot.oauthProviderDescriptors.map((descriptor): DeployPlanStep => {
      const status: DeployPlanStep["status"] = snapshot.completedOAuthProviders.includes(
        descriptor.provider,
      )
        ? "done"
        : "pending";
      return {
        label: `Configure ${descriptor.label} OAuth credentials`,
        status,
      };
    }),
    { label: "Verify DNS records", status: snapshot.domainComplete ? "done" : "pending" },
  ];
}

async function createProductionInstance(
  ctx: DeployContext,
  domain: string,
): Promise<ProductionInstanceResponse | "exists"> {
  return withSpinner("Creating production instance...", async () => {
    return mapDeployError<ProductionInstanceResponse | "exists">(
      apiCreateProductionInstance(ctx.appId, {
        domain,
        environment_type: "production",
        clone_instance_id: ctx.developmentInstanceId,
      }),
      { onProductionInstanceExists: async () => "exists" },
    );
  });
}

async function confirmProductionInstanceCreation(domain: string): Promise<boolean> {
  for (const line of domainAssociationSummary(domain)) log.info(line);
  log.blank();
  const confirmed = await confirmCreateProductionInstance();
  if (confirmed) {
    log.blank();
    return true;
  }

  log.blank();
  log.info("No production instance was created.");
  outro("Cancelled");
  return false;
}

async function runDnsRecordHandoff(
  state: DeployOperationState,
  cnameTargets: readonly CnameTarget[],
): Promise<void> {
  for (const line of dnsIntro(state.domain)) log.info(line);
  log.blank();
  if (cnameTargets.length > 0) {
    for (const line of dnsRecords(cnameTargets)) log.info(line);
    log.blank();
  }

  for (const line of dnsDashboardHandoff(state.domain)) log.info(line);
  log.blank();
  try {
    await offerBindZoneExport(state.domain, cnameTargets);
    log.blank();
  } catch (error) {
    if (isPromptExitError(error)) {
      throw deployPausedError(state, { interrupted: true });
    }
    throw error;
  }
}

async function runExistingDomainDnsVerification(
  ctx: DeployContext,
  state: DeployOperationState,
): Promise<DnsVerificationResult> {
  await runDnsRecordHandoff(state, state.cnameTargets ?? []);
  return runDnsVerificationPrompt(ctx, state);
}

async function runDnsVerificationPrompt(
  ctx: DeployContext,
  state: DeployOperationState,
): Promise<DnsVerificationResult> {
  try {
    const action = await chooseDnsVerificationAction();
    if (action === "skip") {
      log.blank();
      log.info("Skipping DNS verification for now.");
      return "pending";
    }
    return await runDnsVerification(ctx, state);
  } catch (error) {
    if (isPromptExitError(error)) {
      throw deployPausedError(state, { interrupted: true });
    }
    throw error;
  }
}

async function runDnsVerification(
  ctx: DeployContext,
  state: DeployOperationState,
): Promise<DnsVerificationResult> {
  const domainIdOrName = state.productionDomainId ?? state.domain;

  while (true) {
    const outcome = await pollDeployStatus(ctx.appId, domainIdOrName, state.domain);

    if (outcome.verified) {
      log.blank();
      log.info(deployComponentStatus(outcome.status));
      return "verified";
    }

    log.blank();
    log.info(deployComponentStatus(outcome.status));
    log.blank();
    for (const line of deployStatusPendingFooter(state.domain, outcome.status)) {
      log.warn(line);
    }

    // When all DNS components are verified but the server has not yet marked the
    // deployment complete, the user cannot influence the remaining wait.
    if (outcome.status.dns && outcome.status.ssl && outcome.status.mail) {
      throw deployPausedError(state);
    }

    const pendingRecords = state.cnameTargets
      ? pendingDnsRecords(state.cnameTargets, outcome.status)
      : [];
    if (pendingRecords.length > 0) {
      log.blank();
      for (const line of pendingRecords) log.info(line);
    }
    log.blank();
    let action: Awaited<ReturnType<typeof chooseDnsVerificationRetryAction>>;
    try {
      action = await chooseDnsVerificationRetryAction();
    } catch (error) {
      if (isPromptExitError(error)) {
        throw deployPausedError(state, { interrupted: true });
      }
      throw error;
    }
    if (action === "skip") {
      log.blank();
      log.info("Skipping DNS verification for now.");
      return "pending";
    }
  }
}

async function pollDeployStatus(
  appId: string,
  domainIdOrName: string,
  domain: string,
): Promise<DeployStatusOutcome> {
  return waitForDeployStatus(appId, domainIdOrName, domain, {
    runVerification: (progressLabel, work) => withSpinner(progressLabel, work),
    onVerified: () => log.success(deployComponentLabels("dns", domain).done),
  });
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

/**
 * Configures every provider in `descriptors`, returning the full set of
 * completed providers. If the user skips a provider or interrupts the prompt,
 * this pauses by throwing `DeployPausedError` rather than returning a partial
 * list, so a successful return always means OAuth is fully complete.
 */
async function runOAuthSetup(
  ctx: DeployContext,
  state: DeployOperationState,
  descriptors: readonly OAuthProviderDescriptor[],
): Promise<OAuthProvider[]> {
  const completed = new Set(state.completedOAuthProviders as OAuthProvider[]);

  if (descriptors.length > 0) {
    log.info(OAUTH_SECTION_INTRO);
    log.blank();
  }

  for (const descriptor of descriptors) {
    if (completed.has(descriptor.provider)) continue;
    try {
      const productionInstanceId =
        state.productionInstanceId ?? ctx.productionInstanceId ?? ctx.profile.instances.production;
      if (!productionInstanceId) {
        throwUsageError(
          "Cannot save OAuth credentials because the production instance could not be resolved. Run `clerk deploy` after confirming the production instance in the Clerk Dashboard.",
        );
      }

      const saved = await collectAndSaveOAuthCredentials(
        ctx,
        descriptor,
        state.domain,
        productionInstanceId,
      );
      if (!saved) {
        throw deployPausedError({
          ...state,
          pending: { type: "oauth", provider: descriptor.provider },
          completedOAuthProviders: [...completed],
        });
      }
    } catch (error) {
      if (isPromptExitError(error)) {
        throw deployPausedError(
          {
            ...state,
            pending: { type: "oauth", provider: descriptor.provider },
            completedOAuthProviders: [...completed],
          },
          { interrupted: true },
        );
      }
      throw error;
    }
    completed.add(descriptor.provider);
    if (descriptors.some((nextDescriptor) => !completed.has(nextDescriptor.provider))) {
      log.blank();
    }
  }

  return [...completed];
}

async function collectAndSaveOAuthCredentials(
  ctx: DeployContext,
  descriptor: OAuthProviderDescriptor,
  domain: string,
  productionInstanceId: string,
): Promise<boolean> {
  for (const line of providerSetupIntro(descriptor)) log.info(line);
  log.blank();

  let choice = await chooseOAuthCredentialAction(descriptor);

  if (choice === "skip") {
    return false;
  }

  if (choice === "walkthrough") {
    await showOAuthWalkthrough(descriptor, domain);
    choice = await chooseOAuthCredentialAction(descriptor, { includeWalkthrough: false });
    if (choice === "skip") {
      return false;
    }
  }

  const credentials = await collectOAuthCredentials(
    descriptor,
    choice === "google-json" ? "google-json" : "manual",
  );

  await withSpinner(`Saving ${descriptor.label} OAuth credentials...`, async () => {
    await patchInstanceConfig(ctx.appId, productionInstanceId, {
      [descriptor.configKey]: {
        enabled: true,
        ...credentials,
      },
    });
  });
  log.success(`Saved ${descriptor.label} OAuth credentials`);
  return true;
}

async function persistProductionInstance(ctx: DeployContext, productionInstanceId: string) {
  await setProfile(ctx.profileKey, {
    ...ctx.profile,
    instances: {
      ...ctx.profile.instances,
      production: productionInstanceId,
    },
  });
  ctx.profile.instances.production = productionInstanceId;
  ctx.productionInstanceId = productionInstanceId;
}

async function finishDeploy(
  ctx: DeployContext,
  domain: string,
  completedOAuthProviders: readonly string[],
  dnsStatus: DnsVerificationResult,
): Promise<void> {
  log.blank();
  for (const line of productionSummary(
    domain,
    completedOAuthProviders.map((provider) => providerLabel(provider)),
    dnsStatus,
  )) {
    log.info(line);
  }
  log.blank();
  const productionInstanceId = ctx.productionInstanceId ?? ctx.profile.instances.production;
  if (!productionInstanceId) {
    throwUsageError(
      "Cannot print deploy next steps because the production instance could not be resolved. Run `clerk deploy` after confirming the production instance in the Clerk Dashboard.",
    );
  }
  await animateHeader({
    prefix: isInsideGutter() ? `${dim("│")}  ` : "",
    label: "Next steps",
    fallback: bold,
  });
  log.info(nextStepsBody(ctx.appId, productionInstanceId));
  outro("Success");
}

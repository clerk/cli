import { isAgent } from "../../mode.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import { sleep } from "../../lib/sleep.ts";
import { bar, intro, outro, withSpinner, type SpinnerControls } from "../../lib/spinner.ts";
import {
  CliError,
  ERROR_CODE,
  PlapiError,
  UserAbortError,
  isPromptExitError,
  throwUsageError,
} from "../../lib/errors.ts";
import { resolveProfile, setProfile } from "../../lib/config.ts";
import {
  createProductionInstance as apiCreateProductionInstance,
  fetchApplication,
  fetchInstanceConfig,
  fetchInstanceConfigSchema,
  getApplicationDomainStatus,
  listApplicationDomains,
  patchInstanceConfig,
  triggerApplicationDomainDNSCheck,
  type ApplicationDomain,
  type CnameTarget,
  type DomainStatusResponse,
  type ProductionInstanceResponse,
} from "../../lib/plapi.ts";
import {
  INTRO_PREAMBLE,
  OAUTH_SECTION_INTRO,
  type DeployComponentStatus,
  type DeployPlanStep,
  DEPLOY_COMPONENT_ORDER,
  deployComponentLabels,
  deployComponentStatus,
  deployStatusRetryMessage,
  deployStatusPendingFooter,
  domainAssociationSummary,
  bindZoneFile,
  dnsDashboardHandoff,
  dnsIntro,
  dnsRecords,
  nextStepsBlock,
  pendingDnsRecords,
  printPlan,
  productionSummary,
} from "./copy.ts";
import { mapDeployError } from "./errors.ts";
import {
  OAUTH_KEY_PREFIX,
  buildOAuthProviderDescriptors,
  hasProviderRequiredCredentials,
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

const DEPLOY_STATUS_INITIAL_RETRY_DELAY_MS = 3000;
const DEPLOY_STATUS_MAX_RETRIES = 5;
const DEPLOY_STATUS_BACKOFF_FACTOR = 2;

type DeployOptions = Record<string, never>;

export async function deploy(_options: DeployOptions = {}) {
  if (isAgent()) {
    throwUsageError(
      "clerk deploy requires human mode because production configuration uses interactive prompts. Run `clerk deploy --mode human` from an interactive terminal.",
    );
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
      outro("Cancelled");
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

async function resolveDeployContext(): Promise<DeployContext> {
  const resolved = await withSpinner("Resolving linked Clerk application...", () =>
    resolveProfile(process.cwd()),
  );
  if (!resolved) {
    return {
      profileKey: process.cwd(),
      profile: {
        workspaceId: "",
        appId: "",
        instances: { development: "" },
      },
      appId: "",
      appLabel: "",
      developmentInstanceId: "",
    };
  }

  return {
    profileKey: resolved.path,
    profile: resolved.profile,
    ...(await withSpinner("Checking for production instance...", () =>
      resolveLiveApplicationContext(resolved.profile),
    )),
  };
}

async function resolveLiveApplicationContext(profile: DeployContext["profile"]): Promise<{
  appId: string;
  appLabel: string;
  developmentInstanceId: string;
  productionInstanceId?: string;
}> {
  const app = await fetchApplication(profile.appId);
  const development = app.instances.find((entry) => entry.environment_type === "development");
  const production = app.instances.find((entry) => entry.environment_type === "production");
  return {
    appId: app.application_id,
    appLabel: app.name || profile.appName || app.application_id,
    developmentInstanceId: development?.instance_id ?? profile.instances.development,
    productionInstanceId: production?.instance_id,
  };
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
  const { descriptors: oauthProviders, unsupported } = await loadDevelopmentOAuthProviders(ctx);

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
  if (completedOAuthProviders.length < oauthProviders.length) return;

  bar();
  const dnsStatus = await runDnsVerificationPrompt(ctx, {
    ...operationState,
    pending: { type: "dns" },
    completedOAuthProviders,
  });

  await finishDeploy(ctx, productionDomain, completedOAuthProviders, dnsStatus);
}

async function reconcileExistingDeploy(ctx: DeployContext): Promise<void> {
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

  let dnsStatus: DnsVerificationResult = snapshot.dnsComplete ? "verified" : "pending";

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
    if (completed.length < snapshot.oauthProviders.length) return;
    snapshot.completedOAuthProviders = completed;
  }

  if (!snapshot.dnsComplete) {
    const nextDnsStatus = await runExistingDomainDnsVerification(ctx, {
      ...snapshot,
      pending: { type: "dns" },
    });
    dnsStatus = nextDnsStatus;
  }

  await finishDeploy(ctx, snapshot.domain, snapshot.completedOAuthProviders, dnsStatus);
}

type LiveDeploySnapshot = Omit<
  DeployOperationState,
  "pending" | "oauthProviders" | "completedOAuthProviders"
> & {
  pending?: DeployOperationState["pending"];
  oauthProviders: OAuthProvider[];
  oauthProviderDescriptors: OAuthProviderDescriptor[];
  completedOAuthProviders: OAuthProvider[];
  cnameTargets?: readonly CnameTarget[];
  dnsComplete: boolean;
  unsupportedOAuthProviderCount: number;
};

type DiscoveredOAuthProviders = {
  descriptors: OAuthProviderDescriptor[];
  unsupported: string[];
};

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

async function loadDevelopmentOAuthProviders(
  ctx: DeployContext,
): Promise<DiscoveredOAuthProviders> {
  return withSpinner("Reading development configuration...", async () => {
    const config = await fetchInstanceConfig(ctx.appId, ctx.developmentInstanceId);
    const providerSlugs = discoverEnabledOAuthProviderSlugs(config);
    const schemaKeys = providerSlugs.map((provider) => `${OAUTH_KEY_PREFIX}${provider}`);
    const schema =
      schemaKeys.length > 0
        ? await fetchInstanceConfigSchema(ctx.appId, ctx.developmentInstanceId, schemaKeys)
        : { properties: {} };
    const result = buildOAuthProviderDescriptors(providerSlugs, schema);
    return {
      descriptors: result.supported,
      unsupported: result.unsupported,
    };
  });
}

async function resolveLiveDeploySnapshot(
  ctx: DeployContext,
): Promise<LiveDeploySnapshot | undefined> {
  const productionInstanceId = ctx.productionInstanceId;
  if (!productionInstanceId) return undefined;

  const [domain, oauth] = await Promise.all([
    loadProductionDomain(ctx),
    loadDevelopmentOAuthProviders(ctx),
  ]);
  if (!domain) return undefined;

  const { descriptors: oauthProviderDescriptors, unsupported } = oauth;
  const oauthProviders = oauthProviderDescriptors.map((descriptor) => descriptor.provider);
  const { productionConfig, deployStatus } = await loadProductionState(
    ctx,
    productionInstanceId,
    domain.id,
  );
  const completedOAuthProviders = oauthProviderDescriptors
    .filter((descriptor) => hasProviderRequiredCredentials(productionConfig, descriptor))
    .map((descriptor) => descriptor.provider);
  const pendingOAuthDescriptor = oauthProviderDescriptors.find(
    (descriptor) => !completedOAuthProviders.includes(descriptor.provider),
  );

  const baseState = {
    appId: ctx.appId,
    developmentInstanceId: ctx.developmentInstanceId,
    productionInstanceId,
    productionDomainId: domain.id,
    domain: domain.name,
    oauthProviders,
    oauthProviderDescriptors,
    completedOAuthProviders,
    cnameTargets: domain.cname_targets ?? [],
    unsupportedOAuthProviderCount: unsupported.length,
  };

  const dnsComplete = deployStatus.status === "complete";
  const pending = pendingOAuthDescriptor
    ? ({ type: "oauth", provider: pendingOAuthDescriptor.provider } as const)
    : !dnsComplete
      ? ({ type: "dns" } as const)
      : undefined;

  return { ...baseState, dnsComplete, pending };
}

async function loadInitialDeployStatus(
  appId: string,
  domainIdOrName: string,
): Promise<DomainStatusResponse> {
  try {
    return await getApplicationDomainStatus(appId, domainIdOrName);
  } catch (error) {
    log.debug(
      `deploy: snapshot domain-status read failed, treating DNS as pending: ${error instanceof Error ? error.message : String(error)}`,
    );
    return pendingDomainStatus();
  }
}

async function loadProductionState(
  ctx: DeployContext,
  productionInstanceId: string,
  domainIdOrName: string,
): Promise<{
  productionConfig: Record<string, unknown>;
  deployStatus: DomainStatusResponse;
}> {
  return withSpinner("Reading production configuration...", async () => {
    const [productionConfig, deployStatus] = await Promise.all([
      fetchInstanceConfig(ctx.appId, productionInstanceId),
      loadInitialDeployStatus(ctx.appId, domainIdOrName),
    ]);
    return { productionConfig, deployStatus };
  });
}

function pendingDomainStatus(): DomainStatusResponse {
  return {
    status: "incomplete",
    dns: { status: "not_started" },
    ssl: { status: "not_started", required: true },
    mail: { status: "not_started", required: true },
  };
}

async function loadProductionDomain(ctx: DeployContext): Promise<ApplicationDomain | undefined> {
  const domains = await listApplicationDomains(ctx.appId);
  return domains.data.find((domain) => !domain.is_satellite) ?? domains.data[0];
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
    { label: "Verify DNS records", status: snapshot.dnsComplete ? "done" : "pending" },
  ];
}

function discoverEnabledOAuthProviderSlugs(config: Record<string, unknown>): string[] {
  const providers: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith(OAUTH_KEY_PREFIX)) continue;
    if (!value || typeof value !== "object") continue;
    if ((value as Record<string, unknown>).enabled !== true) continue;
    providers.push(key.slice(OAUTH_KEY_PREFIX.length));
  }
  return providers;
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

type DeployStatusOutcome =
  | { verified: true; status: DeployComponentStatus }
  | { verified: false; status: DeployComponentStatus };

async function pollDeployStatus(
  appId: string,
  domainIdOrName: string,
  domain: string,
): Promise<DeployStatusOutcome> {
  await triggerDeployStatusCheck(appId, domainIdOrName);
  let response = await mapDeployError(getApplicationDomainStatus(appId, domainIdOrName));
  let status = deployComponentStatusFromDomainStatus(response);
  for (const component of DEPLOY_COMPONENT_ORDER) {
    let retriesRemaining = DEPLOY_STATUS_MAX_RETRIES;
    let nextRetryDelay = DEPLOY_STATUS_INITIAL_RETRY_DELAY_MS;
    const labels = deployComponentLabels(component, domain);
    const flipped = await withSpinner(labels.progress, async (spinner) => {
      if (status[component]) return true;
      while (retriesRemaining > 0) {
        await sleepWithRetryCountdown(
          labels.progress,
          DEPLOY_STATUS_MAX_RETRIES - retriesRemaining + 1,
          DEPLOY_STATUS_MAX_RETRIES,
          nextRetryDelay,
          spinner,
        );
        retriesRemaining--;
        nextRetryDelay *= DEPLOY_STATUS_BACKOFF_FACTOR;
        response = await mapDeployError(getApplicationDomainStatus(appId, domainIdOrName));
        status = deployComponentStatusFromDomainStatus(response);
        if (status[component]) return true;
      }
      return false;
    });
    if (!flipped) return { verified: false, status };
    log.success(labels.done);
  }

  if (response.status !== "complete") {
    return { verified: false, status };
  }
  return { verified: true, status };
}

async function sleepWithRetryCountdown(
  message: string,
  currentRetry: number,
  totalRetries: number,
  delayMs: number,
  spinner: SpinnerControls,
): Promise<void> {
  let remainingMs = delayMs;
  while (remainingMs > 0) {
    const tickMs = Math.min(1000, remainingMs);
    spinner.update(
      deployStatusRetryMessage(message, currentRetry, totalRetries, Math.ceil(remainingMs / 1000)),
    );
    await sleep(tickMs);
    remainingMs -= tickMs;
  }
}

async function triggerDeployStatusCheck(appId: string, domainIdOrName: string): Promise<void> {
  try {
    await mapDeployError(triggerApplicationDomainDNSCheck(appId, domainIdOrName));
  } catch (error) {
    if (error instanceof PlapiError && error.status === 409 && error.code === "conflict") {
      log.debug("DNS check is already in flight; continuing to poll domain status.");
      return;
    }
    throw error;
  }
}

function deployComponentStatusFromDomainStatus(
  response: DomainStatusResponse,
): DeployComponentStatus {
  return {
    dns: checkStatusComplete(response.dns),
    ssl: checkStatusComplete(response.ssl),
    mail: checkStatusComplete(response.mail),
  };
}

function checkStatusComplete(check: { status: string; required?: boolean } | undefined): boolean {
  if (!check) return false;
  if (check.required === false) return true;
  return check.status === "complete";
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

  const choice = await chooseOAuthCredentialAction(descriptor);

  if (choice === "skip") {
    return false;
  }

  if (choice === "walkthrough") {
    await showOAuthWalkthrough(descriptor, domain);
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
  log.info(nextStepsBlock(ctx.appId, productionInstanceId));
  outro("Success");
}

import { isAgent } from "../../mode.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import { sleep } from "../../lib/sleep.ts";
import { bar, intro, outro, withSpinner } from "../../lib/spinner.ts";
import {
  CliError,
  PlapiError,
  UserAbortError,
  isPromptExitError,
  throwUsageError,
} from "../../lib/errors.ts";
import { resolveProfile, setProfile } from "../../lib/config.ts";
import {
  fetchApplication,
  fetchInstanceConfig,
  listApplicationDomains,
  type ApplicationDomain,
} from "../../lib/plapi.ts";
import {
  configureMockDeployApi,
  createProductionInstance as apiCreateProductionInstance,
  getDeployStatus,
  patchInstanceConfig,
  validateCloning,
  type CnameTarget,
  type ProductionInstanceResponse,
} from "./api.ts";
import {
  mockProductionDomain,
  mockProductionInstanceConfig,
  resolveTestDeployFlags,
  simulatedDeployApiFailure,
  withMockProductionInstance,
  withTestFailureAfterApiCall,
  type DeployTestFlags,
} from "./mock.ts";
import { domainConnectUrl } from "./domain-connect.ts";
import {
  INTRO_PREAMBLE,
  NEXT_STEPS_BLOCK,
  OAUTH_SECTION_INTRO,
  type DeployPlanStep,
  domainAssociationSummary,
  dnsDashboardHandoff,
  dnsIntro,
  dnsRecords,
  dnsVerified,
  pausedOperationNotice,
  printPlan,
  productionSummary,
} from "./copy.ts";
import {
  PROVIDER_LABELS,
  PROVIDER_FIELDS,
  providerLabel,
  providerSetupIntro,
  showOAuthWalkthrough,
  type OAuthProvider,
} from "./providers.ts";
import {
  chooseDnsVerificationAction,
  chooseOAuthCredentialAction,
  collectCustomDomain,
  collectOAuthCredentials,
  confirmContinueAfterDnsHandoff,
  confirmCreateProductionInstance,
  confirmProceed,
} from "./prompts.ts";
import {
  DeployPausedError,
  deployPausedError,
  type DeployContext,
  type DeployOperationState,
} from "./state.ts";

type DeployOptions = {
  debug?: boolean;
  testForceProductionInstance?: boolean;
  testFailProductionInstanceCheck?: boolean;
  testFailDomainLookup?: boolean;
  testFailValidateCloning?: boolean;
  testFailCreateProductionInstance?: boolean;
  testFailCreateProductionInstanceExists?: boolean;
  testFailValidateCloningUnsupportedFeatures?: string[];
  testFailDnsVerification?: boolean;
  testFailOAuthSave?: boolean;
};

const DEPLOY_STATUS_POLL_INTERVAL_MS = 3000;
const DEPLOY_STATUS_MAX_POLLS = 100;

export async function deploy(options: DeployOptions = {}) {
  if (isAgent()) {
    throwUsageError(
      "clerk deploy requires human mode because production configuration uses interactive prompts. Run `clerk deploy --mode human` from an interactive terminal.",
    );
  }
  if (options.debug) {
    const { setLogLevel } = await import("../../lib/log.ts");
    setLogLevel("debug");
  }

  intro("clerk deploy");
  try {
    const ctx = await resolveDeployContext(options);
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

async function resolveDeployContext(options: DeployOptions): Promise<DeployContext> {
  const testFlags = resolveTestDeployFlags(options);
  configureDeployApiMocks(testFlags);
  const resolved = await withSpinner("Resolving linked Clerk application...", () =>
    resolveProfile(process.cwd()),
  );
  const commandTestFlags = resolveCommandTestFlags(testFlags);
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
      ...commandTestFlags,
    };
  }

  return {
    profileKey: resolved.path,
    profile: resolved.profile,
    ...commandTestFlags,
    ...(await withSpinner("Checking for production instance...", () =>
      withTestFailureAfterApiCall(
        resolveLiveApplicationContext(resolved.profile, {
          forceMockProductionInstance: testFlags.testForceProductionInstance,
        }),
        testFlags.testFailProductionInstanceCheck,
        "production instance check",
      ),
    )),
  };
}

function resolveCommandTestFlags(
  testFlags: DeployTestFlags,
): Pick<
  DeployContext,
  "testForceProductionInstance" | "testFailProductionInstanceCheck" | "testFailDomainLookup"
> {
  return {
    testForceProductionInstance: testFlags.testForceProductionInstance,
    testFailProductionInstanceCheck: testFlags.testFailProductionInstanceCheck,
    testFailDomainLookup: testFlags.testFailDomainLookup,
  };
}

function configureDeployApiMocks(testFlags: DeployTestFlags): void {
  configureMockDeployApi({
    failValidateCloning: testFlags.testFailValidateCloning,
    failCreateProductionInstance: testFlags.testFailCreateProductionInstance,
    failCreateProductionInstanceExists: testFlags.testFailCreateProductionInstanceExists,
    failValidateCloningUnsupportedFeatures: testFlags.testFailValidateCloningUnsupportedFeatures,
    failDnsVerification: testFlags.testFailDnsVerification,
    failOAuthSave: testFlags.testFailOAuthSave,
  });
}

async function resolveLiveApplicationContext(
  profile: DeployContext["profile"],
  options: { forceMockProductionInstance?: boolean } = {},
): Promise<{
  appId: string;
  appLabel: string;
  developmentInstanceId: string;
  productionInstanceId?: string;
}> {
  const fetchedApp = await fetchApplication(profile.appId);
  const app = options.forceMockProductionInstance
    ? withMockProductionInstance(fetchedApp)
    : fetchedApp;
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
    log.blank();
    log.warn(
      "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy`.",
    );
    outro("Link required");
    return;
  }

  if (ctx.productionInstanceId) {
    await reconcileExistingDeploy(ctx);
    return;
  }

  await startNewDeploy(ctx);
}

async function startNewDeploy(ctx: DeployContext): Promise<void> {
  const { known: oauthProviders, unknown: unknownOAuthProviders } =
    await loadDevelopmentOAuthProviders(ctx);

  await runValidateCloning(ctx);

  log.blank();
  log.info(INTRO_PREAMBLE);
  log.blank();
  for (const line of printPlan(ctx.appLabel, buildNewDeployPlan(oauthProviders))) {
    log.info(line);
  }
  log.blank();

  if (unknownOAuthProviders.length > 0) {
    log.warn(
      `These OAuth providers are enabled in development but not yet supported by \`clerk deploy\`: ${unknownOAuthProviders.join(", ")}.`,
    );
    log.warn(
      "They will be cloned to production without working credentials. Configure them from the Clerk Dashboard before going live, or disable them in development first.",
    );
    log.blank();
  }

  const proceed = await confirmProceed();
  if (!proceed) {
    log.info("No changes were made.");
    outro("Cancelled");
    return;
  }

  bar();
  const domain = await collectCustomDomain();
  const plannedCnameTargets = plannedProductionCnameTargets(domain);
  const shouldCreateProductionInstance = await confirmProductionInstanceCreation(
    domain,
    plannedCnameTargets,
  );
  if (!shouldCreateProductionInstance) return;

  let production: ProductionInstanceResponse;
  try {
    production = await createProductionInstance(ctx, domain);
  } catch (error) {
    if (error instanceof PlapiError && error.code === "production_instance_exists") {
      log.info("A production instance already exists for this application. Resuming…");
      const reconciledCtx = await reloadProductionState(ctx);
      await reconcileExistingDeploy(reconciledCtx);
      return;
    }
    throw error;
  }
  await persistProductionInstance(ctx, production.instance_id);

  if (!production.active_domain) {
    throw new CliError(
      "Production instance was created but Clerk did not return a domain. " +
        "Run `clerk deploy` again to retry domain provisioning.",
    );
  }

  log.blank();

  const productionDomain = production.active_domain.name;
  let completedOAuthProviders: OAuthProvider[] = [];
  const dnsStatus = await runDnsSetup(
    ctx,
    {
      appId: ctx.appId,
      developmentInstanceId: ctx.developmentInstanceId,
      productionInstanceId: production.instance_id,
      productionDomainId: production.active_domain.id,
      domain: productionDomain,
      pending: { type: "dns" },
      oauthProviders,
      completedOAuthProviders,
    },
    production.cname_targets,
  );
  if (!dnsStatus) return;

  bar();
  completedOAuthProviders = await runOAuthSetup(ctx, {
    appId: ctx.appId,
    developmentInstanceId: ctx.developmentInstanceId,
    productionInstanceId: production.instance_id,
    productionDomainId: production.active_domain.id,
    domain: productionDomain,
    pending: { type: "oauth", provider: oauthProviders[0] ?? "google" },
    oauthProviders,
    completedOAuthProviders,
  });
  if (completedOAuthProviders.length < oauthProviders.length) return;

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

  if (!snapshot.pending) {
    log.info("No deploy actions remain.");
    await finishDeploy(ctx, snapshot.domain, snapshot.completedOAuthProviders, "verified");
    return;
  }

  let dnsStatus: DnsVerificationResult = snapshot.dnsComplete ? "verified" : "pending";
  if (snapshot.pending.type === "dns") {
    const nextDnsStatus = await runExistingDomainDnsVerification(
      ctx,
      snapshotToOperationState(snapshot, { type: "dns" }),
    );
    if (!nextDnsStatus) return;
    dnsStatus = nextDnsStatus;
  }

  if (
    snapshot.pending.type === "oauth" ||
    snapshot.oauthProviders.length > snapshot.completedOAuthProviders.length
  ) {
    bar();
    const completed = await runOAuthSetup(
      ctx,
      snapshotToOperationState(snapshot, {
        type: "oauth",
        provider:
          snapshot.oauthProviders.find(
            (provider) => !snapshot.completedOAuthProviders.includes(provider),
          ) ??
          snapshot.oauthProviders[0] ??
          "google",
      }),
    );
    if (completed.length < snapshot.oauthProviders.length) return;
    snapshot.completedOAuthProviders = completed;
  }

  await finishDeploy(ctx, snapshot.domain, snapshot.completedOAuthProviders, dnsStatus);
}

type LiveDeploySnapshot = Omit<
  DeployOperationState,
  "pending" | "oauthProviders" | "completedOAuthProviders"
> & {
  pending?: DeployOperationState["pending"];
  oauthProviders: OAuthProvider[];
  completedOAuthProviders: OAuthProvider[];
  cnameTargets?: readonly CnameTarget[];
  dnsComplete: boolean;
};

type DiscoveredOAuthProviders = {
  known: OAuthProvider[];
  unknown: string[];
};

type DnsVerificationResult = "verified" | "pending";

async function loadDevelopmentOAuthProviders(
  ctx: DeployContext,
): Promise<DiscoveredOAuthProviders> {
  return withSpinner("Reading development configuration...", async () => {
    const config = await fetchInstanceConfig(ctx.appId, ctx.developmentInstanceId);
    return discoverEnabledOAuthProviders(config);
  });
}

async function resolveLiveDeploySnapshot(
  ctx: DeployContext,
): Promise<LiveDeploySnapshot | undefined> {
  const productionInstanceId = ctx.productionInstanceId;
  if (!productionInstanceId) return undefined;

  const domain = await loadProductionDomain(ctx);
  if (!domain) return undefined;

  const productionConfigPromise = ctx.testForceProductionInstance
    ? Promise.resolve(mockProductionInstanceConfig())
    : fetchInstanceConfig(ctx.appId, productionInstanceId);
  const [{ known: oauthProviders }, productionConfig, deployStatus] = await Promise.all([
    loadDevelopmentOAuthProviders(ctx),
    productionConfigPromise,
    getDeployStatus(ctx.appId, productionInstanceId),
  ]);
  const completedOAuthProviders = oauthProviders.filter((provider) =>
    hasProductionOAuthCredentials(productionConfig, provider),
  );
  const pendingOAuthProvider = oauthProviders.find(
    (provider) => !completedOAuthProviders.includes(provider),
  );

  const baseState = {
    appId: ctx.appId,
    developmentInstanceId: ctx.developmentInstanceId,
    productionInstanceId,
    productionDomainId: domain.id,
    domain: domain.name,
    oauthProviders,
    completedOAuthProviders,
    cnameTargets: domain.cname_targets ?? [],
  };

  const dnsComplete = deployStatus.status === "complete";
  const pending = !dnsComplete
    ? ({ type: "dns" } as const)
    : pendingOAuthProvider
      ? ({ type: "oauth", provider: pendingOAuthProvider } as const)
      : undefined;

  return { ...baseState, dnsComplete, pending };
}

async function loadProductionDomain(ctx: DeployContext): Promise<ApplicationDomain | undefined> {
  if (ctx.testForceProductionInstance) {
    return mockProductionDomain();
  }
  const domains = await listApplicationDomains(ctx.appId);
  if (ctx.testFailDomainLookup) {
    throw simulatedDeployApiFailure("production domain lookup");
  }
  return domains.data.find((domain) => !domain.is_satellite) ?? domains.data[0];
}

function hasProductionOAuthCredentials(
  config: Record<string, unknown>,
  provider: OAuthProvider,
): boolean {
  const value = config[`${OAUTH_KEY_PREFIX}${provider}`];
  if (!value || typeof value !== "object") return false;
  const providerConfig = value as Record<string, unknown>;
  if (providerConfig.enabled !== true) return false;
  return PROVIDER_FIELDS[provider].every((field) => {
    const fieldValue = providerConfig[field.key];
    return typeof fieldValue === "string" && fieldValue.length > 0;
  });
}

const OAUTH_KEY_PREFIX = "connection_oauth_";

function buildNewDeployPlan(oauthProviders: readonly OAuthProvider[]): DeployPlanStep[] {
  return [
    { label: "Create production instance", status: "pending" },
    { label: "Choose a production domain you own", status: "pending" },
    { label: "Configure DNS records", status: "pending" },
    ...oauthProviders.map((provider) => ({
      label: `Configure ${PROVIDER_LABELS[provider]} OAuth credentials`,
      status: "pending" as const,
    })),
  ];
}

function buildLiveDeployPlan(snapshot: LiveDeploySnapshot): DeployPlanStep[] {
  return [
    { label: "Create production instance", status: "done" },
    { label: `Use production domain ${snapshot.domain}`, status: "done" },
    { label: "Configure DNS records", status: snapshot.dnsComplete ? "done" : "pending" },
    ...snapshot.oauthProviders.map((provider): DeployPlanStep => {
      const status: DeployPlanStep["status"] = snapshot.completedOAuthProviders.includes(provider)
        ? "done"
        : "pending";
      return {
        label: `Configure ${PROVIDER_LABELS[provider]} OAuth credentials`,
        status,
      };
    }),
  ];
}

function snapshotToOperationState(
  snapshot: LiveDeploySnapshot,
  pending: DeployOperationState["pending"],
): DeployOperationState {
  return {
    appId: snapshot.appId,
    developmentInstanceId: snapshot.developmentInstanceId,
    productionInstanceId: snapshot.productionInstanceId,
    productionDomainId: snapshot.productionDomainId,
    domain: snapshot.domain,
    pending,
    oauthProviders: snapshot.oauthProviders,
    completedOAuthProviders: snapshot.completedOAuthProviders,
    cnameTargets: snapshot.cnameTargets,
  };
}

function discoverEnabledOAuthProviders(config: Record<string, unknown>): DiscoveredOAuthProviders {
  const known: OAuthProvider[] = [];
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith(OAUTH_KEY_PREFIX)) continue;
    if (!value || typeof value !== "object") continue;
    if ((value as Record<string, unknown>).enabled !== true) continue;
    const provider = key.slice(OAUTH_KEY_PREFIX.length);
    if (provider in PROVIDER_LABELS) {
      known.push(provider as OAuthProvider);
    } else {
      unknown.push(provider);
    }
  }
  return { known, unknown };
}

async function runValidateCloning(ctx: DeployContext): Promise<void> {
  await withSpinner("Validating subscription compatibility...", async () => {
    try {
      await validateCloning(ctx.appId, { clone_instance_id: ctx.developmentInstanceId });
    } catch (error) {
      if (error instanceof PlapiError && error.code === "unsupported_subscription_plan_features") {
        const features = Array.isArray(error.meta?.unsupported_features)
          ? (error.meta.unsupported_features as string[])
          : [];
        const featureList = features.length > 0 ? features.join(", ") : "this plan";
        throw new CliError(
          `Your subscription plan doesn't support: ${featureList}.\n` +
            "Upgrade your plan or disable these features in development before deploying.",
          { docsUrl: "https://clerk.com/docs/billing/plans" },
        );
      }
      throw error;
    }
  });
}

async function createProductionInstance(
  ctx: DeployContext,
  domain: string,
): Promise<ProductionInstanceResponse> {
  return withSpinner("Creating production instance...", async () => {
    return apiCreateProductionInstance(ctx.appId, {
      home_url: domain,
      clone_instance_id: ctx.developmentInstanceId,
    });
  });
}

function plannedProductionCnameTargets(domain: string): CnameTarget[] {
  return [
    { host: `clerk.${domain}`, value: "frontend-api.clerk.services", required: true },
    { host: `accounts.${domain}`, value: "accounts.clerk.services", required: true },
    {
      host: `clkmail.${domain}`,
      value: `mail.${domain}.nam1.clerk.services`,
      required: true,
    },
  ];
}

async function confirmProductionInstanceCreation(
  domain: string,
  cnameTargets: readonly CnameTarget[],
): Promise<boolean> {
  for (const line of domainAssociationSummary(domain, cnameTargets)) log.info(line);
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

async function runDnsSetup(
  ctx: DeployContext,
  state: DeployOperationState,
  cnameTargets: readonly CnameTarget[],
): Promise<DnsVerificationResult | false> {
  for (const line of dnsIntro(state.domain)) log.info(line);
  log.blank();
  for (const line of dnsRecords(cnameTargets)) log.info(line);
  log.blank();

  const connectUrl = domainConnectUrl(state.domain);
  if (connectUrl) {
    log.info(`Domain Connect: ${connectUrl}`);
    log.blank();
  }

  for (const line of dnsDashboardHandoff(state.domain)) log.info(line);
  log.blank();
  try {
    const continueSetup = await confirmContinueAfterDnsHandoff();
    if (!continueSetup) {
      log.blank();
      log.info(pausedOperationNotice());
      outro("Paused");
      return false;
    }
    return await runDnsVerification(ctx, { ...state, cnameTargets });
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
): Promise<DnsVerificationResult | false> {
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
  const productionInstanceId =
    state.productionInstanceId ?? ctx.productionInstanceId ?? ctx.profile.instances.production;
  if (!productionInstanceId) {
    throwUsageError(
      "Cannot verify DNS because the production instance could not be resolved. Run `clerk deploy` after confirming the production instance in the Clerk Dashboard.",
    );
  }

  const verified = await withSpinner(`Verifying DNS for ${state.domain}...`, async () => {
    for (let attempt = 0; attempt < DEPLOY_STATUS_MAX_POLLS; attempt++) {
      const result = await getDeployStatus(ctx.appId, productionInstanceId);
      if (result.status === "complete") return true;
      await sleep(DEPLOY_STATUS_POLL_INTERVAL_MS);
    }
    return false;
  });

  if (!verified) {
    log.blank();
    log.warn(
      `DNS, SSL, or mail verification is still pending for ${state.domain}. ` +
        "Run `clerk deploy` again once DNS has propagated, or check the dashboard for the failing component.",
    );
    log.info(
      "DNS propagation can take time. Some providers may take several hours to serve the new records everywhere.",
    );
    if (state.cnameTargets && state.cnameTargets.length > 0) {
      log.blank();
      for (const line of dnsRecords(state.cnameTargets)) log.info(line);
    }
    log.blank();
    const action = await chooseDnsVerificationAction();
    if (action === "skip") {
      log.blank();
      log.info("Skipping DNS verification for now.");
      return "pending";
    }
    return runDnsVerification(ctx, state);
  }

  log.blank();
  for (const line of dnsVerified(state.domain)) log.success(line);
  return "verified";
}

async function runOAuthSetup(
  ctx: DeployContext,
  state: DeployOperationState,
): Promise<OAuthProvider[]> {
  const completed = new Set(state.completedOAuthProviders as OAuthProvider[]);
  const startIndex =
    state.pending.type === "oauth"
      ? Math.max(0, state.oauthProviders.indexOf(state.pending.provider as OAuthProvider))
      : 0;

  if (state.oauthProviders.length > 0) {
    log.info(OAUTH_SECTION_INTRO);
    log.blank();
  }

  const pendingProviders = state.oauthProviders.slice(startIndex) as OAuthProvider[];
  for (const provider of pendingProviders) {
    if (completed.has(provider)) continue;
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
        provider,
        state.domain,
        productionInstanceId,
      );
      if (!saved) {
        log.blank();
        log.info(pausedOperationNotice());
        outro("Paused");
        return [...completed];
      }
    } catch (error) {
      if (isPromptExitError(error)) {
        const interruptedState = {
          ...state,
          pending: { type: "oauth" as const, provider },
          completedOAuthProviders: [...completed],
        };
        throw deployPausedError(interruptedState, { interrupted: true });
      }
      throw error;
    }
    completed.add(provider);
    if (pendingProviders.some((nextProvider) => !completed.has(nextProvider))) {
      log.blank();
    }
  }

  return [...completed];
}

async function collectAndSaveOAuthCredentials(
  ctx: DeployContext,
  provider: OAuthProvider,
  domain: string,
  productionInstanceId: string,
): Promise<boolean> {
  const label = PROVIDER_LABELS[provider];
  for (const line of providerSetupIntro(provider)) log.info(line);
  log.blank();

  const choice = await chooseOAuthCredentialAction(provider);

  if (choice === "skip") {
    return false;
  }

  if (choice === "walkthrough") {
    await showOAuthWalkthrough(provider, domain);
  }

  const credentials = await collectOAuthCredentials(
    provider,
    choice === "google-json" ? "google-json" : "manual",
  );

  await withSpinner(`Saving ${label} OAuth credentials...`, async () => {
    await patchInstanceConfig(ctx.appId, productionInstanceId, {
      [`connection_oauth_${provider}`]: {
        enabled: true,
        ...credentials,
      },
    });
  });
  log.success(`Saved ${label} OAuth credentials`);
  return true;
}

/**
 * Refresh the deploy context from the server after a recovery branch.
 *
 * Used when the server tells us a production instance exists but our local
 * context doesn't know about it yet (e.g. state was lost between runs). Pulls
 * the application down again, finds the production instance, and persists the
 * resolved ID so subsequent `clerk deploy` invocations short-circuit to
 * `reconcileExistingDeploy` directly.
 */
async function reloadProductionState(ctx: DeployContext): Promise<DeployContext> {
  const app = await fetchApplication(ctx.appId);
  const production = app.instances.find((entry) => entry.environment_type === "production");
  if (!production) {
    throw new CliError(
      "Server reports a production instance exists but did not return one when refetching the application.",
    );
  }
  await persistProductionInstance(ctx, production.instance_id);
  return {
    ...ctx,
    productionInstanceId: production.instance_id,
  };
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
  log.info(NEXT_STEPS_BLOCK);
  outro("Success");
}

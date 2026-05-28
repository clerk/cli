import { resolveProfile } from "../../lib/config.ts";
import { PlapiError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import {
  fetchApplication,
  fetchInstanceConfig,
  fetchInstanceConfigSchema,
  getApplicationDomainStatus,
  listApplicationDomains,
  triggerApplicationDomainDNSCheck,
  type ApplicationDomain,
  type CnameTarget,
  type DomainStatusResponse,
} from "../../lib/plapi.ts";
import { sleep } from "../../lib/sleep.ts";
import { withSpinner, type SpinnerControls } from "../../lib/spinner.ts";
import {
  DEPLOY_COMPONENT_ORDER,
  deployComponentLabels,
  deployStatusRetryMessage,
  type DeployComponent,
  type DeployComponentStatus,
} from "./copy.ts";
import { mapDeployError } from "./errors.ts";
import {
  OAUTH_KEY_PREFIX,
  buildOAuthProviderDescriptors,
  hasProviderRequiredCredentials,
  type OAuthProvider,
  type OAuthProviderDescriptor,
} from "./providers.ts";
import type { DeployContext, DeployOperationState } from "./state.ts";

const DEPLOY_STATUS_INITIAL_RETRY_DELAY_MS = 3000;
const DEPLOY_STATUS_MAX_RETRIES = 5;
const DEPLOY_STATUS_BACKOFF_FACTOR = 2;

export interface DeployProgressHandlers {
  runComponent<T>(
    component: DeployComponent,
    progressLabel: string,
    work: (controls: SpinnerControls) => Promise<T>,
  ): Promise<T>;
  onComponentDone?(component: DeployComponent): void;
}

export type DeployStatusOutcome = { verified: boolean; status: DeployComponentStatus };

export type LiveDeploySnapshot = Omit<
  DeployOperationState,
  "pending" | "oauthProviders" | "completedOAuthProviders"
> & {
  pending?: DeployOperationState["pending"];
  oauthProviders: OAuthProvider[];
  oauthProviderDescriptors: OAuthProviderDescriptor[];
  completedOAuthProviders: OAuthProvider[];
  cnameTargets?: readonly CnameTarget[];
  domainComplete: boolean;
  componentStatus: DeployComponentStatus;
  unsupportedOAuthProviderCount: number;
};

export type DeployState =
  | { kind: "not_started" }
  | { kind: "domain_provisioning"; productionInstanceId: string }
  | { kind: "active"; snapshot: LiveDeploySnapshot };

export type DiscoveredOAuthProviders = {
  descriptors: OAuthProviderDescriptor[];
  unsupported: string[];
};

export async function resolveDeployContext(): Promise<DeployContext> {
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

export async function resolveLiveApplicationContext(profile: DeployContext["profile"]): Promise<{
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

export async function resolveDeployState(ctx: DeployContext): Promise<DeployState> {
  const live = await resolveLiveApplicationContext(ctx.profile);
  if (!live.productionInstanceId) return { kind: "not_started" };

  const snapshot = await resolveLiveDeploySnapshot({
    ...ctx,
    productionInstanceId: live.productionInstanceId,
  });
  if (!snapshot) {
    return { kind: "domain_provisioning", productionInstanceId: live.productionInstanceId };
  }
  return { kind: "active", snapshot };
}

export async function loadDevelopmentOAuthProviders(
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

export async function resolveLiveDeploySnapshot(
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
    componentStatus: deployComponentStatusFromDomainStatus(deployStatus),
    unsupportedOAuthProviderCount: unsupported.length,
  };

  const domainComplete = deployStatus.status === "complete";
  const pending = pendingOAuthDescriptor
    ? ({ type: "oauth", provider: pendingOAuthDescriptor.provider } as const)
    : !domainComplete
      ? ({ type: "dns" } as const)
      : undefined;

  return { ...baseState, domainComplete, pending };
}

export async function loadInitialDeployStatus(
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

export async function loadProductionState(
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

export function pendingDomainStatus(): DomainStatusResponse {
  return {
    status: "incomplete",
    dns: { status: "not_started" },
    ssl: { status: "not_started", required: true },
    mail: { status: "not_started", required: true },
  };
}

export async function loadProductionDomain(
  ctx: DeployContext,
): Promise<ApplicationDomain | undefined> {
  const domains = await listApplicationDomains(ctx.appId);
  return domains.data.find((domain) => !domain.is_satellite) ?? domains.data[0];
}

export function discoverEnabledOAuthProviderSlugs(config: Record<string, unknown>): string[] {
  const providers: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith(OAUTH_KEY_PREFIX)) continue;
    if (!value || typeof value !== "object") continue;
    if ((value as Record<string, unknown>).enabled !== true) continue;
    providers.push(key.slice(OAUTH_KEY_PREFIX.length));
  }
  return providers;
}

export async function waitForDeployStatus(
  appId: string,
  domainIdOrName: string,
  domain: string,
  handlers: DeployProgressHandlers,
): Promise<DeployStatusOutcome> {
  await triggerDeployStatusCheck(appId, domainIdOrName);
  let response = await mapDeployError(getApplicationDomainStatus(appId, domainIdOrName));
  let status = deployComponentStatusFromDomainStatus(response);
  for (const component of DEPLOY_COMPONENT_ORDER) {
    let retriesRemaining = DEPLOY_STATUS_MAX_RETRIES;
    let nextRetryDelay = DEPLOY_STATUS_INITIAL_RETRY_DELAY_MS;
    const labels = deployComponentLabels(component, domain);
    const flipped = await handlers.runComponent(component, labels.progress, async (spinner) => {
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
    handlers.onComponentDone?.(component);
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

export function deployComponentStatusFromDomainStatus(
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

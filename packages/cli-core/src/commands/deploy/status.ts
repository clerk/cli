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
  type DomainStatusResponse,
} from "../../lib/plapi.ts";
import { sleep } from "../../lib/sleep.ts";
import { withSpinner, type SpinnerControls } from "../../lib/spinner.ts";
import {
  cnameTargetPending,
  deployComponentLabels,
  deployStatusRetryMessage,
  domainsDashboardUrl,
  type DeployComponentStatus,
} from "./copy.ts";
import { mapDeployError } from "./errors.ts";
import {
  OAUTH_KEY_PREFIX,
  buildOAuthProviderDescriptors,
  hasProviderRequiredCredentials,
  oauthWalkthroughUrls,
  type OAuthProvider,
  type OAuthProviderDescriptor,
} from "./providers.ts";
import type { DeployContext, DeployOperationState } from "./state.ts";

const DEPLOY_STATUS_INITIAL_RETRY_DELAY_MS = 3000;
const DEPLOY_STATUS_MAX_RETRIES = 5;
const DEPLOY_STATUS_BACKOFF_FACTOR = 2;

export interface DeployProgressHandlers {
  runVerification<T>(
    progressLabel: string,
    work: (controls: SpinnerControls) => Promise<T>,
  ): Promise<T>;
  onVerified?(): void;
  /**
   * Fires every time a poll resolves a fresh status. Ctrl-C rejects out of the
   * next poll or its countdown, discarding the loop's local status, so a caller
   * that wants to report partial progress on interrupt has to capture it here.
   */
  onStatus?(status: DeployComponentStatus): void;
}

export type DeployStatusOutcome = { verified: boolean; status: DeployComponentStatus };

export type DeployStatusState =
  | "complete"
  | "domain_pending"
  | "oauth_pending"
  | "domain_provisioning"
  | "not_started"
  // Ctrl-C landed before the live state could be read, so nothing about the
  // deploy is known. Never means "no production instance" — see
  // buildInterruptedDeployStatusReport.
  | "interrupted";

/**
 * Everything an agent needs to get one pending OAuth provider working in
 * production: what the provider's OAuth app must be configured with, which
 * credential fields Clerk expects, and the exact write command.
 */
export type OAuthSetupGuide = {
  provider: string;
  label: string;
  configKey: string;
  fields: {
    key: string;
    label: string;
    secret: boolean;
    options?: string[];
    /** The value is the full contents of a file (for example Apple's `.p8` key). */
    fileContents?: true;
  }[];
  redirectUri: string;
  authorizedOrigins: string[];
  docsUrl: string;
  note: string | null;
  command: string;
};

export interface DeployStatusReport {
  complete: boolean;
  state: DeployStatusState;
  domain: string | null;
  productionInstanceId: string | null;
  domainStatus: { dns: string; ssl: string; mail: string } | null;
  pendingDnsRecords: { type: "CNAME"; host: string; value: string; required: boolean }[];
  oauth: {
    complete: boolean;
    configured: string[];
    pending: string[];
    unsupported: string[];
    setup: OAuthSetupGuide[];
  };
  nextAction: string;
}

export type LiveDeploySnapshot = Omit<
  DeployOperationState,
  "pending" | "oauthProviders" | "completedOAuthProviders"
> & {
  pending: DeployOperationState["pending"] | undefined;
  oauthProviders: OAuthProvider[];
  oauthProviderDescriptors: OAuthProviderDescriptor[];
  completedOAuthProviders: OAuthProvider[];
  domainComplete: boolean;
  componentStatus: DeployComponentStatus;
  unsupportedOAuthProviderCount: number;
  unsupportedOAuthProviders: string[];
};

export type DeployState =
  | { kind: "not_started" }
  | { kind: "domain_provisioning"; appId: string; productionInstanceId: string }
  | { kind: "active"; snapshot: LiveDeploySnapshot };

type SnapshotOptions = {
  /**
   * When true, a failed domain-status read throws instead of being treated as
   * pending. The read-only status path enables this so transient API errors are
   * surfaced rather than reported as legitimate progress. The interactive deploy
   * flow leaves it off, letting the user retry from the on-screen status.
   */
  throwOnStatusError?: boolean;
};

export type DiscoveredOAuthProviders = {
  descriptors: OAuthProviderDescriptor[];
  unsupported: string[];
};

export async function resolveDeployContext(): Promise<DeployContext> {
  const resolved = await withSpinner("Resolving linked Clerk application...", async () =>
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
    ...(await withSpinner("Checking for production instance...", async () =>
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

  // The read-only status path surfaces domain-status read failures instead of
  // masking them as pending, so a transient API error is not reported as
  // legitimate progress.
  const snapshot = await resolveLiveDeploySnapshot(
    {
      ...ctx,
      productionInstanceId: live.productionInstanceId,
    },
    { throwOnStatusError: true },
  );
  if (!snapshot) {
    return {
      kind: "domain_provisioning",
      appId: live.appId,
      productionInstanceId: live.productionInstanceId,
    };
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
  options: SnapshotOptions = {},
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
    options,
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
    frontendApiUrl: domain.frontend_api_url,
    oauthProviders,
    oauthProviderDescriptors,
    completedOAuthProviders,
    cnameTargets: domain.cname_targets ?? [],
    componentStatus: deployComponentStatusFromDomainStatus(deployStatus),
    unsupportedOAuthProviderCount: unsupported.length,
    unsupportedOAuthProviders: unsupported,
  };

  const domainComplete = deployStatus.status === "complete";
  return {
    ...baseState,
    domainComplete,
    pending: resolvePendingStep(pendingOAuthDescriptor, domainComplete),
  };
}

function resolvePendingStep(
  pendingOAuthDescriptor: OAuthProviderDescriptor | undefined,
  domainComplete: boolean,
): DeployOperationState["pending"] | undefined {
  if (pendingOAuthDescriptor) {
    return { type: "oauth", provider: pendingOAuthDescriptor.provider };
  }
  if (!domainComplete) {
    return { type: "dns" };
  }
  return undefined;
}

export async function loadInitialDeployStatus(
  appId: string,
  domainIdOrName: string,
  options: SnapshotOptions = {},
): Promise<DomainStatusResponse> {
  const status = mapDeployError(getApplicationDomainStatus(appId, domainIdOrName));
  if (options.throwOnStatusError) return status;

  try {
    return await status;
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
  options: SnapshotOptions = {},
): Promise<{
  productionConfig: Record<string, unknown>;
  deployStatus: DomainStatusResponse;
}> {
  return withSpinner("Reading production configuration...", async () => {
    const [productionConfig, deployStatus] = await Promise.all([
      fetchInstanceConfig(ctx.appId, productionInstanceId),
      loadInitialDeployStatus(ctx.appId, domainIdOrName, options),
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

function domainComponentState(value: boolean): "complete" | "pending" {
  return value ? "complete" : "pending";
}

export function buildDeployStatusReport(
  state: DeployState,
  outcome: DeployStatusOutcome | null,
): DeployStatusReport {
  if (state.kind === "not_started") {
    return {
      complete: false,
      state: "not_started",
      domain: null,
      productionInstanceId: null,
      domainStatus: null,
      pendingDnsRecords: [],
      oauth: { complete: false, configured: [], pending: [], unsupported: [], setup: [] },
      nextAction:
        "No production instance yet. Ask the user which domain they own for production " +
        "(for example example.com; *.vercel.app and other hosting-provider domains are not accepted), " +
        "then run `clerk deploy --domain <domain>`. Add `--no-clone` if creation fails with " +
        "`plan_insufficient`. Verify afterwards with `clerk deploy status`.",
    };
  }

  if (state.kind === "domain_provisioning") {
    const domainsAction = domainSettingsNextAction(
      domainsDashboardUrl(state.appId, state.productionInstanceId),
    );
    return {
      complete: false,
      state: "domain_provisioning",
      domain: null,
      productionInstanceId: state.productionInstanceId,
      domainStatus: null,
      pendingDnsRecords: [],
      oauth: { complete: false, configured: [], pending: [], unsupported: [], setup: [] },
      nextAction:
        "A production instance exists but its domain is still provisioning. " +
        "Re-run `clerk deploy status` in a minute. " +
        domainsAction,
    };
  }

  const { snapshot } = state;
  const componentStatus = outcome?.status ?? snapshot.componentStatus;
  const domainComplete = outcome ? outcome.verified : snapshot.domainComplete;
  const oauthPending = snapshot.oauthProviders.filter(
    (provider) => !snapshot.completedOAuthProviders.includes(provider),
  );
  const oauthComplete = oauthPending.length === 0;
  const complete = domainComplete && oauthComplete;
  const reportState = resolveActiveReportState(domainComplete, complete);

  const pendingDnsRecords: DeployStatusReport["pendingDnsRecords"] = !domainComplete
    ? (snapshot.cnameTargets ?? [])
        .filter((target) => cnameTargetPending(target, componentStatus))
        .map((target) => ({
          type: "CNAME" as const,
          host: target.host,
          value: target.value,
          required: target.required,
        }))
    : [];

  return {
    complete,
    state: reportState,
    domain: snapshot.domain,
    productionInstanceId: snapshot.productionInstanceId ?? null,
    domainStatus: {
      dns: domainComponentState(componentStatus.dns),
      ssl: domainComponentState(componentStatus.ssl),
      mail: domainComponentState(componentStatus.mail),
    },
    pendingDnsRecords,
    oauth: {
      complete: oauthComplete,
      configured: [...snapshot.completedOAuthProviders],
      pending: oauthPending,
      unsupported: [...snapshot.unsupportedOAuthProviders],
      setup: buildOAuthSetupGuides(snapshot, oauthPending),
    },
    nextAction: deployNextAction(
      reportState,
      snapshot.domain,
      componentStatus,
      oauthPending,
      snapshot.productionInstanceId
        ? domainsDashboardUrl(snapshot.appId, snapshot.productionInstanceId)
        : null,
      pendingDnsRecords.length,
    ),
  };
}

/**
 * The report for a Ctrl-C that arrived before {@link resolveDeployState} could
 * answer — during the preflight DNS check, or during the state read itself.
 *
 * `not_started` would be a lie here: it asserts there is no production
 * instance, which is exactly the question that never got answered. This says
 * "unknown" instead, so an agent parsing stdout gets a well-formed document
 * rather than the empty output this path used to produce.
 */
export function buildInterruptedDeployStatusReport(): DeployStatusReport {
  return {
    complete: false,
    state: "interrupted",
    domain: null,
    productionInstanceId: null,
    domainStatus: null,
    pendingDnsRecords: [],
    oauth: { complete: false, configured: [], pending: [], unsupported: [], setup: [] },
    nextAction:
      "Interrupted before the deploy status could be read, so nothing is known about this " +
      "deploy. Run `clerk deploy status` again to check it.",
  };
}

function buildOAuthSetupGuides(
  snapshot: LiveDeploySnapshot,
  pending: readonly string[],
): OAuthSetupGuide[] {
  const { authorizedOrigins, redirectUri } = oauthWalkthroughUrls(
    snapshot.domain,
    snapshot.frontendApiUrl,
  );
  return snapshot.oauthProviderDescriptors
    .filter((descriptor) => pending.includes(descriptor.provider))
    .map((descriptor) => {
      const fields = descriptor.fields.map((field) => ({
        key: field.key,
        label: field.label,
        secret: field.secret,
        ...(field.options && { options: field.options }),
        ...(field.filePath && { fileContents: true as const }),
      }));
      const payload = {
        [descriptor.configKey]: {
          enabled: true,
          ...Object.fromEntries(fields.map((field) => [field.key, `<${field.key}>`])),
        },
      };
      return {
        provider: descriptor.provider,
        label: descriptor.label,
        configKey: descriptor.configKey,
        fields,
        redirectUri,
        authorizedOrigins,
        docsUrl: descriptor.docsUrl,
        note: descriptor.gotcha ?? null,
        command: `clerk config patch --instance prod --json '${JSON.stringify(payload)}' --yes`,
      };
    });
}

function resolveActiveReportState(domainComplete: boolean, complete: boolean): DeployStatusState {
  if (complete) return "complete";
  if (!domainComplete) return "domain_pending";
  return "oauth_pending";
}

function deployNextAction(
  state: DeployStatusState,
  domain: string,
  componentStatus: DeployComponentStatus,
  oauthPending: string[],
  domainsUrl: string | null,
  pendingDnsRecordCount: number,
): string {
  const domainsAction = domainsUrl ? ` ${domainSettingsNextAction(domainsUrl)}` : "";

  if (state === "complete") {
    return (
      `Production is deployed and verified at https://${domain}. ` +
      "Put the production keys on the hosting provider without reading them: " +
      "`clerk env pull --instance prod --print | while IFS='=' read -r key value; do " +
      'printf \'%s\' "$value" | vercel env add "$key" production; done` ' +
      "(for a provider without a CLI, run `clerk env pull --instance prod --print` and add each " +
      "line as a production environment variable), then redeploy the app. " +
      `Keep development keys in local env files.${domainsAction}`
    );
  }
  if (state === "oauth_pending") {
    return (
      `Domain verified, but these OAuth providers have no production credentials: ${oauthPending.join(", ")}. ` +
      "For each entry in `oauth.setup`, have the user create the provider's OAuth app with its `redirectUri` " +
      "and `authorizedOrigins`, then run that entry's `command` with real values. To leave a provider out of " +
      `production instead, run \`clerk config patch --instance prod --json '{"<configKey>":{"enabled":false}}' --yes\`. ` +
      `Then run \`clerk deploy status\`.${domainsAction}`
    );
  }

  const pendingComponents = [
    !componentStatus.dns ? "DNS" : null,
    !componentStatus.ssl ? "SSL" : null,
    !componentStatus.mail ? "email DNS" : null,
  ].filter((value): value is string => value !== null);

  if (pendingComponents.length === 0) {
    return (
      `Production setup for ${domain} is still finalizing on Clerk's side. ` +
      `Re-run \`clerk deploy status\` in a few minutes.${domainsAction}`
    );
  }

  if (pendingDnsRecordCount === 0) {
    if (componentStatus.dns && componentStatus.mail) {
      return (
        `${pendingComponents.join(", ")} still provisioning for ${domain}. ` +
        `Nothing to add at the DNS provider; re-run \`clerk deploy status --wait\` in a few minutes.${domainsAction}`
      );
    }
    // DNS-backed checks are pending but the API returned no CNAME targets.
    return (
      `${pendingComponents.join(", ")} still provisioning for ${domain}, but Clerk returned no CNAME records to add. ` +
      `Read them from the Clerk Dashboard domains page, then re-run \`clerk deploy status --wait\`.${domainsAction}`
    );
  }

  return (
    `${pendingComponents.join(", ")} still provisioning for ${domain}. ` +
    "Add every record in `pendingDnsRecords` at the domain's DNS provider as an unproxied CNAME " +
    "(records that already verified are omitted), then re-run `clerk deploy status --wait`. " +
    `DNS propagation can take time.${domainsAction}`
  );
}

// Ends with the URL and no period so the human-mode rewrite captures it cleanly.
function domainSettingsNextAction(domainsUrl: string): string {
  return `Dashboard fallback, only if the user asks to watch DNS and SSL there: ${domainsUrl}`;
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
  options: { triggerCheck?: boolean } = {},
): Promise<DeployStatusOutcome> {
  if (options.triggerCheck !== false) {
    await triggerDeployStatusCheck(appId, domainIdOrName);
  }
  let response = await mapDeployError(getApplicationDomainStatus(appId, domainIdOrName));
  let status = deployComponentStatusFromDomainStatus(response);
  handlers.onStatus?.(status);

  const labels = deployComponentLabels("dns", domain);
  const verified = await handlers.runVerification(labels.progress, async (spinner) => {
    if (response.status === "complete") return true;

    let retriesRemaining = DEPLOY_STATUS_MAX_RETRIES;
    let nextRetryDelay = DEPLOY_STATUS_INITIAL_RETRY_DELAY_MS;
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
      handlers.onStatus?.(status);
      if (response.status === "complete") return true;
    }
    return false;
  });

  if (!verified) {
    return { verified: false, status };
  }
  handlers.onVerified?.();
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

export async function triggerDeployStatusCheck(
  appId: string,
  domainIdOrName: string,
): Promise<void> {
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

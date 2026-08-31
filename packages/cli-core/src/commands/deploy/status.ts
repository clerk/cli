import { resolveProfile } from "../../lib/config.ts";
import { errorMessage, PlapiError, UserAbortError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import {
  fetchApplication,
  fetchInstanceConfig,
  fetchInstanceConfigSchema,
  getNativeSettings,
  getApplicationDomainStatus,
  listApplicationDomains,
  listIOSApplications,
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
  inspectNativeAppleConfiguration,
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

export interface DeployStatusReport {
  complete: boolean;
  state: DeployStatusState;
  domain: string | null;
  productionInstanceId: string | null;
  domainStatus: { dns: string; ssl: string; mail: string } | null;
  pendingDnsRecords: { type: "CNAME"; host: string; value: string }[];
  oauth: { complete: boolean; configured: string[]; pending: string[]; unsupported: string[] };
  nextAction: string;
}

type NativeAppleReadinessIssue = {
  bundleId: string;
  reason:
    | "authentication-disabled"
    | "registration-missing"
    | "registration-bundle-case-mismatch"
    | "registration-ambiguous"
    | "native-api-disabled"
    | "verification-unavailable";
};

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
  nativeAppleReadinessIssue?: NativeAppleReadinessIssue;
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
  const nativeAppleDescriptor = oauthProviderDescriptors.find(
    (descriptor) => descriptor.provider === "apple",
  );
  const preliminaryNativeAppleConfiguration = nativeAppleDescriptor
    ? inspectNativeAppleConfiguration(productionConfig, nativeAppleDescriptor, [])
    : undefined;
  let nativeAppleConfiguration = preliminaryNativeAppleConfiguration;
  if (
    nativeAppleDescriptor &&
    preliminaryNativeAppleConfiguration?.status === "registration-missing"
  ) {
    try {
      nativeAppleConfiguration = await withSpinner(
        "Reading production Native Application settings...",
        async () => {
          const [iosApplications, nativeSettings] = await Promise.all([
            listIOSApplications(ctx.appId, productionInstanceId),
            getNativeSettings(ctx.appId, productionInstanceId),
          ]);
          return inspectNativeAppleConfiguration(
            productionConfig,
            nativeAppleDescriptor,
            iosApplications,
            nativeSettings,
          );
        },
      );
    } catch (error) {
      if (error instanceof UserAbortError) throw error;
      log.debug(`Could not read production Native Application settings: ${errorMessage(error)}`);
      nativeAppleConfiguration = {
        status: "verification-unavailable",
        bundleId: preliminaryNativeAppleConfiguration.bundleId,
      };
    }
  }
  const completedOAuthProviders = oauthProviderDescriptors
    .filter(
      (descriptor) =>
        hasProviderRequiredCredentials(productionConfig, descriptor) ||
        (descriptor.provider === "apple" && nativeAppleConfiguration?.status === "ready"),
    )
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
    ...(nativeAppleConfiguration &&
    "bundleId" in nativeAppleConfiguration &&
    isNativeAppleReadinessIssue(nativeAppleConfiguration.status)
      ? {
          nativeAppleReadinessIssue: {
            bundleId: nativeAppleConfiguration.bundleId,
            reason: nativeAppleConfiguration.status,
          },
        }
      : {}),
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
      oauth: { complete: false, configured: [], pending: [], unsupported: [] },
      nextAction:
        "No production instance yet. `clerk deploy` configures production interactively and " +
        "needs a human terminal, ask the user to run `clerk deploy`, then run `clerk deploy status` to verify.",
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
      oauth: { complete: false, configured: [], pending: [], unsupported: [] },
      nextAction:
        "A production instance exists but its domain is still provisioning. " +
        "Run `clerk deploy status` again shortly, or ask the user to finish `clerk deploy`. " +
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
        .map((target) => ({ type: "CNAME" as const, host: target.host, value: target.value }))
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
    },
    nextAction: deployNextAction(
      reportState,
      snapshot.domain,
      componentStatus,
      oauthPending,
      snapshot.productionInstanceId
        ? domainsDashboardUrl(snapshot.appId, snapshot.productionInstanceId)
        : null,
      snapshot.nativeAppleReadinessIssue,
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
    oauth: { complete: false, configured: [], pending: [], unsupported: [] },
    nextAction:
      "Interrupted before the deploy status could be read, so nothing is known about this " +
      "deploy. Run `clerk deploy status` again to check it.",
  };
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
  nativeAppleReadinessIssue?: NativeAppleReadinessIssue,
): string {
  const domainsAction = domainsUrl ? ` ${domainSettingsNextAction(domainsUrl)}` : "";
  const nativeAppleAction = nativeAppleReadinessIssue
    ? nativeAppleReadinessNextAction(nativeAppleReadinessIssue)
    : "";

  if (state === "complete") {
    return `Production is deployed and verified at https://${domain}. No action needed.${domainsAction}`;
  }
  if (state === "oauth_pending") {
    if (nativeAppleReadinessIssue) {
      const hostedPending = oauthPending.filter((provider) => provider !== "apple");
      const hostedAction =
        hostedPending.length > 0
          ? ` These OAuth providers are also missing production credentials: ${hostedPending.join(", ")}.`
          : "";
      return (
        `Domain verified, but setup is incomplete. ${nativeAppleAction}${hostedAction} ` +
        "After resolving those items, run `clerk deploy status` again." +
        domainsAction
      );
    }
    return (
      `Domain verified, but these OAuth providers are missing production credentials: ` +
      `${oauthPending.join(", ")}. Ask the user to finish \`clerk deploy\`, then run \`clerk deploy status\`.` +
      domainsAction
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
      `Re-run \`clerk deploy status\` in a few minutes.${domainsAction}` +
      (nativeAppleAction ? ` ${nativeAppleAction}` : "")
    );
  }

  return (
    `${pendingComponents.join(", ")} still provisioning for ${domain}. ` +
    `Re-run \`clerk deploy status\` in a few minutes, DNS propagation can take time.` +
    domainsAction +
    (nativeAppleAction ? ` ${nativeAppleAction}` : "")
  );
}

function isNativeAppleReadinessIssue(
  status: string,
): status is NativeAppleReadinessIssue["reason"] {
  return (
    status === "authentication-disabled" ||
    status === "registration-missing" ||
    status === "registration-bundle-case-mismatch" ||
    status === "registration-ambiguous" ||
    status === "native-api-disabled" ||
    status === "verification-unavailable"
  );
}

function nativeAppleReadinessNextAction(issue: NativeAppleReadinessIssue): string {
  if (issue.reason === "verification-unavailable") {
    return (
      `Clerk could not verify the production Native Application registration for ${issue.bundleId}. ` +
      "Retry `clerk deploy status`; do not create another registration based on this unverified result."
    );
  }
  if (issue.reason === "registration-ambiguous") {
    return (
      `Native Sign in with Apple has more than one App ID Prefix registration for ${issue.bundleId}. ` +
      "Review the existing registrations at https://dashboard.clerk.com/~/native-applications before continuing; do not create another registration."
    );
  }
  if (issue.reason === "registration-bundle-case-mismatch") {
    return (
      `The Apple connection Bundle ID ${issue.bundleId} differs only by letter casing from its existing iOS Native Application registration. ` +
      "Update the Apple connection to use the registration's exact Bundle ID spelling in the Clerk Dashboard; do not create another registration."
    );
  }
  if (issue.reason === "authentication-disabled") {
    return (
      `Apple is not explicitly enabled for authentication on the production instance for ${issue.bundleId}. ` +
      "Review the Apple connection in the Clerk Dashboard; no web credentials should be added for a native-only setup."
    );
  }
  if (issue.reason === "native-api-disabled") {
    return (
      `Native API is disabled on the production instance for ${issue.bundleId}. ` +
      "Enable it at https://dashboard.clerk.com/~/native-applications; the CLI will not infer an App ID Prefix."
    );
  }
  return (
    `Native Sign in with Apple is missing an exact production iOS Native Application registration for ${issue.bundleId}. ` +
    "Register that Bundle ID at https://dashboard.clerk.com/~/native-applications; the CLI will not infer an App ID Prefix."
  );
}

function domainSettingsNextAction(domainsUrl: string): string {
  return `Ask the user to visit the Clerk Dashboard domains page, or offer to open it: ${domainsUrl}`;
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

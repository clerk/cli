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
  pendingCnameTargets,
  deployComponentLabels,
  deployStatusRetryMessage,
  capitalizeFirst,
  classifyDomainPending,
  domainsDashboardUrl,
  instanceDashboardUrl,
  pendingRecordComponents,
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
import { clearTelemetryStage, setTelemetryStage } from "../../lib/telemetry.ts";

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
   * Carries the poll's verdict on the domain as well as its components: all
   * three can be verified while Clerk is still finalizing.
   */
  onStatus?(outcome: DeployStatusOutcome): void;
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
 * Two values only. `deployNextStep` reads this back as booleans, so a third
 * value would be silently classified as pending; the type makes adding one a
 * compile error at every reader instead.
 */
export type DomainComponentState = "complete" | "pending";

export interface DeployStatusReport {
  complete: boolean;
  state: DeployStatusState;
  domain: string | null;
  productionInstanceId: string | null;
  domainStatus: {
    dns: DomainComponentState;
    ssl: DomainComponentState;
    mail: DomainComponentState;
  } | null;
  pendingDnsRecords: { type: "CNAME"; host: string; value: string; required: boolean }[];
  oauth: { complete: boolean; configured: string[]; pending: string[]; unsupported: string[] };
  /**
   * Dashboard pages for this deploy: the production instance and its Domains
   * page. Null before a production instance exists, and when the run was
   * interrupted before the state could be read.
   */
  urls: { domains: string; instance: string } | null;
  /**
   * Derived, never written: every constructor goes through `withNextAction`,
   * which renders this from `deployNextStep` over the other fields. Assigning
   * it directly would let it drift from the facts it describes.
   */
  nextAction: string;
}

/**
 * What the report tells its reader to do next, as data. The agent's
 * `nextAction` sentence and the human-mode line are both rendered from this,
 * so neither audience's wording is derived from the other's: a reword on one
 * side can't leak the other side's phrasing.
 */
export type DeployNextStep =
  | { kind: "not_started" }
  | { kind: "domain_provisioning"; domainsUrl: string | null }
  | { kind: "interrupted" }
  | {
      kind: "complete";
      domain: string;
      oauthUnsupported: readonly string[];
      instanceUrl: string | null;
    }
  | { kind: "oauth_pending"; oauthPending: readonly string[]; oauthUnsupported: readonly string[] }
  | {
      kind: "records_available" | "records_unavailable" | "ssl_pending" | "finalizing";
      domain: string;
      /** "DNS", "Email DNS", or "DNS and email DNS": the record kinds still unverified. */
      records: string;
      domainsUrl: string | null;
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
  /**
   * Whether `domainComplete` and `componentStatus` come from a domain-status
   * read that succeeded. The wizard's resume path substitutes "everything
   * pending" when that read fails so the user can retry from the screen, and
   * the substitute is byte-identical to a genuine all-pending answer; this is
   * the only thing that tells them apart. Nothing about the domain may be
   * recorded from a snapshot that is not live.
   */
  live: boolean;
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
  // legitimate progress. `deployStatus` and the agent handoff record the
  // telemetry stage from this read too; `recordObservedDeployStage` guards
  // telemetry on its own, but the printed report reads `componentStatus`
  // unconditionally and would need `snapshot.live` as well if this ever
  // stopped throwing.
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
  const { productionConfig, deployStatus, live } = await loadProductionState(
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
    live,
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
): Promise<{ status: DomainStatusResponse; live: boolean }> {
  try {
    const status = await mapDeployError(getApplicationDomainStatus(appId, domainIdOrName));
    return { status, live: true };
  } catch (error) {
    if (options.throwOnStatusError) throw error;
    log.debug(
      `deploy: snapshot domain-status read failed, treating DNS as pending: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: pendingDomainStatus(), live: false };
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
  live: boolean;
}> {
  return withSpinner("Reading production configuration...", async () => {
    const [productionConfig, { status: deployStatus, live }] = await Promise.all([
      fetchInstanceConfig(ctx.appId, productionInstanceId),
      loadInitialDeployStatus(ctx.appId, domainIdOrName, options),
    ]);
    return { productionConfig, deployStatus, live };
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

function domainComponentState(value: boolean): DomainComponentState {
  return value ? "complete" : "pending";
}

export function buildDeployStatusReport(
  state: DeployState,
  outcome: DeployStatusOutcome | null,
): DeployStatusReport {
  return withNextAction(buildDeployStatusFacts(state, outcome));
}

type DeployStatusFacts = Omit<DeployStatusReport, "nextAction">;

function withNextAction(facts: DeployStatusFacts): DeployStatusReport {
  return { ...facts, nextAction: agentNextAction(deployNextStep(facts)) };
}

function buildDeployStatusFacts(
  state: DeployState,
  outcome: DeployStatusOutcome | null,
): DeployStatusFacts {
  if (state.kind === "not_started") {
    return {
      complete: false,
      state: "not_started",
      domain: null,
      productionInstanceId: null,
      domainStatus: null,
      pendingDnsRecords: [],
      oauth: { complete: false, configured: [], pending: [], unsupported: [] },
      urls: null,
    };
  }

  if (state.kind === "domain_provisioning") {
    return {
      complete: false,
      state: "domain_provisioning",
      domain: null,
      productionInstanceId: state.productionInstanceId,
      domainStatus: null,
      pendingDnsRecords: [],
      oauth: { complete: false, configured: [], pending: [], unsupported: [] },
      urls: dashboardUrls(state.appId, state.productionInstanceId),
    };
  }

  const { snapshot } = state;
  const componentStatus = outcome?.status ?? snapshot.componentStatus;
  const domainComplete = outcome ? outcome.verified : snapshot.domainComplete;
  const oauthPending = pendingOAuthProviders(snapshot);
  const reportState = deployReportState(state, outcome);
  const complete = reportState === "complete";

  const pendingDnsRecords: DeployStatusReport["pendingDnsRecords"] = !domainComplete
    ? pendingCnameTargets(snapshot.cnameTargets ?? [], componentStatus).map((target) => ({
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
      complete: oauthPending.length === 0,
      configured: [...snapshot.completedOAuthProviders],
      pending: oauthPending,
      unsupported: [...snapshot.unsupportedOAuthProviders],
    },
    urls: snapshot.productionInstanceId
      ? dashboardUrls(snapshot.appId, snapshot.productionInstanceId)
      : null,
  };
}

function dashboardUrls(appId: string, productionInstanceId: string): DeployStatusReport["urls"] {
  return {
    domains: domainsDashboardUrl(appId, productionInstanceId),
    instance: instanceDashboardUrl(appId, productionInstanceId),
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
  return withNextAction({
    complete: false,
    state: "interrupted",
    domain: null,
    productionInstanceId: null,
    domainStatus: null,
    pendingDnsRecords: [],
    oauth: { complete: false, configured: [], pending: [], unsupported: [] },
    urls: null,
  });
}

/** The states a deploy with a production domain can be in. */
export type ActiveDeployStatusState = Extract<
  DeployStatusState,
  "domain_pending" | "oauth_pending" | "complete"
>;

export type OAuthSetupFacts = Pick<
  DeployOperationState,
  "oauthProviders" | "completedOAuthProviders"
>;

function pendingOAuthProviders(oauth: OAuthSetupFacts): string[] {
  return oauth.oauthProviders.filter(
    (provider) => !oauth.completedOAuthProviders.includes(provider),
  );
}

/**
 * The one place the three active states are decided, for the report and for
 * telemetry alike. `domainComplete` is the domain-status read's own verdict,
 * not the three component booleans: all three can be verified while Clerk is
 * still finalizing, and that is still `domain_pending`.
 */
export function resolveActiveReportState(
  oauth: OAuthSetupFacts,
  domainComplete: boolean,
): ActiveDeployStatusState {
  if (!domainComplete) return "domain_pending";
  return pendingOAuthProviders(oauth).length === 0 ? "complete" : "oauth_pending";
}

/**
 * The state a report for `state` carries. `outcome` is a wait's latest poll
 * and overrides the snapshot's domain verdict when present.
 */
export function deployReportState(
  state: DeployState,
  outcome: DeployStatusOutcome | null,
): Exclude<DeployStatusState, "interrupted"> {
  if (state.kind !== "active") return state.kind;
  return resolveActiveReportState(
    state.snapshot,
    outcome ? outcome.verified : state.snapshot.domainComplete,
  );
}

/**
 * Record the deploy's state as telemetry's `stage`. Every write goes through
 * this function or {@link recordObservedDeployStage}, and every value is a
 * report state — what `clerk deploy status` would print for this deploy at
 * this moment — so the wizard, the agent handoff and the status command agree
 * about the same deploy.
 *
 * One rule across every writer: last write wins, and nothing is written
 * without an observation, so a run that ends before any state is known sends
 * null. The writers, in the order a run can reach them:
 *
 * - `startNewDeploy` on entry: `not_started`. The create call has not run.
 * - `startNewDeploy` when the create call finds an instance already exists:
 *   {@link retractDeployStage}. An instance exists; nothing else is known.
 * - `startNewDeploy` on the create response: `domain_pending` or
 *   `domain_provisioning`, from whether Clerk returned a domain.
 * - `reconcileExistingDeploy`: `domain_provisioning` when Clerk lists no
 *   domain, else the snapshot's state through `recordObservedDeployStage`.
 * - `runDnsVerification`, once per poll: that poll's verdict.
 * - `finishDeploy`: the resolver over the OAuth facts and a verified domain.
 * - `emitAgentDeployHandoff` and `deployStatus`: the state read, then each
 *   poll, through `recordObservedDeployStage`.
 *
 * This entry takes a state the caller can vouch for without a snapshot — one
 * the CLI's own action established, or a poll's verdict. A state derived from
 * a snapshot goes through `recordObservedDeployStage`, which is where the
 * substituted-read check lives. `interrupted` is not a state of the deploy:
 * it means nothing was read, so whatever was last observed stays in place.
 */
export function recordDeployStage(state: DeployStatusState): void {
  if (state === "interrupted") return;
  setTelemetryStage(state);
}

/**
 * Record the state a `DeployState` establishes, or nothing when it rests on a
 * substituted snapshot. A poll outcome is its own observation, so with one
 * present the snapshot's liveness does not matter. This is the only place
 * that stops a fallback being recorded as an observation: the callers that
 * read through `resolveDeployState` never trip it today, because that read
 * throws rather than substitutes, and the check is here so that stays true
 * without every call site knowing about the option.
 */
export function recordObservedDeployStage(
  state: DeployState,
  outcome: DeployStatusOutcome | null,
): void {
  if (state.kind === "active" && !outcome && !state.snapshot.live) return;
  recordDeployStage(deployReportState(state, outcome));
}

/**
 * Forget the recorded stage. For the one case where an observation disproves
 * the stage without establishing a new one: a fresh deploy's create call
 * answering that an instance already exists. `not_started` is now false, and
 * whether that instance has a domain, or how far it got, is unknown until the
 * resume reads it — and the resume records normally when it does.
 */
export function retractDeployStage(): void {
  clearTelemetryStage();
}

/**
 * Classify what the reader should do next from the report's own fields, so
 * the human line rendered from a report and the agent sentence stored in it
 * always describe the same situation.
 */
export function deployNextStep(report: DeployStatusFacts): DeployNextStep {
  switch (report.state) {
    case "not_started":
      return { kind: "not_started" };
    case "interrupted":
      return { kind: "interrupted" };
    case "domain_provisioning":
      // Always has a production instance, so always has its URLs; nullable
      // only because the report type can't say so.
      return { kind: "domain_provisioning", domainsUrl: report.urls?.domains ?? null };
    case "complete":
      return {
        kind: "complete",
        domain: report.domain ?? "",
        oauthUnsupported: report.oauth.unsupported,
        instanceUrl: report.urls?.instance ?? null,
      };
    case "oauth_pending":
      return {
        kind: "oauth_pending",
        oauthPending: report.oauth.pending,
        oauthUnsupported: report.oauth.unsupported,
      };
    case "domain_pending": {
      // DNS and email DNS are records someone has to add at the registrar;
      // SSL is Clerk's side and waits on them. Polling can't move the first
      // kind along, so those get "add the records" and only SSL gets "wait".
      const status: DeployComponentStatus = {
        dns: report.domainStatus?.dns === "complete",
        ssl: report.domainStatus?.ssl === "complete",
        mail: report.domainStatus?.mail === "complete",
      };
      return {
        kind: classifyDomainPending(status, report.pendingDnsRecords.length > 0),
        domain: report.domain ?? "",
        records: capitalizeFirst(pendingRecordComponents(status)),
        domainsUrl: report.urls?.domains ?? null,
      };
    }
  }
}

/** The `nextAction` sentence: written for an agent that will relay it to a person. */
export function agentNextAction(step: DeployNextStep): string {
  // In development Clerk supplies shared OAuth credentials; in production it
  // doesn't, so a provider the CLI couldn't configure has a sign-in button
  // that fails for real users. `oauth.complete` only covers what the CLI
  // manages, so the report has to say this out loud.
  const unsupported = (providers: readonly string[]): string =>
    providers.length > 0
      ? ` These providers are enabled in development but the CLI could not configure them for ` +
        `production: ${providers.join(", ")}. Configure them in the Clerk Dashboard before ` +
        `going live, or users signing in with them will fail.`
      : "";
  const domains = (url: string | null): string =>
    url
      ? ` Ask the user to visit the Clerk Dashboard domains page, or offer to open it: ${url}`
      : "";

  switch (step.kind) {
    case "not_started":
      return (
        "No production instance yet. `clerk deploy` configures production interactively and " +
        "needs a human terminal, ask the user to run `clerk deploy`, then run `clerk deploy status` to verify."
      );
    case "domain_provisioning":
      return (
        "A production instance exists but its domain is still provisioning. " +
        "Run `clerk deploy status` again shortly, or ask the user to finish `clerk deploy`." +
        domains(step.domainsUrl)
      );
    case "interrupted":
      return (
        "Interrupted before the deploy status could be read, so nothing is known about this " +
        "deploy. Run `clerk deploy status` again to check it."
      );
    case "complete":
      // Complete on Clerk's side only. The app keeps running on development
      // keys until the production keys reach the host, and the report can't
      // tell whether that already happened — hence "if you haven't already".
      // Nothing is left to monitor on the Domains page here, so the pointer is
      // the instance itself (users, settings, billing) rather than the shared
      // "visit the domains page" clause every pending state carries.
      return (
        `Clerk's production setup for https://${step.domain} is verified. If you haven't already: ` +
        `run \`clerk env pull --instance prod\`, set those keys on your host alongside the other ` +
        `Clerk variables from your env file, redeploy, then sign up at https://${step.domain} to confirm.` +
        unsupported(step.oauthUnsupported) +
        (step.instanceUrl
          ? ` Manage users, settings, and billing for this instance: ${step.instanceUrl}`
          : "")
      );
    case "oauth_pending":
      // The domain is verified, so there is nothing to monitor on the Domains
      // page; the wizard is the only way to supply credentials.
      return (
        `Domain verified, but these OAuth providers are missing production credentials: ` +
        `${step.oauthPending.join(", ")}. Ask the user to finish \`clerk deploy\`, then run \`clerk deploy status\`.` +
        unsupported(step.oauthUnsupported)
      );
    case "records_available":
      return (
        `${step.records} records not found yet for ${step.domain}. ` +
        `Add the records in \`pendingDnsRecords\` at the domain's DNS provider if you haven't already, ` +
        `then re-run \`clerk deploy status --wait\`. Propagation usually takes minutes.` +
        domains(step.domainsUrl)
      );
    case "records_unavailable":
      // The report has nothing to hand over; the Dashboard clause carries the
      // URL, so this sentence doesn't repeat it.
      return (
        `${step.records} records not found yet for ${step.domain}, but this report has no record list. ` +
        `Find the records to add on the Domains page in the Clerk Dashboard, then re-run ` +
        `\`clerk deploy status --wait\`.` +
        domains(step.domainsUrl)
      );
    case "ssl_pending":
      // Records are verified; the certificate is Clerk's side and nobody can
      // speed it up. Same message the wizard's footer prints for this state.
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
  handlers.onStatus?.({ verified: response.status === "complete", status });

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
      handlers.onStatus?.({ verified: response.status === "complete", status });
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

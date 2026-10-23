import type { Program } from "../../cli-program.ts";
import { deployStatus } from "./status-command.ts";
import { isAgent } from "../../mode.ts";
import { applyPrefix, isInsideGutter, log } from "../../lib/log.ts";
import { bold, dim } from "../../lib/color.ts";
import { animateHeader } from "../../lib/gradient.ts";
import { bar, intro, outro, pausedOutro, withSpinner } from "../../lib/spinner.ts";
import {
  CliError,
  ERROR_CODE,
  UserAbortError,
  throwUsageError,
  withApiContext,
} from "../../lib/errors.ts";
import {
  clerkAppDomain,
  probeClerkApp,
  requireClerkAppSlug,
  type ClerkAppOffer,
  type ClerkAppSlug,
  type ProductionDomainChoice,
} from "./clerk-app.ts";
import {
  buildNewDeployPlan,
  collectProductionDomain,
  confirmProductionInstanceCreation,
  createProductionInstance,
  parseClerkAppFlag,
  resolveHostingDomain,
  throwDomainConflict,
  type DomainPlan,
} from "./domain-choice.ts";
import { isWebHostName } from "./domains.ts";
import { domainVerification } from "./domain-verification.ts";
import {
  runDnsRecordHandoff,
  runDnsVerificationPrompt,
  runDomainVerification,
  runExistingDomainDnsVerification,
  type DnsVerificationResult,
} from "./verify.ts";
import {
  addDomain,
  emitAddDomainReport,
  listDomainsCommand,
  readHostingDomainReport,
  removeDomain,
  type AddDomainReport,
} from "./domain-commands.ts";
import { useDomain } from "./use-domain.ts";
import { interruptedExitCode } from "../../lib/signals.ts";
import { setProfile } from "../../lib/config.ts";
import { fetchInstanceConfig, patchInstanceConfig } from "../../lib/plapi.ts";
import {
  DEPLOY_COMMAND_DESCRIPTION,
  DEPLOY_COMMAND_SUMMARY,
  introPreamble,
  OAUTH_SECTION_INTRO,
  type DeployPlanStep,
  instanceDashboardUrl,
  nativeAppleGuidance,
  nativeApplicationsDashboardUrl,
  nextStepsBody,
  pausedOperationNotice,
  printPlan,
  productionSummary,
} from "./copy.ts";
import {
  providerLabel,
  providerSetupIntro,
  showOAuthWalkthrough,
  type NativeAppleConfiguration,
  type OAuthProvider,
  type OAuthProviderDescriptor,
} from "./providers.ts";
import {
  assertValidDomain,
  chooseOAuthCredentialAction,
  collectOAuthCredentials,
  confirmAppleWebCredentials,
  confirmProceed,
  DOMAIN_NAME,
} from "./prompts.ts";
import {
  DeployPausedError,
  throwDeployPaused,
  type DeployContext,
  type DeployOperationState,
} from "./state.ts";
import {
  buildDeployStatusReport,
  domainStatusNotFoundError,
  loadDevelopmentOAuthProviders,
  resolveDeployContext,
  resolveDeployState,
  resolveLiveApplicationContext,
  inAppleProject,
  resolveLiveDeploySnapshot,
  resolveNativeAppleConfiguration,
  type DiscoveredOAuthProviders,
  type LiveDeploySnapshot,
} from "./status.ts";
import { setTelemetryStage } from "../../lib/telemetry.ts";
import { resolveActiveReportState, type OAuthSetupFacts } from "./report-state.ts";
import { recordDeployObservation, recordDeployStage, recordOAuthObservation } from "./telemetry.ts";

/** The flags commander parses for `clerk deploy`. */
type DeployOptions = {
  /** Skips the domain prompt. In agent mode, it is what allows creating the instance. */
  domain?: string;
  /** Like `domain`, for the free <name>.clerk.app domain. */
  clerkApp?: string;
  yes?: boolean;
};

/**
 * What the flags ask for. A hosting domain's clerk.app name comes from
 * `--clerk-app`, or is picked from the host once the application is known.
 */
type RequestedDomain =
  | Exclude<ProductionDomainChoice, { kind: "hosting" }>
  | { kind: "hosting"; domain: string; slug: ClerkAppSlug | undefined };

/** One run of the wizard or the agent report, with its flags parsed. */
type DeployRun = {
  /** From `--domain` or `--clerk-app`, or from the wizard's prompt. */
  requested?: RequestedDomain;
  yes?: boolean;
  /** Set by the wizard when `requested` came from its prompt, so messages don't name a flag. */
  domainEntered?: boolean;
  /** Set by the wizard when its create found an instance another run made. */
  resumingAfterCreate?: boolean;
};

export async function deploy(options: DeployOptions = {}) {
  // Before anything is read, so `--domain ""` fails instead of falling back to
  // the prompt or the read-only report.
  const run: DeployRun = { requested: parseRequestedDomain(options), yes: options.yes };

  if (isAgent()) {
    await runAgentDeploy(run.requested);
    return;
  }

  intro("clerk deploy");
  try {
    const ctx = await resolveDeployContext();
    await runDeploy(ctx, run);
  } catch (error) {
    // Ctrl-C during a request or a DNS poll rejects with an `AbortError`, not a
    // `UserAbortError`, and `runProgram` hands rendering to the signal handler
    // the moment an interrupt is latched — so nothing below would ever print.
    // A half-finished deploy is exactly when the resume hint matters, so emit it
    // here as a side effect rather than relying on the thrown error's message.
    if (interruptedExitCode() !== null && isInsideGutter()) {
      pausedOutro(pausedOperationNotice());
      throw error;
    }
    if (error instanceof DeployPausedError && isInsideGutter()) {
      await outro("Paused");
    }
    if (error instanceof UserAbortError && isInsideGutter()) {
      pausedOutro(pausedOperationNotice());
      throw new UserAbortError();
    }
    throw error;
  } finally {
    // Successful and paused paths call outro themselves. This balances the
    // intro gutter if an unexpected error escapes.
    if (isInsideGutter()) {
      await outro("Failed");
    }
  }
}

function parseRequestedDomain(options: DeployOptions): RequestedDomain | undefined {
  const host = options.domain?.trim().toLowerCase();
  if (host && DOMAIN_NAME.test(host) && isWebHostName(host)) {
    const slug = options.clerkApp === undefined ? undefined : parseClerkAppFlag(options.clerkApp);
    return { kind: "hosting", domain: host, slug };
  }
  if (options.domain !== undefined && options.clerkApp !== undefined) {
    throwUsageError(
      "Pass --domain or --clerk-app, not both. They go together only when --domain is a hosting domain, such as acme.vercel.app.",
    );
  }
  if (options.domain !== undefined) {
    return { kind: "own", domain: assertValidDomain(options.domain) };
  }
  if (options.clerkApp !== undefined) {
    return { kind: "clerk_app", slug: parseClerkAppFlag(options.clerkApp) };
  }
  return undefined;
}

/**
 * Agent mode never prompts. With `--domain` or `--clerk-app` it creates the
 * production instance, or resumes the one already there; without them nothing
 * is written. Either way it prints the `clerk deploy status` report and exits
 * 0 once its own work succeeded: `clerk deploy status` is the pass/fail gate.
 */
async function runAgentDeploy(requested: RequestedDomain | undefined): Promise<void> {
  const ctx = await resolveDeployContext();
  if (!ctx.appId || !ctx.developmentInstanceId) {
    throw new CliError(
      "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy`.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  if (!requested) {
    const state = await resolveDeployState(ctx);
    recordDeployObservation(state);
    log.data(JSON.stringify(buildDeployStatusReport(state, null), null, 2));
    return;
  }

  // From here a production instance exists, created by this run or found by
  // it, so a read that fails or comes back empty must not look like nothing
  // happened: the caller would create again, or give up on a live instance.
  const created = await ensureProductionInstance(ctx, requested);
  const state = await withApiContext(
    resolveDeployState(ctx),
    "The production instance exists, but its status could not be read; run `clerk deploy status` to retry",
  ).catch((error: unknown) => {
    throw instanceReadError(error, created);
  });
  if (state.kind === "not_started") throw unreturnedInstanceError();
  // Before the profile write, as in the wizard: a failed disk write must not
  // lose what this read observed.
  recordDeployObservation(state);
  // A create that lost a race, and whose refresh still lagged, finds the
  // instance only on this read.
  await rememberProductionInstance(
    ctx,
    state.kind === "active" ? state.snapshot.productionInstanceId : state.productionInstanceId,
  );
  // An application has one production instance, so this run's own create is
  // on the requested domain however Clerk spells it back. Only a run that
  // found the instance has a domain to check.
  if (!created) {
    if (state.kind === "active") assertRequestedDomain(requested, state.snapshot.domain);
    else throw uncheckedDomainError(requested);
  }
  let hostingDomain: AddDomainReport | undefined;
  if (requested.kind === "hosting") {
    hostingDomain = await readHostingDomainReport(ctx.appId, requested.domain, created);
    if (!hostingDomain) {
      throw new CliError(
        `${requested.domain} isn't one of production's domains. ` +
          `Add it with \`clerk deploy add-domain ${requested.domain}\`.`,
        { code: ERROR_CODE.DEPLOY_DOMAIN_CONFLICT },
      );
    }
  }
  log.data(JSON.stringify({ ...buildDeployStatusReport(state, null), hostingDomain }, null, 2));
}

/** Clerk said a production instance exists but returned none: nothing to resume or report. */
function unreturnedInstanceError(): CliError {
  return new CliError(
    "The production instance exists, but Clerk did not return it yet. Run `clerk deploy status` to check it.",
    { code: ERROR_CODE.DEPLOY_INSTANCE_UNRESOLVED },
  );
}

/**
 * Only this run knows whether it created the instance, so it restates the
 * domain-status error for a caller about to decide whether to create again.
 */
function instanceReadError(error: unknown, created: boolean): unknown {
  if (!(error instanceof CliError) || error.code !== ERROR_CODE.DEPLOY_INSTANCE_UNRESOLVED) {
    return error;
  }
  return domainStatusNotFoundError(
    `The production instance ${created ? "was created" : "exists"}, but its status couldn't be read yet. ` +
      "Run `clerk deploy status` to check it.",
    { justCreated: created },
  );
}

/**
 * Create the production instance unless the application already has one, and
 * save its id to the profile so `--instance prod` resolves for the commands the
 * report points to next. True when this run created it; false when it found
 * one, including one another run created first.
 */
async function ensureProductionInstance(
  ctx: DeployContext,
  requested: RequestedDomain,
): Promise<boolean> {
  let created = false;
  if (!ctx.productionInstanceId) {
    recordDeployStage("not_started");
    const choice = await resolveRequestedDomain(ctx.appId, requested, { prompt: false });
    const production = await createProductionInstance(ctx, choice);
    if (production === "exists") {
      // Same as the wizard: `not_started` is now false and nothing has been
      // read yet, so the run sends no stage unless the read that follows does.
      setTelemetryStage(null);
      const refreshed = await resolveLiveApplicationContext(ctx.profile);
      ctx.productionInstanceId = refreshed.productionInstanceId;
    } else {
      recordDeployStage(production.active_domain ? "domain_pending" : "domain_provisioning");
      ctx.productionInstanceId = production.id;
      created = true;
    }
  }
  await rememberProductionInstance(ctx, ctx.productionInstanceId);
  return created;
}

/** Checks a requested clerk.app name, or picks one for a hosting domain. */
async function resolveRequestedDomain(
  appId: string,
  requested: RequestedDomain,
  options: { prompt: boolean },
): Promise<ProductionDomainChoice> {
  if (requested.kind === "hosting") {
    return resolveHostingDomain(appId, requested.domain, { slug: requested.slug, ...options });
  }
  if (requested.kind === "clerk_app") await requireClerkAppSlug(appId, requested.slug);
  return requested;
}

/**
 * Save the production instance id to the profile when it isn't there yet, so
 * `--instance prod` resolves for the commands the report points to next.
 */
async function rememberProductionInstance(
  ctx: DeployContext,
  productionInstanceId: string | undefined,
): Promise<void> {
  if (productionInstanceId && ctx.profile.instances.production !== productionInstanceId) {
    await persistProductionInstance(ctx, productionInstanceId);
  }
}

/**
 * `--domain` only applies when the instance is created. Reporting an existing
 * deploy on another domain as if the request had been honored would send the
 * caller off to add DNS records for a domain they did not ask for.
 */
function assertRequestedDomain(
  requested: RequestedDomain,
  existing: string,
  entered = false,
): void {
  // Without --clerk-app the name was picked when the instance was created, so any clerk.app primary matches.
  if (requested.kind === "hosting" && !requested.slug) {
    if (comparableDomain(existing).endsWith(".clerk.app")) return;
  } else if (comparableDomain(existing) === comparableDomain(requestedDomainName(requested))) {
    return;
  }
  if (requested.kind === "clerk_app" && !entered) throwDomainConflict(existing, requested.slug);
  // A rerun resumes the existing instance; only the flag has to be dropped.
  const rerun = entered ? "Run `clerk deploy` again" : "Run `clerk deploy` without --domain";
  throw new CliError(
    `This application already has a production instance on ${existing}, so ` +
      `${requestedDomainPhrase(requested, entered)} was not applied. ` +
      `${rerun} to continue with ${existing}, or change the domain in the Clerk Dashboard.`,
    { code: ERROR_CODE.PRODUCTION_INSTANCE_EXISTS },
  );
}

/** How a message names the requested domain: as the flag, or as what the person typed. */
function requestedDomainPhrase(requested: RequestedDomain, entered: boolean): string {
  if (entered) return `the domain you entered, ${requestedDomainName(requested)},`;
  switch (requested.kind) {
    case "own":
      return `--domain ${requested.domain}`;
    case "clerk_app":
      return `--clerk-app ${requested.slug}`;
    case "hosting":
      return `--domain ${requested.domain}${requested.slug ? ` --clerk-app ${requested.slug}` : ""}`;
  }
}

function requestedDomainName(requested: RequestedDomain): string {
  if (requested.kind === "own") return requested.domain;
  if (requested.kind === "clerk_app") return clerkAppDomain(requested.slug);
  return requested.slug ? clerkAppDomain(requested.slug) : requested.domain;
}

/** A domain as DNS compares it: case-insensitive, with or without the root's trailing dot. */
function comparableDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * While Clerk lists no production domain, {@link assertRequestedDomain} has
 * nothing to compare against. A run that created the instance knows it is on
 * the requested domain; any other run can't tell, and once Clerk returns the
 * domain the report would send the caller to add records for it.
 */
function uncheckedDomainError(requested: RequestedDomain, entered = false): CliError {
  // Only called when this run created nothing; its own profile write (the
  // instance id) is local, hence "in Clerk".
  return new CliError(
    `This application already has a production instance, but Clerk hasn't returned its domain yet, ` +
      `so ${requestedDomainPhrase(requested, entered)} could not be checked against it. ` +
      "This run did not change the instance's domain. Nothing was changed in Clerk. " +
      "Run `clerk deploy status` to see its domain once Clerk returns it.",
    { code: ERROR_CODE.DEPLOY_DOMAIN_UNCHECKED },
  );
}

async function runDeploy(ctx: DeployContext, options: DeployRun): Promise<void> {
  if (!ctx.appId || !ctx.developmentInstanceId) {
    throw new CliError(
      "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy`.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  if (ctx.productionInstanceId) {
    await reconcileExistingDeploy(ctx, ctx.productionInstanceId, options);
    return;
  }

  await startNewDeploy(ctx, options);
}

async function startNewDeploy(ctx: DeployContext, options: DeployRun): Promise<void> {
  // What `clerk deploy status` reports on exactly this condition. Set before
  // anything is read, so a run that ends at the plan, the domain prompt or the
  // create confirmation says where the deploy stood rather than nothing.
  recordDeployStage("not_started");
  const requested =
    options.requested &&
    (await resolveRequestedDomain(ctx.appId, options.requested, { prompt: !options.yes }));

  const [{ descriptors: oauthProviders, unsupported }, offer]: [
    DiscoveredOAuthProviders,
    ClerkAppOffer,
  ] = await Promise.all([
    loadDevelopmentOAuthProviders(ctx),
    requested
      ? Promise.resolve<ClerkAppOffer>({ enabled: false })
      : probeClerkApp(ctx.appId, ctx.appLabel),
  ]);
  const domainPlan: DomainPlan =
    requested && requested.kind !== "own" ? "clerk_app" : offer.enabled ? "either" : "own";

  log.blank();
  log.info(introPreamble({ clerkAppOffered: domainPlan !== "own" }));
  log.blank();
  for (const line of printPlan(ctx.appLabel, buildNewDeployPlan(oauthProviders, domainPlan))) {
    log.info(line);
  }
  log.blank();

  warnUnsupportedOAuthProviders(unsupported.length);
  const proceed = options.yes || (await confirmProceed());
  if (!proceed) {
    log.info("No changes were made.");
    await outro("Cancelled");
    return;
  }

  bar();
  const domainEntered = requested === undefined;
  const choice: ProductionDomainChoice =
    requested ?? (await collectProductionDomain(ctx.appId, offer));
  const shouldCreateProductionInstance = await confirmProductionInstanceCreation(
    choice,
    options.yes,
  );
  if (!shouldCreateProductionInstance) return;

  const productionOrExists = await createProductionInstance(ctx, choice);
  if (productionOrExists === "exists") {
    // `not_started` is now false and the resume has not read anything yet, so
    // the run sends no stage unless the resume below observes one.
    setTelemetryStage(null);
    const refreshed = await withSpinner("Refreshing application state...", async () =>
      resolveLiveApplicationContext(ctx.profile),
    );
    // Nothing to resume or to check --domain against, so this run can't
    // report success.
    if (!refreshed.productionInstanceId) throw unreturnedInstanceError();
    // The domain the person typed counts like --domain: a race lost to an
    // instance on another domain must not carry on into that domain's setup.
    await reconcileExistingDeploy(ctx, refreshed.productionInstanceId, {
      ...options,
      requested: choice,
      domainEntered,
      resumingAfterCreate: true,
    });
    return;
  }
  const production = productionOrExists;
  // From the create response, before anything local happens: the instance
  // exists, and the response says whether it has a domain. `deploy status`
  // reads both from the API, so it agrees from this instant on, and a failure
  // persisting the id below records the deploy's state rather than filing a
  // local disk write under provisioning. Without this, every run that ends
  // before the first DNS poll — which comes after OAuth setup — would report
  // no stage, and that is where the wizard loses people.
  recordDeployStage(production.active_domain ? "domain_pending" : "domain_provisioning");
  // As in agent mode, an empty id names no instance and isn't saved; the
  // guards that need the id then fail as `deploy_instance_unresolved`.
  await rememberProductionInstance(ctx, production.id);
  // "Clerk production instance", not just "production instance": the user
  // also has a deployment on their host, and this is the one Clerk manages.
  // URL on its own line: with it, the sentence is wider than the frame.
  log.success("Clerk production instance created. Manage it in the Dashboard:");
  log.info(`  ${instanceDashboardUrl(ctx.appId, production.id)}`);
  if (choice.kind === "hosting") await reportHostingDomain(ctx.appId, choice.domain);

  // Rerunning at once can't help: until Clerk returns the domain, a rerun
  // with --domain is refused (`deploy_domain_unchecked`) and one without it
  // has nothing to resume.
  if (!production.active_domain) {
    throw new CliError(
      "The production instance was created, but Clerk did not return its domain yet. " +
        "Run `clerk deploy status` to check it, and run `clerk deploy` again once it shows the domain.",
      { code: ERROR_CODE.DEPLOY_DOMAIN_MISSING },
    );
  }

  log.blank();

  const productionDomain = production.active_domain.name;
  const verification = domainVerification(production.active_domain.is_clerk_managed);
  const cnameTargets = production.active_domain.cname_targets ?? [];
  let completedOAuthProviders: OAuthProvider[] = [];
  const operationState: DeployOperationState = {
    appId: ctx.appId,
    developmentInstanceId: ctx.developmentInstanceId,
    productionInstanceId: production.id,
    productionDomainId: production.active_domain.id,
    domain: productionDomain,
    verification,
    frontendApiUrl: production.active_domain.frontend_api_url,
    pending: { type: "oauth", provider: oauthProviders[0]?.provider ?? "google" },
    oauthProviders: oauthProviders.map((descriptor) => descriptor.provider),
    completedOAuthProviders,
    cnameTargets,
  };

  if (verification.clerkManaged) {
    log.info(
      `There are no DNS records to add for ${productionDomain}. Clerk is issuing its SSL certificate.`,
    );
    log.blank();
  } else {
    await runDnsRecordHandoff(
      { ...operationState, pending: { type: "dns" } },
      {
        display: cnameTargets,
        exportTargets: cnameTargets,
        // Nothing has been checked yet on a fresh run.
        status: { dns: false, ssl: false, mail: false },
        oauthNext: oauthProviders.length > 0,
      },
    );
  }

  bar();
  completedOAuthProviders = await runOAuthSetup(ctx, operationState, oauthProviders);

  bar();
  const verifyState: DeployOperationState = {
    ...operationState,
    pending: { type: "dns" },
    completedOAuthProviders,
  };
  // A clerk.app domain has nothing for the user to add first, so there is no "check now?" prompt.
  const dnsStatus = verification.clerkManaged
    ? await runDomainVerification(ctx, verifyState, { justCreated: true })
    : await runDnsVerificationPrompt(ctx, verifyState, { justCreated: true });

  await finishDeploy(
    ctx,
    operationState,
    { oauthProviders: operationState.oauthProviders, completedOAuthProviders },
    dnsStatus,
  );
}

async function reportHostingDomain(appId: string, host: string): Promise<void> {
  const report = await readHostingDomainReport(appId, host, true);
  if (report) {
    emitAddDomainReport(report);
    return;
  }
  log.blank();
  log.warn(
    `Clerk doesn't list ${host} as a hosting domain yet. Run \`clerk deploy domains\` to check it.`,
  );
}

async function reconcileExistingDeploy(
  ctx: DeployContext,
  productionInstanceId: string,
  options: DeployRun,
): Promise<void> {
  // Everything below reads the instance through `ctx`.
  ctx.productionInstanceId = productionInstanceId;
  await rememberProductionInstance(ctx, productionInstanceId);

  const snapshot = await resolveLiveDeploySnapshot(ctx);
  if (!snapshot) {
    // The instance exists, but Clerk lists no production domain for it yet.
    recordDeployStage("domain_provisioning");
    // Same as agent mode: nothing to check --domain against, so it is refused
    // rather than reported as if it had been applied.
    if (options.requested) throw uncheckedDomainError(options.requested, options.domainEntered);
    log.blank();
    log.info("A production instance exists, but Clerk did not return a production domain yet.");
    log.info("Run `clerk deploy` again after the domain is available from the API.");
    await outro("No deploy actions available");
    return;
  }
  // Records no stage or domain components when the domain read was
  // substituted; a later poll that succeeds will. OAuth is recorded either
  // way, since the configuration read succeeded.
  recordDeployObservation({ kind: "active", snapshot });
  if (options.requested) {
    assertRequestedDomain(options.requested, snapshot.domain, options.domainEntered);
  }
  // Only once the domain check passed, so it never comes right before a refusal.
  if (options.resumingAfterCreate) {
    log.blank();
    log.info(
      "A production instance already exists for this application. Resuming the existing deploy.",
    );
  }

  log.blank();
  for (const line of printPlan(ctx.appLabel, buildLiveDeployPlan(snapshot))) {
    log.info(line);
  }
  log.blank();

  warnUnsupportedOAuthProviders(snapshot.unsupportedOAuthProviderCount);

  if (!snapshot.pending) {
    log.info("No deploy actions remain.");
    await finishDeploy(ctx, snapshot, snapshot, "verified");
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
      snapshot.nativeApple ?? null,
    );
    snapshot.completedOAuthProviders = completed;
  }

  if (!snapshot.domainComplete) {
    dnsStatus = await runExistingDomainDnsVerification(
      ctx,
      { ...snapshot, pending: { type: "dns" } },
      snapshot.componentStatus,
    );
  }

  await finishDeploy(ctx, snapshot, snapshot, dnsStatus);
}

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
    {
      label: snapshot.verification.planLabel,
      status: snapshot.domainComplete ? "done" : "pending",
    },
  ];
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
  /** Undefined when unknown (a fresh deploy); null when Apple is not native-only. */
  nativeApple?: NativeAppleConfiguration | null,
): Promise<OAuthProvider[]> {
  const completed = new Set(state.completedOAuthProviders as OAuthProvider[]);
  const oauthProviders = descriptors.map((descriptor) => descriptor.provider);

  if (descriptors.length > 0) {
    log.info(OAUTH_SECTION_INTRO);
    log.blank();
  }

  for (const descriptor of descriptors) {
    if (completed.has(descriptor.provider)) continue;
    try {
      const productionInstanceId = state.productionInstanceId ?? ctx.productionInstanceId;
      if (!productionInstanceId) {
        throwUsageError(
          "Cannot save OAuth credentials because the production instance could not be resolved. Run `clerk deploy` after confirming the production instance in the Clerk Dashboard.",
          undefined,
          ERROR_CODE.DEPLOY_INSTANCE_UNRESOLVED,
        );
      }

      const saved = await collectAndSaveOAuthCredentials(
        ctx,
        descriptor,
        state.domain,
        productionInstanceId,
        state.frontendApiUrl,
        nativeApple,
      );
      if (!saved) {
        throwDeployPaused(
          {
            ...state,
            pending: { type: "oauth", provider: descriptor.provider },
            completedOAuthProviders: [...completed],
          },
          "paused",
        );
      }
    } catch (error) {
      if (error instanceof UserAbortError) {
        throwDeployPaused(
          {
            ...state,
            pending: { type: "oauth", provider: descriptor.provider },
            completedOAuthProviders: [...completed],
          },
          "cancelled",
        );
      }
      throw error;
    }
    completed.add(descriptor.provider);
    if (descriptors.some((nextDescriptor) => !completed.has(nextDescriptor.provider))) {
      log.blank();
    }
  }

  // Every required credential is saved — including when none is required —
  // so OAuth is complete, which is what `deploy status` reports for it too.
  // Not recorded any earlier: a fresh instance is assumed to have no
  // production credentials, which is why this prompts for each provider, but
  // nothing has read that, and a save proves only the provider it saved. A run
  // that pauses in the loop leaves `oauth` as the last read observed — null
  // on a fresh deploy.
  recordOAuthObservation({ oauthProviders, completedOAuthProviders: [...completed] });
  return [...completed];
}

async function collectAndSaveOAuthCredentials(
  ctx: DeployContext,
  descriptor: OAuthProviderDescriptor,
  domain: string,
  productionInstanceId: string,
  frontendApiUrl?: string,
  nativeApple?: NativeAppleConfiguration | null,
): Promise<boolean> {
  if (descriptor.provider === "apple") {
    const native =
      nativeApple !== undefined
        ? nativeApple
        : await withSpinner("Checking production Sign in with Apple configuration...", async () =>
            resolveNativeAppleConfiguration(
              ctx.appId,
              productionInstanceId,
              await fetchInstanceConfig(ctx.appId, productionInstanceId),
              [descriptor],
            ),
          );
    if (native?.status === "ready") {
      log.success(
        `Native Sign in with Apple is ready for ${native.bundleId}; Apple web credentials are not required`,
      );
      return true;
    }
    if (native && !(await confirmAppleWebCredentials(native.bundleId))) {
      log.warn(
        nativeAppleGuidance({
          bundleId: native.bundleId,
          reason: native.status,
          dashboardUrl: nativeApplicationsDashboardUrl(ctx.appId, productionInstanceId),
        }),
      );
      return false;
    }
  }

  for (const line of providerSetupIntro(descriptor)) log.info(line);
  log.blank();

  let choice = await chooseOAuthCredentialAction(descriptor);

  if (choice === "skip") {
    return false;
  }

  if (choice === "walkthrough") {
    await showOAuthWalkthrough(descriptor, domain, frontendApiUrl);
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
  { domain, verification }: Pick<DeployOperationState, "domain" | "verification">,
  oauth: OAuthSetupFacts,
  dnsStatus: DnsVerificationResult,
): Promise<void> {
  // A verified domain is an observation — a poll's, or a live resume read's —
  // so the resolver decides between `complete` and `oauth_pending` from the
  // facts rather than this function assuming OAuth finished. (Today it always
  // has: `runOAuthSetup` pauses rather than return a partial set.) A pending
  // domain adds nothing: the last set point already recorded it, or, after a
  // substituted resume read, deliberately left it unrecorded.
  if (dnsStatus === "verified") recordDeployStage(resolveActiveReportState(oauth, true));

  log.blank();
  for (const line of productionSummary(
    domain,
    oauth.completedOAuthProviders.map((provider) => providerLabel(provider)),
    dnsStatus,
  )) {
    log.info(line);
  }
  log.blank();
  // From this run's create or Clerk's list, never the profile: an id left
  // there by a deleted instance would name nothing.
  const productionInstanceId = ctx.productionInstanceId;
  if (!productionInstanceId) {
    throwUsageError(
      "Cannot print deploy next steps because the production instance could not be resolved. Run `clerk deploy` after confirming the production instance in the Clerk Dashboard.",
      undefined,
      ERROR_CODE.DEPLOY_INSTANCE_UNRESOLVED,
    );
  }
  await animateHeader({
    prefix: isInsideGutter() ? `${dim("│")}  ` : "",
    label: "Next steps",
    fallback: bold,
    body: `${applyPrefix(nextStepsBody(ctx.appId, productionInstanceId, domain, dnsStatus, verification, await inAppleProject()))}\n`,
  });
  // The closing word summarizes how the run ended. After a skipped DNS check
  // the status row four lines up says "DNS pending", and "Success" beneath it
  // contradicted that; the same value that drives the headline drives this.
  await outro(dnsStatus === "verified" ? "Success" : "Not verified");
}

export function registerDeploy(program: Program): void {
  // `summary` is what the root `clerk --help` table shows; `description` is
  // the prose on `clerk deploy --help`, where the hidden default subcommand
  // would otherwise leave no trace of what the bare command does.
  const deployCmd = program
    .command("deploy")
    .summary(DEPLOY_COMMAND_SUMMARY)
    .description(DEPLOY_COMMAND_DESCRIPTION)
    .option(
      "--domain <domain>",
      "Production domain you own (skips the prompt; in agent mode, creates the production instance)",
    )
    .option("--clerk-app <name>", "Use the free <name>.clerk.app domain without prompting")
    .option("--yes", "Skip the confirmations before the production instance is created")
    .setExamples([
      { command: "clerk deploy", description: "Interactive production setup" },
      {
        command: "clerk deploy --domain example.com",
        description: "Use this domain without prompting",
      },
      {
        command: "clerk deploy --clerk-app acme",
        description: "Use acme.clerk.app without prompting",
      },
      {
        command: "clerk deploy status --wait",
        description: "Verify DNS, SSL, email DNS, and OAuth",
      },
    ]);
  deployCmd
    .command("run", { isDefault: true, hidden: true })
    .action(async (_options, cmd) => deploy(cmd.optsWithGlobals() as DeployOptions));
  deployCmd
    .command("status")
    .description("Show production deploy status (read-only)")
    .option("--wait", "Wait for DNS, SSL, and email DNS verification with retries")
    .action(async (options, cmd) => {
      // Commander hands the parent's flags to `deploy` wherever they appear, so
      // `deploy status --domain x` would otherwise report as if it had been used.
      const { domain, clerkApp, yes } = cmd.optsWithGlobals() as DeployOptions;
      if (domain !== undefined || clerkApp !== undefined || yes) {
        throwUsageError(
          "--domain, --clerk-app and --yes apply to `clerk deploy`, not `clerk deploy status`.",
        );
      }
      await deployStatus(options);
    });
  deployCmd
    .command("add-domain")
    .description(
      "Add a domain you own (like acme.com), your app's domain on a hosting provider (like acme.vercel.app), or a free clerk.app domain (like acme.clerk.app).",
    )
    .argument("<domain>", "Domain to add, such as acme.com, acme.vercel.app or acme.clerk.app")
    .action(async (domain: string) => addDomain(domain));
  deployCmd
    .command("use-domain")
    .description("Make an added domain the primary domain")
    .argument("<domain>", "Domain to use, such as example.com")
    .option("-y, --yes", "Switch without prompting")
    // `--yes` is also a `clerk deploy` flag, so Commander may parse it there.
    .action(async (domain: string, _options, cmd) => useDomain(domain, cmd.optsWithGlobals()));
  deployCmd.command("domains").description("List production's domains").action(listDomainsCommand);
  deployCmd
    .command("remove-domain")
    .description("Remove a domain")
    .argument("<domain>", "Domain to remove, such as acme.netlify.app")
    .option("-y, --yes", "Remove without prompting")
    .action(async (domain: string, _options, cmd) => removeDomain(domain, cmd.optsWithGlobals()));
}

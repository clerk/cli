import { resolve } from "node:path";
import type { Program } from "../../cli-program.ts";
import { deployStatus } from "./status-command.ts";
import { isAgent } from "../../mode.ts";
import { applyPrefix, isInsideGutter, log } from "../../lib/log.ts";
import { bold, dim } from "../../lib/color.ts";
import { animateHeader } from "../../lib/gradient.ts";
import { bar, intro, outro, pausedOutro, withSpinner } from "../../lib/spinner.ts";
import { CliError, ERROR_CODE, UserAbortError, throwUsageError } from "../../lib/errors.ts";
import { interruptedExitCode } from "../../lib/signals.ts";
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
  assertValidDomain,
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
  type DeployStatusReport,
  type DiscoveredOAuthProviders,
  type LiveDeploySnapshot,
} from "./status.ts";

export type DeployOptions = {
  /** Production domain; skips the prompt and, in agent mode, authorizes creation. */
  domain?: string;
  /** Commander sets `clone: false` for `--no-clone`; absent means clone development. */
  clone?: boolean;
  zoneFile?: string;
  yes?: boolean;
};

export async function deploy(options: DeployOptions = {}) {
  const resolved = options.domain
    ? { ...options, domain: assertValidDomain(options.domain) }
    : options;

  if (isAgent()) {
    await runAgentDeploy(resolved);
    return;
  }

  intro("clerk deploy");
  try {
    const ctx = await resolveDeployContext();
    await runDeploy(ctx, resolved);
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

export type DeployRunReport = DeployStatusReport & {
  /** True when this run created the production instance. */
  created: boolean;
  zoneFile?: string;
  warnings?: string[];
};

/**
 * Agent-mode deploy. `--domain` creates (or resumes) the production instance
 * without prompts; without it the run is a read-only report. The exit code
 * stays 0 whenever the command's own action succeeded, `clerk deploy status`
 * is the pass/fail gate.
 */
async function runAgentDeploy(options: DeployOptions): Promise<void> {
  const ctx = await resolveDeployContext();
  if (!ctx.appId || !ctx.developmentInstanceId) {
    throw new CliError(
      "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy`.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }
  if (options.clone === false && !options.domain) {
    throwUsageError("--no-clone requires --domain.");
  }

  const warnings: string[] = [];
  let created = false;
  const domain = options.domain;

  if (domain && !ctx.productionInstanceId) {
    const result = await createProductionInstance(ctx, domain, {
      clone: options.clone !== false,
    });
    if (result === "exists") {
      const refreshed = await resolveLiveApplicationContext(ctx.profile);
      ctx.productionInstanceId = refreshed.productionInstanceId;
      warnings.push("A production instance already existed; resumed it.");
    } else {
      created = true;
      await persistProductionInstance(ctx, result.id);
    }
  }
  if (ctx.productionInstanceId && ctx.profile.instances.production !== ctx.productionInstanceId) {
    await persistProductionInstance(ctx, ctx.productionInstanceId);
  }

  const state = await resolveDeployState(ctx);
  if (domain && !created && state.kind === "active" && state.snapshot.domain !== domain) {
    warnings.push(
      `A production instance already exists for ${state.snapshot.domain}; --domain ${domain} was ignored.`,
    );
  }

  let zoneFile: string | undefined;
  if (options.zoneFile) {
    const targets = state.kind === "active" ? (state.snapshot.cnameTargets ?? []) : [];
    if (state.kind === "active" && targets.length > 0) {
      zoneFile = await writeZoneFile(options.zoneFile, state.snapshot.domain, targets);
    } else {
      warnings.push("No DNS records to export yet; --zone-file was ignored.");
    }
  }

  const report: DeployRunReport = {
    ...buildDeployStatusReport(state, null),
    created,
    ...(zoneFile && { zoneFile }),
    ...(warnings.length > 0 && { warnings }),
  };
  log.data(JSON.stringify(report, null, 2));
}

async function runDeploy(ctx: DeployContext, options: DeployOptions): Promise<void> {
  if (!ctx.appId || !ctx.developmentInstanceId) {
    throw new CliError(
      "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy`.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  if (ctx.productionInstanceId) {
    await reconcileExistingDeploy(ctx, options);
    return;
  }

  await startNewDeploy(ctx, options);
}

async function startNewDeploy(ctx: DeployContext, options: DeployOptions): Promise<void> {
  const { descriptors: oauthProviders, unsupported }: DiscoveredOAuthProviders =
    await loadDevelopmentOAuthProviders(ctx);

  log.blank();
  log.info(INTRO_PREAMBLE);
  log.blank();
  const clone = options.clone !== false;
  for (const line of printPlan(ctx.appLabel, buildNewDeployPlan(oauthProviders, clone))) {
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
  const domain = options.domain ?? (await collectCustomDomain());
  const shouldCreateProductionInstance = await confirmProductionInstanceCreation(
    domain,
    options.yes,
  );
  if (!shouldCreateProductionInstance) return;

  const productionOrExists = await createProductionInstance(ctx, domain, { clone });
  if (productionOrExists === "exists") {
    log.blank();
    log.info(
      "A production instance already exists for this application. Resuming the existing deploy.",
    );
    log.blank();
    const refreshed = await withSpinner("Refreshing application state...", async () =>
      resolveLiveApplicationContext(ctx.profile),
    );
    ctx.productionInstanceId = refreshed.productionInstanceId;
    if (refreshed.productionInstanceId) {
      await persistProductionInstance(ctx, refreshed.productionInstanceId);
    }
    await reconcileExistingDeploy(ctx, options);
    return;
  }
  const production = productionOrExists;
  await persistProductionInstance(ctx, production.id);

  if (!production.active_domain) {
    throw new CliError(
      "Production instance was created but Clerk did not return a domain. " +
        "Run `clerk deploy` again to retry domain provisioning.",
      { code: ERROR_CODE.DEPLOY_DOMAIN_MISSING },
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
    frontendApiUrl: production.active_domain.frontend_api_url,
    pending: { type: "oauth", provider: oauthProviders[0]?.provider ?? "google" },
    oauthProviders: oauthProviders.map((descriptor) => descriptor.provider),
    completedOAuthProviders,
    cnameTargets,
  };

  await runDnsRecordHandoff({ ...operationState, pending: { type: "dns" } }, cnameTargets, options);

  bar();
  completedOAuthProviders = await runOAuthSetup(ctx, operationState, oauthProviders);

  bar();
  const dnsStatus = await runDnsVerificationPrompt(ctx, {
    ...operationState,
    pending: { type: "dns" },
    completedOAuthProviders,
  });

  await finishDeploy(
    ctx,
    productionDomain,
    completedOAuthProviders,
    pendingOAuthProviders(operationState.oauthProviders, completedOAuthProviders),
    dnsStatus,
  );
}

async function reconcileExistingDeploy(ctx: DeployContext, options: DeployOptions): Promise<void> {
  if (ctx.productionInstanceId && ctx.profile.instances.production !== ctx.productionInstanceId) {
    await persistProductionInstance(ctx, ctx.productionInstanceId);
  }

  const snapshot = await resolveLiveDeploySnapshot(ctx);
  if (!snapshot) {
    log.blank();
    log.info("A production instance exists, but Clerk did not return a production domain yet.");
    log.info("Run `clerk deploy` again after the domain is available from the API.");
    await outro("No deploy actions available");
    return;
  }

  if (options.domain && options.domain !== snapshot.domain) {
    log.warn(
      `A production instance already exists for ${snapshot.domain}; --domain ${options.domain} was ignored.`,
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
    await finishDeploy(ctx, snapshot.domain, snapshot.completedOAuthProviders, [], "verified");
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
    dnsStatus = await runExistingDomainDnsVerification(
      ctx,
      { ...snapshot, pending: { type: "dns" } },
      options,
    );
  }

  await finishDeploy(
    ctx,
    snapshot.domain,
    snapshot.completedOAuthProviders,
    pendingOAuthProviders(snapshot.oauthProviders, snapshot.completedOAuthProviders),
    dnsStatus,
  );
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

function buildNewDeployPlan(
  oauthProviders: readonly OAuthProviderDescriptor[],
  clone: boolean,
): DeployPlanStep[] {
  return [
    {
      label: clone
        ? "Create production instance"
        : "Create a blank production instance (development settings are not copied)",
      status: "pending",
    },
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
  options: { clone: boolean },
): Promise<ProductionInstanceResponse | "exists"> {
  return withSpinner("Creating production instance...", async () => {
    try {
      return await mapDeployError<ProductionInstanceResponse | "exists">(
        apiCreateProductionInstance(ctx.appId, {
          domain,
          environment_type: "production",
          ...(options.clone && { clone_instance_id: ctx.developmentInstanceId }),
        }),
        { onProductionInstanceExists: async () => "exists" },
      );
    } catch (error) {
      if (
        error instanceof CliError &&
        error.code === ERROR_CODE.PLAN_INSUFFICIENT &&
        options.clone
      ) {
        throw attachNoCloneExamples(error, domain);
      }
      throw error;
    }
  });
}

/**
 * The plan's clone feature gate only fires when development settings are
 * copied, so retrying without cloning is the one fix the CLI itself can offer.
 */
function attachNoCloneExamples(error: CliError, domain: string): CliError {
  error.examples = [
    {
      command: `clerk deploy --domain ${domain} --no-clone`,
      description: "Create a blank production instance without copying development settings",
    },
    {
      command: "clerk config pull --instance dev",
      description:
        "See which development settings enable the listed features, disable them with `clerk config patch --instance dev`, then retry",
    },
  ];
  return error;
}

async function confirmProductionInstanceCreation(
  domain: string,
  skipConfirm = false,
): Promise<boolean> {
  for (const line of domainAssociationSummary(domain)) log.info(line);
  log.blank();
  const confirmed = skipConfirm || (await confirmCreateProductionInstance());
  if (confirmed) {
    log.blank();
    return true;
  }

  log.blank();
  log.info("No production instance was created.");
  await outro("Cancelled");
  return false;
}

async function runDnsRecordHandoff(
  state: DeployOperationState,
  cnameTargets: readonly CnameTarget[],
  options: Pick<DeployOptions, "zoneFile" | "yes">,
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
    await offerBindZoneExport(state.domain, cnameTargets, options);
    log.blank();
  } catch (error) {
    if (error instanceof UserAbortError) {
      throw deployPausedError(state, { interrupted: true });
    }
    throw error;
  }
}

async function runExistingDomainDnsVerification(
  ctx: DeployContext,
  state: DeployOperationState,
  options: Pick<DeployOptions, "zoneFile" | "yes">,
): Promise<DnsVerificationResult> {
  await runDnsRecordHandoff(state, state.cnameTargets ?? [], options);
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
    if (error instanceof UserAbortError) {
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
      if (error instanceof UserAbortError) {
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
    runVerification: async (progressLabel, work) => withSpinner(progressLabel, work),
    onVerified: () => log.success(deployComponentLabels("dns", domain).done),
  });
}

async function offerBindZoneExport(
  domain: string,
  cnameTargets: readonly CnameTarget[] | undefined,
  options: Pick<DeployOptions, "zoneFile" | "yes">,
): Promise<void> {
  if (!cnameTargets || cnameTargets.length === 0) {
    if (options.zoneFile) log.warn("No DNS records to export yet; --zone-file was ignored.");
    return;
  }
  if (options.zoneFile) {
    log.success(`Wrote ${await writeZoneFile(options.zoneFile, domain, cnameTargets)}`);
    return;
  }
  // The prompt's default answer is "no", so --yes keeps that answer.
  if (options.yes) return;
  const accepted = await confirmExportBindZone();
  if (!accepted) return;
  log.success(`Wrote ${await writeZoneFile(`clerk-${domain}.zone`, domain, cnameTargets)}`);
}

/** Writes the BIND zone fragment for `targets` and returns the absolute path. */
export async function writeZoneFile(
  filePath: string,
  domain: string,
  targets: readonly CnameTarget[],
): Promise<string> {
  const absolute = resolve(process.cwd(), filePath);
  await Bun.write(absolute, bindZoneFile(domain, targets, new Date()));
  return absolute;
}

/**
 * Configures every provider in `descriptors` and returns the completed set.
 * Skipping a provider leaves it pending: the deploy carries on to DNS
 * verification and reports it. Only an interrupted prompt pauses the deploy by
 * throwing `DeployPausedError`.
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

  for (const [index, descriptor] of descriptors.entries()) {
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
        state.frontendApiUrl,
      );
      if (saved) {
        completed.add(descriptor.provider);
      } else {
        log.info(
          `Skipped ${descriptor.label}. Add credentials later with \`clerk deploy\` or \`clerk config patch --instance prod\`.`,
        );
      }
    } catch (error) {
      if (error instanceof UserAbortError) {
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
    if (descriptors.slice(index + 1).some((next) => !completed.has(next.provider))) {
      log.blank();
    }
  }

  return [...completed];
}

function pendingOAuthProviders(all: readonly string[], completed: readonly string[]): string[] {
  return all.filter((provider) => !completed.includes(provider));
}

async function collectAndSaveOAuthCredentials(
  ctx: DeployContext,
  descriptor: OAuthProviderDescriptor,
  domain: string,
  productionInstanceId: string,
  frontendApiUrl?: string,
): Promise<boolean> {
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
  domain: string,
  completedOAuthProviders: readonly string[],
  pendingProviders: readonly string[],
  dnsStatus: DnsVerificationResult,
): Promise<void> {
  log.blank();
  for (const line of productionSummary(
    domain,
    completedOAuthProviders.map((provider) => providerLabel(provider)),
    dnsStatus,
    pendingProviders.map((provider) => providerLabel(provider)),
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
    body: `${applyPrefix(nextStepsBody(ctx.appId, productionInstanceId))}\n`,
  });
  await outro("Success");
}

export function registerDeploy(program: Program): void {
  const deployCmd = program
    .command("deploy")
    .description("Deploy a Clerk application to production")
    .option(
      "--domain <domain>",
      "Production domain you own (skips the domain prompt; required to create in agent mode)",
    )
    .option(
      "--no-clone",
      "Create a blank production instance instead of cloning development settings",
    )
    .option("--zone-file <path>", "Write the required DNS records to <path> as a BIND zone file")
    .option("--yes", "Skip confirmation prompts")
    .setExamples([
      { command: "clerk deploy", description: "Interactive production deploy wizard" },
      {
        command: "clerk deploy --domain example.com --yes",
        description: "Create the production instance for a domain you own without prompts",
      },
      {
        command: "clerk deploy --domain example.com --mode agent",
        description: "Agent mode: create or resume and print the JSON deploy report",
      },
      {
        command: "clerk deploy --domain example.com --no-clone",
        description: "Create a blank production instance when your plan blocks cloning",
      },
      {
        command: "clerk deploy status --wait",
        description: "Verify DNS, SSL, email DNS, and OAuth readiness",
      },
    ]);
  deployCmd
    .command("run", { isDefault: true, hidden: true })
    .action((_options, cmd) => deploy(cmd.optsWithGlobals() as DeployOptions));
  deployCmd
    .command("status")
    .description("Show production deploy status (read-only)")
    .option("--wait", "Wait for DNS, SSL, and email DNS verification with retries")
    .action(deployStatus);
}

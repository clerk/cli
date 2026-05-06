import { isAgent } from "../../mode.ts";
import { dim } from "../../lib/color.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { confirm } from "../../lib/prompts.ts";
import { isInsideGutter, log, setPrefixTone, type PrefixTone } from "../../lib/log.ts";
import { sleep } from "../../lib/sleep.ts";
import { bar, intro, outro, withSpinner } from "../../lib/spinner.ts";
import { CliError, UserAbortError, isPromptExitError, throwUsageError } from "../../lib/errors.ts";
import { resolveProfile, setProfile, type DeployOperationState } from "../../lib/config.ts";
import { fetchInstanceConfig } from "../../lib/plapi.ts";
import {
  createProductionInstance as apiCreateProductionInstance,
  domainConnectUrl,
  getDeployStatus,
  patchInstanceConfig,
  validateCloning,
  type CnameTarget,
  type ProductionInstanceResponse,
} from "./api.ts";
import {
  INTRO_PREAMBLE,
  INVALID_CONTINUE_MESSAGE,
  NEXT_STEPS_BLOCK,
  OAUTH_SECTION_INTRO,
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
  providerLabel,
  showOAuthWalkthrough,
  type OAuthProvider,
} from "./providers.ts";
import {
  chooseOAuthCredentialAction,
  collectCustomDomain,
  collectOAuthCredentials,
  confirmContinueAfterDnsHandoff,
  confirmOAuthSetupNow,
  confirmProceed,
} from "./prompts.ts";
import {
  DeployPausedError,
  activeDeployInProgressError,
  deployPausedError,
  isDeployStateValid,
  type DeployContext,
} from "./state.ts";

// TODO(deploy): rewrite to match the human flow described in
// DEPLOY_MVP_UX_COPY_SPEC.md, or fetch from clerk.com/docs at runtime.
const DEPLOY_PROMPT = `You are deploying a Clerk application to production. Follow these steps:

## Prerequisites

Ensure the following before starting:
- The user is authenticated (\`clerk auth login\` has been run)
- A Clerk application is linked to the project (\`clerk link\` has been run)
- The project has a development instance with a working configuration

## Step 1: Validate Cloning

Confirm the development instance's features are covered by the application's subscription plan before starting any irreversible work.

- Call \`POST /v1/platform/applications/{appID}/validate_cloning\` with body \`{ "clone_instance_id": "<dev_instance_id>" }\`.
- 204 No Content means cloning is allowed. 402 Payment Required means the plan must be upgraded; surface the unsupported features to the user.

## Step 2: Discover enabled OAuth providers

Read the development instance config and pick out enabled social connections.

- Call \`GET /v1/platform/applications/{appID}/instances/{dev_instance_id}/config\`.
- For each key matching \`connection_oauth_*\` whose value has \`enabled: true\`, collect production credentials in step 4.

## Step 3: Create the Production Instance

Provision the production instance, primary domain, and keys in one round-trip.

- Collect a production domain the user owns (\`example.com\`). Reject provider domains (\`*.vercel.app\`, \`*.clerk.app\`, etc.).
- Call \`POST /v1/platform/applications/{appID}/production_instance\` with body \`{ "home_url": "<domain>", "clone_instance_id": "<dev_instance_id>" }\`.
- The 201 response includes \`instance_id\`, \`active_domain\`, \`publishable_key\`, \`secret_key\`, and \`cname_targets\`.
- Show the user the \`cname_targets\` (\`{ host, value, required }\`) and offer Domain Connect handoff when the registrar supports it.
- Poll \`GET /v1/platform/applications/{appID}/instances/{instance_id}/deploy_status\` every ~3 seconds until \`status === "complete"\`. The literal path segments \`development\` or \`production\` may be used in place of an instance ID.
- When DNS or SSL stalls, expose the retry endpoints:
  \`POST /v1/platform/applications/{appID}/domains/{domain_id_or_name}/ssl_retry\`
  \`POST /v1/platform/applications/{appID}/domains/{domain_id_or_name}/mail_retry\`

## Step 4: Configure Social OAuth Providers

For each enabled provider discovered in step 2, prompt for production credentials.

1. Required fields per provider:
   - Most providers: \`client_id\` and \`client_secret\`
   - Apple: also requires \`key_id\`, \`team_id\`, and the \`.p8\` private-key file

2. When walking the user through OAuth app creation, supply:
   - Authorized JavaScript origins: \`https://{domain}\` and \`https://www.{domain}\`
   - Authorized redirect URI: \`https://accounts.{domain}/v1/oauth_callback\`

3. Persist each provider:
   \`PATCH /v1/platform/applications/{appID}/instances/{instance_id}/config\`
   Body: \`{ "connection_oauth_{provider}": { "enabled": true, "client_id": "...", "client_secret": "..." } }\`

Provider-specific documentation: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/{provider}

## Step 5: Finalize

After all configuration is complete:
- Inform the user their production application is ready at \`https://{domain}\`
- Remind them to redeploy their application with the updated Clerk production secret keys
- They can pull production keys with: \`clerk env pull --instance prod\`

## API Reference

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST   | /v1/platform/applications/{appID}/validate_cloning | Pre-flight subscription/feature check |
| POST   | /v1/platform/applications/{appID}/production_instance | Create prod instance + primary domain (returns keys + cname_targets) |
| GET    | /v1/platform/applications/{appID}/instances/{envOrInsID}/deploy_status | Poll DNS/SSL/Mail/Proxy progress |
| POST   | /v1/platform/applications/{appID}/domains/{domainIDOrName}/ssl_retry | Re-trigger SSL provisioning |
| POST   | /v1/platform/applications/{appID}/domains/{domainIDOrName}/mail_retry | Re-trigger SendGrid mail verification |
| GET    | /v1/platform/applications/{appID}/instances/{instanceID}/config | Read dev or prod instance config |
| PATCH  | /v1/platform/applications/{appID}/instances/{instanceID}/config | Write OAuth credentials |

Refer to the Clerk Platform API docs for detailed request/response schemas.`;

type DeployOptions = {
  debug?: boolean;
  continue?: boolean;
  abort?: boolean;
};

const DEPLOY_STATUS_POLL_INTERVAL_MS = 3000;
const DEPLOY_STATUS_MAX_POLLS = 100;

export async function deploy(options: DeployOptions = {}) {
  if (options.continue && options.abort) {
    throwUsageError("Cannot use --continue and --abort together.");
  }

  if (isAgent()) {
    log.data(DEPLOY_PROMPT);
    return;
  }
  if (options.debug) {
    const { setLogLevel } = await import("../../lib/log.ts");
    setLogLevel("debug");
  }

  intro("clerk deploy", { tone: "active" });
  try {
    const ctx = await resolveDeployContext();

    if (options.continue) {
      await continueDeploy(ctx);
      return;
    }

    if (options.abort) {
      await abortDeploy(ctx);
      return;
    }

    if (ctx.profile.deploy) {
      throw activeDeployInProgressError(ctx.profile.deploy);
    }

    await startDeploy(ctx);
  } catch (error) {
    if (error instanceof DeployPausedError && isInsideGutter()) {
      closeDeployGutter("error", "Paused");
    }
    if (isPromptExitError(error) && isInsideGutter()) {
      closeDeployGutter("cancel", "Cancelled");
      throw new UserAbortError();
    }
    throw error;
  } finally {
    // Successful and paused paths call outro themselves. This balances the
    // intro gutter if an unexpected error escapes.
    if (isInsideGutter()) {
      closeDeployGutter("error", "Failed");
    }
  }
}

function closeDeployGutter(tone: PrefixTone, messageOrSteps: string | readonly string[]): void {
  setPrefixTone(tone);
  outro(messageOrSteps);
}

async function resolveDeployContext(): Promise<DeployContext> {
  return withSpinner("Resolving linked Clerk application...", async () => {
    const resolved = await resolveProfile(process.cwd());
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
      appId: resolved.profile.appId,
      appLabel: resolved.profile.appName || resolved.profile.appId,
      developmentInstanceId: resolved.profile.instances.development,
    };
  });
}

async function startDeploy(ctx: DeployContext): Promise<void> {
  if (!ctx.appId || !ctx.developmentInstanceId) {
    log.blank();
    log.warn(
      "No Clerk project linked to this directory. Run `clerk link`, then rerun `clerk deploy`.",
    );
    log.blank();
    closeDeployGutter("error", "Link required");
    return;
  }

  if (ctx.profile.instances.production) {
    throw new CliError(
      "This app already has a production instance configured. " +
        "Run `clerk env pull --instance prod` to pull production keys, or finish any pending steps with `clerk deploy --continue`.",
    );
  }

  const oauthProviders = await loadDevelopmentOAuthProviders(ctx);

  await runValidateCloning(ctx);

  log.blank();
  log.info(INTRO_PREAMBLE);
  log.blank();
  for (const line of printPlan(
    ctx.appLabel,
    oauthProviders.map((provider) => PROVIDER_LABELS[provider]),
  )) {
    log.info(line);
  }
  log.blank();

  const proceed = await confirmProceed();
  if (!proceed) {
    log.info("No changes were made.");
    closeDeployGutter("cancel", "Cancelled");
    return;
  }

  bar();
  const domain = await collectCustomDomain();
  const production = await createProductionInstance(ctx, domain);
  await persistProductionInstance(ctx, production.instance_id);
  log.blank();

  const productionDomain = production.active_domain.name;
  let completedOAuthProviders: OAuthProvider[] = [];
  const dnsDone = await runDnsSetup(
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
  if (!dnsDone) return;

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

  await finishDeploy(ctx, productionDomain, completedOAuthProviders);
}

async function continueDeploy(ctx: DeployContext): Promise<void> {
  const state = ctx.profile.deploy;
  if (!state) {
    log.blank();
    log.info("There is no paused deploy operation to continue.");
    log.info("Run `clerk deploy` to start one.");
    log.blank();
    closeDeployGutter("neutral", "Nothing to continue");
    return;
  }

  if (!isDeployStateValid(ctx, state)) {
    log.blank();
    log.warn(INVALID_CONTINUE_MESSAGE);
    log.blank();
    closeDeployGutter("error", "Cannot continue");
    return;
  }

  if (state.pending.type === "dns") {
    const dnsDone = await runDnsVerification(ctx, state);
    if (!dnsDone) return;
  }

  if (
    state.pending.type === "oauth" ||
    state.oauthProviders.length > state.completedOAuthProviders.length
  ) {
    bar();
    const completed = await runOAuthSetup(ctx, state);
    if (completed.length < state.oauthProviders.length) return;
  }

  await finishDeploy(ctx, state.domain, state.oauthProviders);
}

async function abortDeploy(ctx: DeployContext): Promise<void> {
  const state = ctx.profile.deploy;
  if (!state) {
    log.blank();
    log.info("There is no paused deploy operation to abort.");
    log.blank();
    closeDeployGutter("neutral", "Nothing to abort");
    return;
  }

  const confirmed = await confirm({
    message: "Abort the paused deploy operation?",
    default: false,
  });
  if (!confirmed) {
    log.blank();
    log.info("Paused deploy abort cancelled.");
    log.blank();
    log.info(pausedOperationNotice());
    log.blank();
    closeDeployGutter("error", "Paused");
    return;
  }

  await clearDeployState(ctx);
  log.blank();
  log.info("Cleared the paused deploy bookmark.");
  log.blank();
  log.info(
    dim("Note: this does not undo any changes already saved to your Clerk production instance."),
  );
  log.info(dim("Use the dashboard to inspect or undo server-side changes."));
  log.blank();
  closeDeployGutter("cancel", "Aborted");
}

async function loadDevelopmentOAuthProviders(ctx: DeployContext): Promise<OAuthProvider[]> {
  return withSpinner("Reading development configuration...", async () => {
    const config = await fetchInstanceConfig(ctx.appId, ctx.developmentInstanceId);
    return discoverEnabledOAuthProviders(config);
  });
}

const OAUTH_KEY_PREFIX = "connection_oauth_";

function discoverEnabledOAuthProviders(config: Record<string, unknown>): OAuthProvider[] {
  const enabled: OAuthProvider[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith(OAUTH_KEY_PREFIX)) continue;
    if (!value || typeof value !== "object") continue;
    if ((value as Record<string, unknown>).enabled !== true) continue;
    const provider = key.slice(OAUTH_KEY_PREFIX.length);
    if (provider in PROVIDER_LABELS) enabled.push(provider as OAuthProvider);
  }
  return enabled;
}

async function runValidateCloning(ctx: DeployContext): Promise<void> {
  await withSpinner("Validating subscription compatibility...", async () => {
    await validateCloning(ctx.appId, { clone_instance_id: ctx.developmentInstanceId });
  });
}

async function createProductionInstance(
  ctx: DeployContext,
  domain: string,
): Promise<ProductionInstanceResponse> {
  return withSpinner("Creating production instance...", async () =>
    apiCreateProductionInstance(ctx.appId, {
      home_url: domain,
      clone_instance_id: ctx.developmentInstanceId,
    }),
  );
}

async function runDnsSetup(
  ctx: DeployContext,
  state: DeployOperationState,
  cnameTargets: readonly CnameTarget[],
): Promise<boolean> {
  for (const line of dnsIntro(state.domain)) log.info(line);
  log.blank();
  for (const line of dnsRecords(cnameTargets)) log.info(line);
  log.blank();

  const connectUrl = domainConnectUrl(state.domain);
  if (connectUrl) {
    log.info(`Domain Connect: ${connectUrl}`);
    log.blank();
  }

  await saveDeployState(ctx, state);
  for (const line of dnsDashboardHandoff(state.domain)) log.info(line);
  log.blank();
  try {
    const continueSetup = await confirmContinueAfterDnsHandoff();
    if (!continueSetup) {
      log.blank();
      log.info(pausedOperationNotice());
      log.blank();
      closeDeployGutter("error", "Paused");
      return false;
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
): Promise<boolean> {
  const productionInstanceId = state.productionInstanceId ?? ctx.profile.instances.production;
  if (!productionInstanceId) {
    throwUsageError(
      "Cannot verify DNS without a production instance. Run `clerk deploy --abort` and start again.",
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
        "Run `clerk deploy --continue` once DNS has propagated, or check the dashboard for the failing component.",
    );
    log.blank();
    setPrefixTone("error");
    return false;
  }

  log.blank();
  for (const line of dnsVerified(state.domain)) log.success(line);
  return true;
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

  for (const provider of state.oauthProviders.slice(startIndex) as OAuthProvider[]) {
    if (completed.has(provider)) continue;
    try {
      const setupNow = await confirmOAuthSetupNow(provider);
      if (!setupNow) {
        await saveDeployState(ctx, { ...state, pending: { type: "oauth", provider } });
        log.blank();
        log.info(pausedOperationNotice());
        log.blank();
        closeDeployGutter("error", "Paused");
        return [...completed];
      }

      const productionInstanceId = state.productionInstanceId ?? ctx.profile.instances.production;
      if (!productionInstanceId) {
        throwUsageError(
          "Cannot save OAuth credentials without a production instance. Run `clerk deploy --abort` and start again.",
        );
      }

      const saved = await collectAndSaveOAuthCredentials(
        ctx,
        provider,
        state.domain,
        productionInstanceId,
      );
      if (!saved) {
        await saveDeployState(ctx, { ...state, pending: { type: "oauth", provider } });
        log.blank();
        log.info(pausedOperationNotice());
        log.blank();
        closeDeployGutter("error", "Paused");
        return [...completed];
      }
    } catch (error) {
      if (isPromptExitError(error)) {
        const interruptedState = {
          ...state,
          pending: { type: "oauth" as const, provider },
          completedOAuthProviders: [...completed],
        };
        await saveDeployState(ctx, interruptedState);
        throw deployPausedError(interruptedState, { interrupted: true });
      }
      throw error;
    }
    completed.add(provider);
    await saveDeployState(ctx, {
      ...state,
      pending: { type: "oauth", provider },
      completedOAuthProviders: [...completed],
    });
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
  log.blank();
  log.success(`Saved ${label} OAuth credentials`);
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
}

async function saveDeployState(ctx: DeployContext, state: DeployOperationState): Promise<void> {
  const nextProfile = {
    ...ctx.profile,
    deploy: state,
    instances: {
      ...ctx.profile.instances,
      ...(state.productionInstanceId ? { production: state.productionInstanceId } : {}),
    },
  };
  await setProfile(ctx.profileKey, nextProfile);
  ctx.profile = nextProfile;
}

async function clearDeployState(ctx: DeployContext): Promise<void> {
  const { deploy: _deploy, ...profile } = ctx.profile;
  await setProfile(ctx.profileKey, profile);
  ctx.profile = profile;
}

async function finishDeploy(
  ctx: DeployContext,
  domain: string,
  completedOAuthProviders: readonly string[],
): Promise<void> {
  await clearDeployState(ctx);
  log.blank();
  for (const line of productionSummary(
    domain,
    completedOAuthProviders.map((provider) => providerLabel(provider)),
  )) {
    log.info(line);
  }
  log.blank();
  printNextSteps();
  log.blank();
  closeDeployGutter("success", NEXT_STEPS.DEPLOY);
}

function printNextSteps(): void {
  log.info(NEXT_STEPS_BLOCK);
}

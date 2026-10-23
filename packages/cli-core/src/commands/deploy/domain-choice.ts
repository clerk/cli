import { isAgent } from "../../mode.ts";
import { log } from "../../lib/log.ts";
import { CliError, ERROR_CODE, throwUsageError } from "../../lib/errors.ts";
import {
  createProductionInstance as apiCreateProductionInstance,
  type ProductionInstanceResponse,
} from "../../lib/plapi.ts";
import { outro, withSpinner } from "../../lib/spinner.ts";
import {
  CLERK_APP_NOT_ENABLED,
  clerkAppDomain,
  hostingDomainOffer,
  parseClerkAppSlug,
  requireClerkAppSlug,
  type ClerkAppOffer,
  type ClerkAppSlug,
  type ProductionDomainChoice,
} from "./clerk-app.ts";
import {
  clerkAppCreationSummary,
  domainAssociationSummary,
  hostingCreationSummary,
  hostingOnClerkAppNotice,
  type DeployPlanStep,
} from "./copy.ts";
import { isWebHostName } from "./domains.ts";
import { mapDeployError } from "./errors.ts";
import {
  chooseDomainKind,
  collectClerkAppSlug,
  collectCustomDomain,
  confirmCreateProductionInstance,
  throwInvalidDomainFlag,
  validateDomain,
} from "./prompts.ts";
import type { OAuthProviderDescriptor } from "./providers.ts";
import type { DeployContext } from "./state.ts";

export function parseClerkAppFlag(raw: string): ClerkAppSlug {
  const parsed = parseClerkAppSlug(raw);
  if (!parsed.ok) {
    throwUsageError(
      `Invalid --clerk-app name. ${parsed.message}`,
      undefined,
      ERROR_CODE.CLERK_APP_SLUG_INVALID,
    );
  }
  return parsed.slug;
}

export function throwDomainConflict(domain: string, clerkApp: ClerkAppSlug): never {
  throwUsageError(
    `Production already uses ${domain}, not ${clerkAppDomain(clerkApp)}. ` +
      "Run `clerk deploy` without --clerk-app to resume, or `clerk deploy use-domain <domain>` to change the primary domain.",
    undefined,
    ERROR_CODE.DEPLOY_DOMAIN_CONFLICT,
  );
}

/** Which production domains this run can end up with. */
export type DomainPlan = "own" | "either" | "clerk_app";

const NEW_DEPLOY_DOMAIN_STEPS: Record<DomainPlan, { choose: string; verify: string }> = {
  own: { choose: "Choose a production domain you own", verify: "Verify DNS records" },
  either: { choose: "Choose a production domain", verify: "Verify the domain" },
  clerk_app: { choose: "Use a free clerk.app domain", verify: "Issue SSL certificate" },
};

export function buildNewDeployPlan(
  oauthProviders: readonly OAuthProviderDescriptor[],
  domainPlan: DomainPlan,
): DeployPlanStep[] {
  const steps = NEW_DEPLOY_DOMAIN_STEPS[domainPlan];
  return [
    { label: "Create production instance", status: "pending" },
    { label: steps.choose, status: "pending" },
    ...oauthProviders.map((descriptor) => ({
      label: `Configure ${descriptor.label} OAuth credentials`,
      status: "pending" as const,
    })),
    { label: steps.verify, status: "pending" },
  ];
}

export async function collectProductionDomain(
  appId: string,
  offer: ClerkAppOffer,
): Promise<ProductionDomainChoice> {
  if (!offer.enabled) return { kind: "own", domain: await collectCustomDomain() };
  const kind = await chooseDomainKind();
  if (kind === "own") {
    const domain = (await collectCustomDomain({ clerkAppOffered: true })).toLowerCase();
    if (isWebHostName(domain)) {
      return resolveHostingDomain(appId, domain, { slug: undefined, prompt: true });
    }
    return { kind: "own", domain };
  }
  return { kind: "clerk_app", slug: await collectClerkAppSlug(appId, offer.suggestion) };
}

export type HostingDomainChoice = Extract<ProductionDomainChoice, { kind: "hosting" }>;

/**
 * A hosting domain can't be the primary of an app that can use clerk.app, so
 * production gets a clerk.app primary named after the host and the hosting
 * domain beside it, as in the Clerk Dashboard. Without clerk.app the hosting
 * domain is refused as before.
 */
export async function resolveHostingDomain(
  appId: string,
  domain: string,
  options: { slug: ClerkAppSlug | undefined; prompt: boolean },
): Promise<HostingDomainChoice> {
  const notice = () => {
    if (isAgent()) return;
    log.blank();
    for (const line of hostingOnClerkAppNotice(domain)) log.info(line);
    log.blank();
  };
  if (options.slug) {
    await requireClerkAppSlug(appId, options.slug);
    notice();
    return { kind: "hosting", domain, slug: options.slug };
  }
  const offer = await hostingDomainOffer(appId, domain);
  if (!offer.enabled) {
    const verdict = validateDomain(domain);
    throwInvalidDomainFlag(
      domain,
      verdict === true ? "clerk.app domains aren't available." : verdict,
    );
  }
  notice();
  if (options.prompt) {
    return { kind: "hosting", domain, slug: await collectClerkAppSlug(appId, offer.suggestion) };
  }
  if (!offer.suggestion) {
    throw new CliError(
      `No free clerk.app name was found for ${domain}. No production instance was created. ` +
        `Run \`clerk deploy --domain ${domain} --clerk-app <name>\` to choose one.`,
      { code: ERROR_CODE.CLERK_APP_SLUG_UNAVAILABLE },
    );
  }
  if (!isAgent()) {
    log.info(
      `Using ${clerkAppDomain(offer.suggestion)}. Pass --clerk-app <name> to choose another name.`,
    );
  }
  return { kind: "hosting", domain, slug: offer.suggestion };
}

function createTarget(
  choice: ProductionDomainChoice,
): { domain: string } | { clerk_app_slug: string } | { domain: string; clerk_app_slug: string } {
  switch (choice.kind) {
    case "own":
      return { domain: choice.domain };
    case "clerk_app":
      return { clerk_app_slug: choice.slug };
    case "hosting":
      return { domain: choice.domain, clerk_app_slug: choice.slug };
  }
}

export async function createProductionInstance(
  ctx: DeployContext,
  choice: ProductionDomainChoice,
): Promise<ProductionInstanceResponse | "exists"> {
  const target = createTarget(choice);
  return withSpinner("Creating production instance...", async () => {
    return mapDeployError<ProductionInstanceResponse | "exists">(
      apiCreateProductionInstance(ctx.appId, {
        ...target,
        environment_type: "production",
        clone_instance_id: ctx.developmentInstanceId,
      }),
      {
        onProductionInstanceExists: async () => "exists",
        featureNotEnabledMessage: choice.kind === "own" ? undefined : CLERK_APP_NOT_ENABLED,
      },
    );
  });
}

export async function confirmProductionInstanceCreation(
  choice: ProductionDomainChoice,
  yes = false,
): Promise<boolean> {
  // Separate this screen from the domain the user just typed; without it the
  // echoed answer runs straight into the lead sentence.
  log.blank();
  const summary =
    choice.kind === "own"
      ? domainAssociationSummary(choice.domain)
      : choice.kind === "hosting"
        ? hostingCreationSummary(clerkAppDomain(choice.slug), choice.domain)
        : clerkAppCreationSummary(clerkAppDomain(choice.slug));
  for (const line of summary) log.info(line);
  log.blank();
  const confirmed = yes || (await confirmCreateProductionInstance());
  if (confirmed) {
    log.blank();
    return true;
  }

  log.blank();
  log.info("No production instance was created.");
  await outro("Cancelled");
  return false;
}

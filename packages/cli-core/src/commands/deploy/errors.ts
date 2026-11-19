/**
 * PLAPI deploy error mapping.
 *
 * The handbook (`2026-05-15 clerk-plapi-deploy-endpoints-handbook.md`) maps
 * HTTP status + `code` to a deterministic CLI action. This module is the
 * single place that translation lives — callers wrap PLAPI calls with
 * `mapDeployError(promise, { onProductionInstanceExists })` and either get
 * the resolved value or a typed `CliError` they can branch on.
 */

import { CliError, ERROR_CODE, PlapiError } from "../../lib/errors.ts";

type ProductionInstanceExistsRecovery<T> = () => Promise<T>;

export type MapDeployErrorOptions<T> = {
  /**
   * When PLAPI returns 409 `production_instance_exists` for a creation call,
   * the wizard should re-derive state via `fetchApplication` rather than
   * surfacing the error. Pass a recovery callback here to opt into that path.
   */
  onProductionInstanceExists?: ProductionInstanceExistsRecovery<T>;
  /**
   * Replaces the 404 `resource_not_found` translation, which otherwise reads
   * as the application being gone. Requests for one of its domains pass this:
   * the application was read moments earlier, so the domain's status is what
   * is missing.
   */
  onNotFound?: () => CliError;
  /**
   * `feature_not_enabled` is a generic PLAPI code, so only a caller that knows
   * which feature its request needed can say what was refused.
   */
  featureNotEnabledMessage?: string;
  /** `known_hosting_domain` means something different to a call that adds a domain beside clerk.app. */
  knownHostingDomainMessage?: string;
  /** `custom_domain_beside_clerk_managed_exists` can name the domain only when the caller already read it. */
  customDomainExistsMessage?: string;
};

export async function mapDeployError<T>(
  promise: Promise<T>,
  options: MapDeployErrorOptions<T> = {},
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (!(error instanceof PlapiError)) throw error;
    const recovered = await maybeRecover(error, options);
    if (recovered.recovered) return recovered.value;
    if (
      error.status === 403 &&
      error.code === "feature_not_enabled" &&
      options.featureNotEnabledMessage
    ) {
      throw new CliError(options.featureNotEnabledMessage, {
        code: ERROR_CODE.CLERK_APP_NOT_ENABLED,
      });
    }
    throw translatePlapiError(error, options);
  }
}

type RecoveryOutcome<T> = { recovered: true; value: T } | { recovered: false };

async function maybeRecover<T>(
  error: PlapiError,
  options: MapDeployErrorOptions<T>,
): Promise<RecoveryOutcome<T>> {
  if (error.status === 409 && error.code === "production_instance_exists") {
    if (options.onProductionInstanceExists) {
      return { recovered: true, value: await options.onProductionInstanceExists() };
    }
  }
  return { recovered: false };
}

function translatePlapiError<T>(
  error: PlapiError,
  options: MapDeployErrorOptions<T>,
): CliError | PlapiError {
  const { status, code } = error;

  if (status === 402 && code === "unsupported_subscription_plan_features") {
    return new CliError(planInsufficientMessage(error), {
      code: ERROR_CODE.PLAN_INSUFFICIENT,
      docsUrl: "https://clerk.com/pricing",
    });
  }

  if (status === 400 && code === "provider_domain_operation_not_allowed_for_api") {
    return new CliError(
      "The home URL points to a hosting provider's domain (e.g. *.vercel.app, *.replit.app). " +
        "`clerk deploy` sets up production through DNS records, so it needs a domain you can add them to.",
      { code: ERROR_CODE.PROVIDER_DOMAIN_NOT_ALLOWED },
    );
  }

  if (status === 422 && code === "home_url_taken") {
    return new CliError(
      "Another instance is already using that domain. Pick a different one and run `clerk deploy` again.",
      { code: ERROR_CODE.HOME_URL_TAKEN },
    );
  }

  if (status === 422 && code === "clerk_app_slug_invalid") {
    return new CliError(CLERK_APP_SLUG_FORMAT, { code: ERROR_CODE.CLERK_APP_SLUG_INVALID });
  }

  if (status === 422 && code === "clerk_app_slug_unavailable") {
    return new CliError(
      error.longMessage || "That clerk.app name is not available. Choose another name.",
      { code: ERROR_CODE.CLERK_APP_SLUG_UNAVAILABLE },
    );
  }

  if (status === 422 && code === "clerk_app_domain_exists") {
    return new CliError(CLERK_APP_DOMAIN_EXISTS, { code: ERROR_CODE.CLERK_APP_DOMAIN_EXISTS });
  }

  if (status === 422 && code === "web_host_cannot_be_primary") {
    return new CliError(
      "That is a hosting domain served through the Clerk proxy, so it can't be the primary domain. " +
        "Nothing changed. Run `clerk deploy use-domain <domain>` with a domain you own instead.",
      { code: ERROR_CODE.WEB_HOST_CANNOT_BE_PRIMARY },
    );
  }

  if (status === 422 && code === "hosting_domain_needs_clerk_app") {
    return new CliError(HOSTING_DOMAIN_NEEDS_CLERK_APP, {
      code: ERROR_CODE.HOSTING_DOMAIN_NEEDS_CLERK_APP,
    });
  }

  if (status === 422 && code === "known_hosting_domain") {
    return new CliError(
      options.knownHostingDomainMessage ??
        "That is a hosting domain, so it can't be a production domain. Use a domain you own.",
      { code: ERROR_CODE.KNOWN_HOSTING_DOMAIN },
    );
  }

  if (status === 422 && code === "custom_domain_beside_clerk_managed_exists") {
    return new CliError(
      options.customDomainExistsMessage ??
        "Production can have only one domain you own beside its clerk.app domain, and it already has one. " +
          "Nothing was added. Run `clerk deploy domains` to see it.",
      { code: ERROR_CODE.CUSTOM_DOMAIN_BESIDE_CLERK_MANAGED_EXISTS },
    );
  }

  if (status === 403 && code === "primary_switch_not_allowed") {
    return new CliError(
      "`clerk deploy use-domain` moves production off its clerk.app domain to a domain you own, " +
        "and production isn't on its clerk.app domain now. A clerk.app domain can't become the primary domain again. " +
        "Nothing changed. Change the primary domain in the Clerk Dashboard instead.",
      { code: ERROR_CODE.PRIMARY_NOT_CLERK_MANAGED },
    );
  }

  if (status === 422 && code === "form_identifier_exists" && readParamName(error.meta) === "name") {
    return new CliError(
      "That domain is already added to a Clerk instance. Remove it there first, or choose another.",
      { code: ERROR_CODE.DOMAIN_TAKEN },
    );
  }

  if (status === 422 && code === "domain_not_ready_for_primary") {
    const missing = readMissingChecks(error.meta);
    return new CliError(
      missing.length > 0
        ? `This domain can't become primary until these checks pass: ${missing.join(", ")}.`
        : "This domain can't become primary until its DNS, SSL, and email checks pass.",
      { code: ERROR_CODE.DOMAIN_NOT_READY },
    );
  }

  if (status === 409 && code === "production_instance_exists") {
    // Reached only when the caller did NOT pass onProductionInstanceExists.
    // Surface a typed error so any future call site can branch on it.
    return new CliError(
      "This application already has a production instance. Run `clerk deploy` to resume the existing flow.",
      { code: ERROR_CODE.PRODUCTION_INSTANCE_EXISTS },
    );
  }

  if (status === 404 && code === "resource_not_found") {
    if (options.onNotFound) return options.onNotFound();
    return new CliError(
      "Clerk couldn't find this application (it may have been deleted or your workspace no longer has access). " +
        "Run `clerk link` to re-link this directory.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  if (status === 422 && code === "form_param_format_invalid") {
    const paramName = readParamName(error.meta);
    const baseMessage = error.message || "A request parameter was invalid.";
    const message = paramName ? `${baseMessage} (parameter: ${paramName})` : baseMessage;
    return new CliError(message, { code: ERROR_CODE.FORM_PARAM_INVALID });
  }

  // Pass everything else through unchanged — the global handler prints the
  // PLAPI message with a "Platform API request failed" prefix.
  return error;
}

export const CLERK_APP_SLUG_FORMAT =
  "Use 3 to 63 lowercase letters, numbers, and hyphens, with no hyphen at the start or end.";

export const HOSTING_DOMAIN_NEEDS_CLERK_APP =
  "Clerk treats that domain as a hosting domain, so it can't be production's primary domain. " +
  "No production instance was created. Run `clerk deploy` again and choose Use a free clerk.app domain, " +
  "then add the hosting domain with `clerk deploy add-domain <domain>`, where Clerk runs through a /__clerk route in your app.";

export const CLERK_APP_DOMAIN_EXISTS =
  "This instance already has a clerk.app domain. Nothing was added.";

export const READINESS_LABELS = {
  dns: "DNS",
  ssl: "SSL",
  email: "email DNS",
} as const;

function readMissingChecks(meta: Record<string, unknown> | null): string[] {
  const missing = meta?.missing;
  if (!Array.isArray(missing)) return [];
  return missing
    .filter((check): check is string => typeof check === "string")
    .map((check) => READINESS_LABELS[check as keyof typeof READINESS_LABELS] ?? check);
}

function planInsufficientMessage(error: PlapiError): string {
  const features = readFeatures(error.meta);
  if (features.length === 0) {
    return (
      "Your subscription plan doesn't cover all the features enabled in your development instance. " +
      "Upgrade your plan from the Clerk Dashboard before deploying."
    );
  }
  return (
    "Your subscription plan doesn't cover these features enabled in development:\n" +
    features.map((f) => `  • ${f}`).join("\n") +
    "\n\nUpgrade your plan from the Clerk Dashboard or disable these features in development before deploying."
  );
}

function readFeatures(meta: Record<string, unknown> | null): string[] {
  if (!meta) return [];
  const features = meta.unsupported_features;
  if (!Array.isArray(features)) return [];
  return features.filter((f): f is string => typeof f === "string");
}

function readParamName(meta: Record<string, unknown> | null): string | undefined {
  if (!meta) return undefined;
  const value = meta.param_name;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

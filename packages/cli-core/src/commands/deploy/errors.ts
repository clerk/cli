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
    throw translatePlapiError(error);
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

function translatePlapiError(error: PlapiError): CliError | PlapiError {
  const { status, code } = error;

  if (status === 402 && code === "unsupported_subscription_plan_features") {
    return new CliError(planInsufficientMessage(error), {
      code: ERROR_CODE.PLAN_INSUFFICIENT,
      docsUrl: "https://clerk.com/pricing",
    });
  }

  if (status === 400 && code === "provider_domain_operation_not_allowed_for_api") {
    return new CliError(
      "The home URL points to a provider domain (e.g. *.vercel.app, *.replit.app). " +
        "Production instances require a domain you own — use a custom domain instead.",
      { code: ERROR_CODE.PROVIDER_DOMAIN_NOT_ALLOWED },
    );
  }

  if (status === 400 && code === "home_url_taken") {
    return new CliError(
      "Another instance is already using that home URL. Pick a different domain and run `clerk deploy` again.",
      { code: ERROR_CODE.HOME_URL_TAKEN },
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
  const features = meta.features;
  if (!Array.isArray(features)) return [];
  return features.filter((f): f is string => typeof f === "string");
}

function readParamName(meta: Record<string, unknown> | null): string | undefined {
  if (!meta) return undefined;
  const value = meta.param_name;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

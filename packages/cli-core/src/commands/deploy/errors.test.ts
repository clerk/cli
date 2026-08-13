import { describe, expect, test } from "bun:test";
import { CliError, ERROR_CODE, PlapiError } from "../../lib/errors.ts";
import { mapDeployError } from "./errors.ts";

function plapiError(status: number, code: string, message = "long message"): PlapiError {
  return new PlapiError(
    status,
    JSON.stringify({ errors: [{ code, long_message: message, message }] }),
    "https://api.clerk.com/v1/platform/applications/app_1/domain",
  );
}

async function mapped(error: PlapiError): Promise<CliError | PlapiError> {
  try {
    await mapDeployError(Promise.reject(error));
  } catch (caught) {
    return caught as CliError | PlapiError;
  }
  throw new Error("expected mapDeployError to reject");
}

describe("mapDeployError", () => {
  // The real codes and statuses, from clerk_go: apierror.KnownHostingDomain and
  // apierror.HomeURLTaken are 422 (api/apierror/home_url.go), and
  // ProviderDomainOperationNotAllowedForAPI is 403 under the code
  // `provider_domain_operation_not_allowed` (no `_for_api` suffix).
  test("translates a known hosting domain rejection", async () => {
    const error = await mapped(plapiError(422, "known_hosting_domain"));

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.PROVIDER_DOMAIN_NOT_ALLOWED);
  });

  test("translates a provider domain rejection at its real 403 status", async () => {
    const error = await mapped(plapiError(403, "provider_domain_operation_not_allowed"));

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.PROVIDER_DOMAIN_NOT_ALLOWED);
  });

  test("translates a taken home URL at its real 422 status", async () => {
    const error = await mapped(plapiError(422, "home_url_taken"));

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.HOME_URL_TAKEN);
    expect(error.message).toContain("already using that home URL");
  });

  // The domain is fine here; the proxy derivation failed. Sharing a code with
  // an outright rejection would send the user off to pick a new domain.
  test("distinguishes a missing proxy from a rejected domain", async () => {
    const error = await mapped(plapiError(422, "proxy_url_required_for_provider_domain"));

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.PROXY_URL_REQUIRED);
    expect(error.message).toContain("proxy");
  });

  test("passes unrelated errors through untouched", async () => {
    const original = plapiError(500, "internal_error");

    expect(await mapped(original)).toBe(original);
  });
});

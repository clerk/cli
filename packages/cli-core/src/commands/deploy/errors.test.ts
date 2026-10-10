import { describe, expect, test } from "bun:test";
import { mapDeployError } from "./errors.ts";
import { CliError, ERROR_CODE, PlapiError } from "../../lib/errors.ts";

const plapiError = (status: number, code: string, meta?: Record<string, unknown>) =>
  new PlapiError(
    status,
    JSON.stringify({ errors: [{ code, message: code, ...(meta ? { meta } : {}) }] }),
    "https://x",
  );

const planError = (meta?: Record<string, unknown>) =>
  plapiError(402, "unsupported_subscription_plan_features", meta);

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

describe("mapDeployError", () => {
  test("lists unsupported features from meta.unsupported_features on 402", async () => {
    const error = await rejectionOf(
      mapDeployError(
        Promise.reject(
          planError({ unsupported_features: ["app:allowlist", "app:remove_branding"] }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.code).toBe(ERROR_CODE.PLAN_INSUFFICIENT);
    expect(cliError.docsUrl).toBe("https://clerk.com/pricing");
    expect(cliError.message).toContain("• app:allowlist");
    expect(cliError.message).toContain("• app:remove_branding");
    expect(cliError.message).not.toContain("doesn't cover all the features");
  });

  test("falls back to the generic plan message when unsupported_features is empty", async () => {
    const error = await rejectionOf(
      mapDeployError(Promise.reject(planError({ unsupported_features: [] }))),
    );

    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.code).toBe(ERROR_CODE.PLAN_INSUFFICIENT);
    expect(cliError.message).toContain("doesn't cover all the features");
    expect(cliError.message).not.toContain("•");
  });

  // Statuses are the ones clerk_go's api/apierror returns.
  test.each([
    [400, "production_instance_exists", ERROR_CODE.PRODUCTION_INSTANCE_EXISTS],
    [422, "home_url_taken", ERROR_CODE.HOME_URL_TAKEN],
    [403, "provider_domain_operation_not_allowed", ERROR_CODE.PROVIDER_DOMAIN_NOT_ALLOWED],
  ])("maps %i %s to %s", async (status, code, expected) => {
    const error = await rejectionOf(mapDeployError(Promise.reject(plapiError(status, code))));

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(expected);
  });

  test.each([
    "production_instance_exists",
    "home_url_taken",
    "provider_domain_operation_not_allowed",
  ])("maps %s whatever the status", async (code) => {
    const error = await rejectionOf(mapDeployError(Promise.reject(plapiError(418, code))));

    expect(error).toBeInstanceOf(CliError);
  });

  test("recovers from 400 production_instance_exists when a recovery is passed", async () => {
    const result = await mapDeployError<string>(
      Promise.reject(plapiError(400, "production_instance_exists")),
      { onProductionInstanceExists: async () => "exists" },
    );

    expect(result).toBe("exists");
  });

  // Both are 422 and both carry meta.param_name; only the code tells them apart.
  test.each([
    ["home_url_taken", ERROR_CODE.HOME_URL_TAKEN],
    ["form_param_format_invalid", ERROR_CODE.FORM_PARAM_INVALID],
  ])("422 %s with meta.param_name maps to %s", async (code, expected) => {
    const error = await rejectionOf(
      mapDeployError(Promise.reject(plapiError(422, code, { param_name: "domain" }))),
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(expected);
  });
});

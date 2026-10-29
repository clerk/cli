import { describe, expect, test } from "bun:test";
import { mapDeployError } from "./errors.ts";
import { CliError, ERROR_CODE, PlapiError } from "../../lib/errors.ts";

const planError = (meta?: Record<string, unknown>) =>
  new PlapiError(
    402,
    JSON.stringify({
      errors: [
        {
          code: "unsupported_subscription_plan_features",
          message: "unsupported plan features",
          ...(meta ? { meta } : {}),
        },
      ],
    }),
    "https://x",
  );

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

  // A 404 reads as the application being gone unless the request says
  // otherwise: requests for one of its domains do, since the application was
  // read moments earlier.
  const notFound = () =>
    new PlapiError(404, JSON.stringify({ errors: [{ code: "resource_not_found" }] }), "https://x");

  test("a 404 means the application is gone by default", async () => {
    const error = await rejectionOf(mapDeployError(Promise.reject(notFound())));

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.NOT_LINKED);
    expect((error as CliError).message).toContain("Run `clerk link` to re-link this directory.");
  });

  test("onNotFound replaces the 404 translation", async () => {
    const replacement = new CliError("domain status not readable", {
      code: ERROR_CODE.DEPLOY_INSTANCE_UNRESOLVED,
    });

    const error = await rejectionOf(
      mapDeployError(Promise.reject(notFound()), { onNotFound: () => replacement }),
    );

    expect(error).toBe(replacement);
  });

  // True of `clerk deploy`, not of Clerk: the backend can put production on
  // some providers' domains through a proxy that this create doesn't set up.
  test("a provider-domain refusal says why clerk deploy can't use the domain", async () => {
    const providerDomain = new PlapiError(
      400,
      JSON.stringify({ errors: [{ code: "provider_domain_operation_not_allowed_for_api" }] }),
      "https://x",
    );

    const error = await rejectionOf(mapDeployError(Promise.reject(providerDomain)));

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.PROVIDER_DOMAIN_NOT_ALLOWED);
    expect((error as CliError).message).toBe(
      "The home URL points to a hosting provider's domain (e.g. *.vercel.app, *.replit.app). " +
        "`clerk deploy` sets up production through DNS records, so it needs a domain you can add them to.",
    );
  });
});

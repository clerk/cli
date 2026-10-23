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
  const plapiError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
    new PlapiError(
      status,
      JSON.stringify({ errors: [{ code, message: code, ...extra }] }),
      "https://x",
    );

  test.each([
    [422, "clerk_app_slug_invalid", {}, ERROR_CODE.CLERK_APP_SLUG_INVALID, "3 to 63"],
    [
      422,
      "clerk_app_slug_unavailable",
      { long_message: "acme.clerk.app is not available. Choose another name." },
      ERROR_CODE.CLERK_APP_SLUG_UNAVAILABLE,
      "acme.clerk.app is not available",
    ],
    [
      422,
      "domain_not_ready_for_primary",
      { meta: { missing: ["dns", "email"] } },
      ERROR_CODE.DOMAIN_NOT_READY,
      "these checks pass: DNS, email DNS.",
    ],
    [422, "home_url_taken", {}, ERROR_CODE.HOME_URL_TAKEN, "already using that domain"],
    [
      422,
      "clerk_managed_domain_refuses_email_links",
      {},
      ERROR_CODE.CLERK_MANAGED_DOMAIN_REFUSES_EMAIL_LINKS,
      "Turn off email links in the Clerk Dashboard",
    ],
    [
      422,
      "web_host_cannot_be_primary",
      {},
      ERROR_CODE.WEB_HOST_CANNOT_BE_PRIMARY,
      "with a domain you own instead",
    ],
    [
      422,
      "custom_domain_beside_clerk_managed_exists",
      {},
      ERROR_CODE.CUSTOM_DOMAIN_BESIDE_CLERK_MANAGED_EXISTS,
      "only one domain you own beside its clerk.app domain",
    ],
    [
      403,
      "primary_switch_not_allowed",
      {},
      ERROR_CODE.PRIMARY_NOT_CLERK_MANAGED,
      "production isn't on its clerk.app domain now. Nothing changed.",
    ],
    [
      422,
      "known_hosting_domain",
      {},
      ERROR_CODE.KNOWN_HOSTING_DOMAIN,
      "That is a hosting domain, so it can't be a production domain. Use a domain you own.",
    ],
  ] as [number, string, Record<string, unknown>, string, string][])(
    "maps %i %s to a typed CliError",
    async (status, code, extra, cliCode, message) => {
      const error = await rejectionOf(
        mapDeployError(Promise.reject(plapiError(status, code, extra))),
      );

      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe(cliCode as never);
      expect((error as CliError).message).toContain(message);
    },
  );

  test("never mentions clerk.app on a hosting name unless the caller adds a domain", async () => {
    const refused = () =>
      new PlapiError(422, JSON.stringify({ errors: [{ code: "known_hosting_domain" }] }), "x");

    const unscoped = await rejectionOf(mapDeployError(Promise.reject(refused())));
    const scoped = await rejectionOf(
      mapDeployError(Promise.reject(refused()), { knownHostingDomainMessage: "Not supported." }),
    );

    expect((unscoped as CliError).message).not.toContain("clerk.app");
    expect((unscoped as CliError).message).not.toContain("add-domain");
    expect((scoped as CliError).message).toBe("Not supported.");
  });

  test("names the refused feature only when the caller says which one it was", async () => {
    const refused = () =>
      new PlapiError(403, JSON.stringify({ errors: [{ code: "feature_not_enabled" }] }), "x");

    const scoped = await rejectionOf(
      mapDeployError(Promise.reject(refused()), { featureNotEnabledMessage: "No clerk.app." }),
    );
    const unscoped = await rejectionOf(mapDeployError(Promise.reject(refused())));

    expect((scoped as CliError).code).toBe(ERROR_CODE.CLERK_APP_NOT_ENABLED);
    expect((scoped as CliError).message).toBe("No clerk.app.");
    expect(unscoped).toBeInstanceOf(PlapiError);
  });
});

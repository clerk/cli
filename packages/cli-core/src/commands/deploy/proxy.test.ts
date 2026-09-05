import { describe, expect, test } from "bun:test";
import type { ApplicationDomain } from "../../lib/plapi.ts";
import { needsProxyDerivation } from "./proxy.ts";

function domain(overrides: Partial<ApplicationDomain> = {}): ApplicationDomain {
  return {
    object: "domain",
    id: "dmn_1",
    name: "example.com",
    is_satellite: false,
    is_provider_domain: false,
    frontend_api_url: "https://clerk.example.com",
    development_origin: "",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("needsProxyDerivation", () => {
  // POST /v1/platform/applications/{id}/instances creates the domain without
  // deriving a proxy URL, unlike every other domain-creating path. The PATCH
  // that follows is what makes a provider domain usable.
  test("is true for a provider domain the instances endpoint left unproxied", () => {
    expect(
      needsProxyDerivation(domain({ name: "my-app.vercel.app", is_provider_domain: true })),
    ).toBe(true);
  });

  test("is false once the domain already carries a proxy URL", () => {
    expect(
      needsProxyDerivation(
        domain({
          name: "my-app.vercel.app",
          is_provider_domain: true,
          proxy_url: "https://my-app.vercel.app/__clerk",
        }),
      ),
    ).toBe(false);
  });

  test("is false for an ordinary custom domain that verifies by CNAME", () => {
    expect(needsProxyDerivation(domain())).toBe(false);
  });

  // The flag comes from the API (`is_provider_domain`), so the CLI never has
  // to keep its own list of provider suffixes in sync with the backend.
  test("ignores the domain name and trusts the API flag", () => {
    expect(needsProxyDerivation(domain({ name: "my-app.vercel.app" }))).toBe(false);
    expect(needsProxyDerivation(domain({ name: "example.com", is_provider_domain: true }))).toBe(
      true,
    );
  });
});

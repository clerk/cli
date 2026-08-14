/**
 * Provider-domain proxy setup.
 *
 * Clerk supports hosting-provider domains (`*.vercel.app`, `*.replit.app`) as
 * production domains. They can't carry Clerk's CNAME records, so Clerk reaches
 * the Frontend API through a proxy on the domain itself instead —
 * `https://<domain>/__clerk`.
 *
 * Every endpoint that creates such a domain derives that proxy URL server-side
 * except the one `clerk deploy` uses: `POST /v1/platform/applications/{id}/
 * instances` stores the domain verbatim and derives nothing. Without a proxy
 * URL the domain's CNAMEs stay *required* (`model/cname.go`), so DNS never
 * completes and the deploy parks forever on records nobody can add under
 * `vercel.app`.
 *
 * `PATCH /v1/platform/applications/{id}/domain` runs the normalization the
 * create call skipped: re-sending the current name makes the API derive the
 * proxy path, validate the domain, and schedule the proxy check. Renaming to
 * an unchanged value is a no-op server-side, so the request carries no risk
 * beyond the derivation it exists to trigger.
 */

import { updateApplicationDomain, type ApplicationDomain } from "../../lib/plapi.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { mapDeployError } from "./errors.ts";

/** The parts of a domain that decide whether it still needs a proxy URL. */
export type ProxyDomain = Pick<ApplicationDomain, "name" | "is_provider_domain"> & {
  proxy_url?: string;
};

/**
 * Whether the API still owes this domain a proxy URL. Reads the API's own
 * `is_provider_domain` flag rather than matching suffixes, so the CLI never
 * has to track which providers Clerk supports.
 */
export function needsProxyDerivation(domain: ProxyDomain): boolean {
  return domain.is_provider_domain && !domain.proxy_url;
}

/**
 * The proxy URL Clerk serves this domain through, asking the API to derive one
 * when the instance-creation call didn't. Returns undefined for ordinary
 * domains, which verify by CNAME and have no proxy.
 */
export async function resolveProviderDomainProxyUrl(
  appId: string,
  domain: ProxyDomain,
): Promise<string | undefined> {
  if (!needsProxyDerivation(domain)) return domain.proxy_url;

  const updated = await mapDeployError(updateApplicationDomain(appId, { name: domain.name }));
  if (!updated.proxy_url) {
    throw new CliError("Clerk did not return a proxy URL for this provider domain.", {
      code: ERROR_CODE.PROXY_URL_REQUIRED,
    });
  }
  return updated.proxy_url;
}

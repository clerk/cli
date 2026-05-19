/**
 * Detect whether the registrar for `domain` supports Domain Connect and
 * return the prefilled URL if so. Currently a placeholder that returns the
 * Cloudflare template unconditionally; a real implementation would look up
 * NS records and match the registrar against a provider table.
 *
 * FIXME(deploy): replace with NS-based registrar detection. Today every
 * caller is told their registrar is Cloudflare regardless of reality.
 */
export function domainConnectUrl(domain: string): string | undefined {
  return `https://domainconnect.cloudflare.com/v2/domainTemplates/providers/clerk.com/services/clerk-production/apply?domain=${domain}`;
}

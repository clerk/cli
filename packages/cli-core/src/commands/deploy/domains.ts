import { listApplicationDomains, type ApplicationDomain } from "../../lib/plapi.ts";
import { withSpinner } from "../../lib/spinner.ts";

/**
 * Hosting providers whose URLs PLAPI makes a hosting domain beside a clerk.app
 * domain. PLAPI routes each name itself, so `add-domain` reads this only to
 * refuse the other hosting names in `PROVIDER_DOMAIN_SUFFIXES`, which PLAPI
 * would add as a domain you own. PLAPI also reads extra suffixes from
 * `FLAG_PROVIDER_DOMAIN_SUFFIXES`, so this copy can lag the server's list.
 */
export const WEB_HOST_SUFFIXES = [
  "vercel.app",
  "replit.app",
  "emergent.host",
  "emergentagent.com",
  "web.app",
  "onrender.com",
  "netlify.app",
  "herokuapp.com",
  "fly.dev",
  "up.railway.app",
] as const;

export function isWebHostName(host: string): boolean {
  return WEB_HOST_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`));
}

/**
 * Hosting names the domain prompt refuses as a production domain you own, and
 * `add-domain` refuses unless they are in `WEB_HOST_SUFFIXES`. The Platform
 * API creates production on any of these, though only the provider can add
 * DNS records under them. `.render.com` also covers Render's shared
 * `app.render.com`.
 */
export const PROVIDER_DOMAIN_SUFFIXES = [
  ".clerk.app",
  ".vercel.app",
  ".netlify.app",
  ".pages.dev",
  ".workers.dev",
  ".fly.dev",
  ".render.com",
  ".onrender.com",
  ".herokuapp.com",
  ".replit.app",
  ".replit.dev",
  ".railway.app",
  ".emergent.host",
  ".emergentagent.com",
  ".web.app",
  ".firebaseapp.com",
  ".hosted.app",
  ".github.io",
  ".lovable.app",
  ".bolt.host",
  ".base44.app",
] as const;

/**
 * The issuer a backend sees on session tokens from apps on `domain`. Older
 * PLAPI versions don't send `session_token_issuer`, and on those it is the
 * Frontend API URL of every non-satellite domain.
 */
export function sessionTokenIssuer(domain: ApplicationDomain): string | undefined {
  return domain.session_token_issuer ?? (domain.is_satellite ? undefined : domain.frontend_api_url);
}

export async function listDomains(appId: string): Promise<ApplicationDomain[]> {
  const response = await withSpinner("Reading production domains...", async () =>
    listApplicationDomains(appId),
  );
  return response.data;
}

/**
 * The destination instance's live user settings: which identifiers it accepts
 * and requires, and which social providers it has enabled.
 *
 * Ported from the standalone migration-tool's `src/lib/clerk.ts`, rewritten
 * onto the CLI's own primitives: the FAPI host comes from BAPI `/v1/domains`
 * — a secret key is all `migrate run` is given — and the settings come from
 * `lib/fapi.ts` rather than a bespoke fetch.
 */

import { bapiRequest } from "../../../lib/bapi.ts";
import {
  bootstrapDevBrowser,
  fetchUserSettings,
  type UserSettingsJSON,
} from "../../../lib/fapi.ts";
import { log } from "../../../lib/log.ts";
import { detectInstanceType } from "./instance.ts";

/**
 * Supabase provider keys whose Clerk strategy is not simply `oauth_<key>`.
 *
 * Everything not listed here maps by prefix, which covers google, github,
 * discord, spotify, twitch, notion, figma, gitlab, bitbucket and the rest.
 */
const CLERK_STRATEGY_ALIASES: Record<string, string> = {
  azure: "oauth_microsoft",
  twitter: "oauth_x",
  slack_oidc: "oauth_slack",
  fly: "oauth_fly",
};

/** Supabase's provider key as Clerk's OAuth strategy name. */
export function toClerkStrategy(provider: string): string {
  return CLERK_STRATEGY_ALIASES[provider] ?? `oauth_${provider}`;
}

/** Human label for a provider key, for report output. */
export function providerLabel(provider: string): string {
  const special: Record<string, string> = {
    github: "GitHub",
    gitlab: "GitLab",
    linkedin_oidc: "LinkedIn (OIDC)",
    slack_oidc: "Slack (OIDC)",
    twitter: "Twitter (X)",
    azure: "Microsoft (Azure)",
    workos: "WorkOS",
    fly: "Fly.io",
  };
  return special[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * The Frontend API host of the instance a secret key addresses.
 *
 * `/v1/instance` carries no publishable key — for any instance, linked or not
 * — so the primary domain's `frontend_api_url` is the only route from a secret
 * key to the host its settings live behind. Every instance has at least one
 * domain; satellites share the primary's Frontend API, so ordering only
 * matters for tidiness.
 */
async function fetchFapiHost(secretKey: string): Promise<string | null> {
  const response = await bapiRequest({ method: "GET", path: "/v1/domains", secretKey });
  const domains = (response.body as { data?: unknown })?.data;
  if (!Array.isArray(domains)) return null;

  const primary =
    domains.find((domain) => !(domain as { is_satellite?: boolean }).is_satellite) ?? domains[0];
  const frontendApiUrl = (primary as { frontend_api_url?: unknown })?.frontend_api_url;
  if (typeof frontendApiUrl !== "string" || !frontendApiUrl) return null;

  return new URL(frontendApiUrl).host;
}

/**
 * Fetches the user settings for the instance a secret key addresses.
 *
 * @returns The settings, or `null` when they could not be read. Callers must
 *   treat `null` as "unknown" rather than as "nothing is enabled" — the
 *   readiness report degrades to a note, and provider skipping stands down.
 */
export async function fetchInstanceSettings(secretKey: string): Promise<UserSettingsJSON | null> {
  try {
    const fapiHost = await fetchFapiHost(secretKey);
    if (!fapiHost) {
      log.debug("migrate: no domain on this instance named a Frontend API URL");
      return null;
    }

    // Development FAPI rejects an environment request without a dev browser JWT.
    const jwt =
      detectInstanceType(secretKey) === "dev" ? await bootstrapDevBrowser(fapiHost) : undefined;
    return await fetchUserSettings(fapiHost, jwt ? { jwt } : {});
  } catch (error) {
    log.debug(
      `migrate: could not read instance settings: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/** The enabled social strategies (`oauth_google`, …) in a settings payload. */
export function enabledSocialProviders(settings: UserSettingsJSON): string[] {
  return Object.entries(settings.social ?? {})
    .filter(([, value]) => value?.enabled)
    .map(([strategy]) => strategy);
}

/**
 * Convenience wrapper for callers that only need the enabled strategies.
 *
 * @returns `null` when the instance settings could not be read.
 */
export async function fetchEnabledSocialProviders(secretKey: string): Promise<string[] | null> {
  const settings = await fetchInstanceSettings(secretKey);
  return settings ? enabledSocialProviders(settings) : null;
}

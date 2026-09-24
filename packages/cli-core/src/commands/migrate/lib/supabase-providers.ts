/**
 * Cross-references the social providers in a Supabase export against what the
 * destination Clerk instance has enabled.
 *
 * Ported from the standalone migration-tool's `src/lib/supabase.ts`, minus its
 * hand-rolled CSV parser — the export is read through the same
 * `readRawUsers` path every other Supabase read uses.
 */

import { readRawUsers } from "./transform.ts";

/**
 * Supabase lists these alongside social providers in `providers`, but they are
 * built into Clerk and can never be "not enabled".
 */
export const NON_SOCIAL_PROVIDERS = new Set(["email", "phone", "anonymous_users"]);

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Reads a user's auth providers from `raw_app_meta_data`.
 *
 * The column arrives as a JSON string from a CSV export and as an object from
 * a JSON one, and its `providers` value is itself sometimes a string.
 */
export function getUserProviders(user: Record<string, unknown>): string[] {
  const appMeta = parseMaybeJson(user.raw_app_meta_data);
  if (!appMeta || typeof appMeta !== "object" || Array.isArray(appMeta)) return [];

  const providers = parseMaybeJson((appMeta as Record<string, unknown>).providers);
  if (Array.isArray(providers)) {
    return providers.map((provider) => String(provider).trim()).filter(Boolean);
  }
  if (typeof providers === "string") {
    return providers
      .split(/[,|]/)
      .map((provider) => provider.trim())
      .filter(Boolean);
  }
  return [];
}

export type ProviderExclusions = {
  /** Source IDs of users to skip. */
  excludedIds: Set<string>;
  /** How many excluded users each disabled provider accounts for. */
  byProvider: Record<string, number>;
};

/**
 * Finds the users whose *only* way in is a provider Clerk does not have
 * enabled.
 *
 * A user keeps their place if any one of their providers still works —
 * including email and phone. Excluding on "has at least one disabled provider"
 * instead would drop users who could sign in perfectly well another way.
 *
 * @param disabled - Supabase provider keys not enabled in Clerk.
 */
export function findUsersWithOnlyDisabledProviders(
  users: Record<string, unknown>[],
  disabled: string[],
): ProviderExclusions {
  const empty: ProviderExclusions = { excludedIds: new Set(), byProvider: {} };
  if (disabled.length === 0) return empty;

  const disabledSet = new Set(disabled);
  const excludedIds = new Set<string>();
  const byProvider: Record<string, number> = {};

  for (const user of users) {
    const providers = getUserProviders(user);
    // No provider data means no basis to exclude — err towards importing.
    if (providers.length === 0) continue;

    const hasUsableProvider = providers.some(
      (provider) => NON_SOCIAL_PROVIDERS.has(provider) || !disabledSet.has(provider),
    );
    if (hasUsableProvider) continue;

    excludedIds.add(String(user.id));
    for (const provider of providers.filter((p) => disabledSet.has(p))) {
      byProvider[provider] = (byProvider[provider] ?? 0) + 1;
    }
  }

  return { excludedIds, byProvider };
}

/** Counts users per provider across the export, for reporting. */
export function countProviders(users: Record<string, unknown>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const user of users) {
    for (const provider of getUserProviders(user)) {
      counts[provider] = (counts[provider] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * The same counts, minus Supabase's pseudo-providers.
 *
 * Supabase lists `email` and `phone` in `providers` next to real connections,
 * but Clerk has no `oauth_email` to enable — so anything cross-referencing
 * against the instance's social settings must drop them, or every
 * password-based user reads as "not enabled in Clerk".
 */
export function countSocialProviders(users: Record<string, unknown>[]): Record<string, number> {
  return Object.fromEntries(
    Object.entries(countProviders(users)).filter(
      ([provider]) => !NON_SOCIAL_PROVIDERS.has(provider),
    ),
  );
}

/**
 * Every social provider present in the export that Clerk does not have
 * enabled.
 *
 * @param enabledStrategies - Clerk strategy names (`oauth_google`, …).
 * @param toStrategy - Maps a Supabase provider key to its Clerk strategy.
 */
export function findDisabledProviders(
  users: Record<string, unknown>[],
  enabledStrategies: string[],
  toStrategy: (provider: string) => string,
): string[] {
  const enabled = new Set(enabledStrategies);
  return Object.keys(countSocialProviders(users)).filter(
    (provider) => !enabled.has(toStrategy(provider)),
  );
}

/** Reads a Supabase export and returns its raw rows for provider analysis. */
export async function readSupabaseRows(file: string): Promise<Record<string, unknown>[]> {
  return readRawUsers(file, "supabase");
}

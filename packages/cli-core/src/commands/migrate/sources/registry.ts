/**
 * Source registry.
 *
 * `migrate import` resolves `--source` here.
 *
 * To add a platform: create `sources/<platform>.ts` exporting a `SourceEntry`,
 * then add it to the array below.
 */

import { throwUsageError } from "../../../lib/errors.ts";
import type { SourceEntry } from "../types.ts";
import clerkSource from "./clerk.ts";
import supabaseSource from "./supabase.ts";

export const sources: SourceEntry[] = [clerkSource, supabaseSource];

export const ACCOUNT_LINKING_URL =
  "https://clerk.com/docs/guides/configure/auth-strategies/social-connections/account-linking";

/**
 * What happens to social sign-ins, the same for every source.
 *
 * No export carries a user's OAuth connections, and none needs to: once the
 * provider is enabled in Clerk, the user signs in with it and Clerk links the
 * account to the imported user by verified email.
 */
export const ACCOUNT_LINKING_NOTE =
  "Social sign-ins are not copied. Enable the same providers in Clerk, and a user who signs in " +
  `with one is linked to their imported account by verified email. See ${ACCOUNT_LINKING_URL}`;

/** The built-in keys, for tab-completion and error messages. */
export function sourceKeys(): string[] {
  return sources.map((entry) => entry.key);
}

/**
 * Looks up a source by key.
 *
 * @throws Error when no source is registered under that key.
 */
export function getSource(key: string): SourceEntry {
  const source = sources.find((entry) => entry.key === key);
  if (!source) {
    throw new Error(`Source not found for key: ${key}`);
  }
  return source;
}

/** A resolved `--source`. */
export type ResolvedSource = { key: string; entry: SourceEntry };

/**
 * Resolves `--source` to a built-in source.
 *
 * @throws UsageError for an unknown key, listing the valid ones.
 */
export async function resolveSource(value: string): Promise<ResolvedSource> {
  const entry = sources.find((candidate) => candidate.key === value);
  if (!entry) {
    throwUsageError(`Unknown source "${value}". Valid sources: ${sourceKeys().join(", ")}.`);
  }
  return { key: entry.key, entry };
}

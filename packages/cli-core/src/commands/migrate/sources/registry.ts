/**
 * Source registry.
 *
 * `migrate import` resolves `--source` here, and `migrate sources` lists what
 * each one brings across.
 *
 * To add a platform: create `sources/<platform>.ts` exporting a `SourceEntry`,
 * then add it to the array below.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { throwUsageError } from "../../../lib/errors.ts";
import type { SourceEntry } from "../types.ts";
import auth0Source from "./auth0.ts";
import authjsSource from "./authjs.ts";
import betterAuthSource from "./betterauth.ts";
import clerkSource from "./clerk.ts";
import firebaseSource from "./firebase.ts";
import { loadCustomSource } from "./load-custom.ts";
import supabaseSource from "./supabase.ts";
import workosSource from "./workos.ts";

export const sources: SourceEntry[] = [
  clerkSource,
  auth0Source,
  authjsSource,
  betterAuthSource,
  firebaseSource,
  supabaseSource,
  workosSource,
];

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

/**
 * A source loaded from a user's `--source <path>` for this invocation.
 *
 * Kept beside the built-ins rather than pushed into them, so the shipped list
 * is never mutated. One invocation loads at most one, so this holding a
 * single entry is the normal case; the array shape just avoids a special case
 * in the lookups.
 */
const customSources: SourceEntry[] = [];

export function registerCustomSource(entry: SourceEntry): void {
  // The latest load of a key wins: an edited source replaces its old self.
  const earlier = customSources.findIndex((source) => source.key === entry.key);
  if (earlier >= 0) customSources.splice(earlier, 1);
  customSources.push(entry);
}

/** Test-only: drops anything a previous test registered. */
export function __resetCustomSourcesForTesting(): void {
  customSources.length = 0;
}

/** Built-ins plus whatever `--source <path>` loaded. */
export function allSources(): SourceEntry[] {
  return [...sources, ...customSources];
}

/** The built-in keys, for tab-completion and error messages. */
export function sourceKeys(): string[] {
  return sources.map((entry) => entry.key);
}

/**
 * Looks up a source by key, custom ones included.
 *
 * @throws Error when no source is registered under that key.
 */
export function getSource(key: string): SourceEntry {
  const source = allSources().find((entry) => entry.key === key);
  if (!source) {
    throw new Error(`Source not found for key: ${key}`);
  }
  return source;
}

/** A `--source` value that names a file rather than a built-in key. */
export function isSourcePath(value: string): boolean {
  return /^(\.\.?\/|\/)/.test(value) || /\.(ts|js|mjs)$/.test(value);
}

/** A resolved `--source`: its key, and for a custom one, the file's content hash. */
export type ResolvedSource = { key: string; entry: SourceEntry; path?: string; hash?: string };

/**
 * Resolves `--source`: a built-in key, or a path to a source you wrote.
 *
 * A custom source is keyed by a hash of its file as well as its key, so an
 * edited source is a different source when a re-run decides whether to
 * continue an earlier import.
 *
 * @throws UsageError for an unknown key, listing the valid ones.
 */
export async function resolveSource(value: string): Promise<ResolvedSource> {
  if (isSourcePath(value)) {
    const resolved = path.resolve(process.cwd(), value);
    // Hashed first, and loaded by that hash: the record names the very code
    // that maps the users, even if the file was edited since a last load.
    const hash = fs.existsSync(resolved)
      ? createHash("sha256").update(fs.readFileSync(resolved)).digest("hex")
      : undefined;
    const entry = await loadCustomSource(value, sourceKeys(), hash);
    registerCustomSource(entry);
    return { key: entry.key, entry, path: resolved, hash };
  }

  const entry = sources.find((candidate) => candidate.key === value);
  if (!entry) {
    throwUsageError(
      `Unknown source "${value}". Valid sources: ${sourceKeys().join(", ")}.\n` +
        "For a platform with no built-in, pass the path to a source you wrote, e.g. --source ./my-source.ts.",
      undefined,
      undefined,
      [{ command: "clerk migrate sources", description: "List the built-in sources" }],
    );
  }
  return { key: entry.key, entry };
}

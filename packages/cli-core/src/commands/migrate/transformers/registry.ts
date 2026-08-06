/**
 * Transformer registry.
 *
 * `migrate run` reads this array to resolve `--transformer` and to list the
 * valid choices in help output and tab-completion.
 *
 * To add a platform: create `transformers/<platform>.ts` exporting a
 * `TransformerRegistryEntry`, then add it to the array below.
 */

import type { TransformerRegistryEntry } from "../types.ts";
import auth0Transformer from "./auth0.ts";
import authjsTransformer from "./authjs.ts";
import betterAuthTransformer from "./betterauth.ts";
import clerkTransformer from "./clerk.ts";
import firebaseTransformer from "./firebase.ts";
import supabaseTransformer from "./supabase.ts";

export const transformers: TransformerRegistryEntry[] = [
  clerkTransformer,
  auth0Transformer,
  authjsTransformer,
  betterAuthTransformer,
  firebaseTransformer,
  supabaseTransformer,
];

/**
 * Transformers loaded from a user's `--transformer-file` for this invocation.
 *
 * Kept beside the built-ins rather than pushed into them, so the shipped list
 * is never mutated and `--transformer`'s choices stay exactly the built-in
 * keys. One CLI invocation loads at most one, so this holding a single entry is
 * the normal case; the array shape just avoids a special case in the lookups.
 */
const customTransformers: TransformerRegistryEntry[] = [];

export function registerCustomTransformer(entry: TransformerRegistryEntry): void {
  customTransformers.push(entry);
}

/** Test-only: drops anything a previous test registered. */
export function __resetCustomTransformersForTesting(): void {
  customTransformers.length = 0;
}

/** Built-ins plus whatever `--transformer-file` loaded. */
export function allTransformers(): TransformerRegistryEntry[] {
  return [...transformers, ...customTransformers];
}

/**
 * The built-in keys, for `--transformer`'s choices and tab-completion.
 *
 * Deliberately excludes custom transformers: they are selected by path via
 * `--transformer-file`, and Commander resolves these choices once at
 * registration time, before any file could have been loaded.
 */
export function transformerKeys(): string[] {
  return transformers.map((entry) => entry.key);
}

/**
 * Looks up a transformer by key, custom ones included.
 *
 * @throws Error when no transformer is registered under that key.
 */
export function getTransformer(key: string): TransformerRegistryEntry {
  const transformer = allTransformers().find((entry) => entry.key === key);
  if (!transformer) {
    throw new Error(`Transformer not found for key: ${key}`);
  }
  return transformer;
}

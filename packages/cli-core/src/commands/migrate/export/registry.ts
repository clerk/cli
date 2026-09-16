/**
 * Export registry.
 *
 * The picker behind a bare `clerk migrate export` is built from this array, so
 * adding a platform is one file plus one entry — the same shape the transformer
 * registry uses.
 *
 * `run` takes no arguments on purpose: each platform resolves its own flags,
 * environment variables and prompts, because what Auth0 needs (a tenant domain
 * and M2M credentials) has nothing in common with what a database export needs.
 */

import { exportAuth0 } from "./auth0.ts";
import { exportAuthJs } from "./authjs.ts";
import { exportBetterAuth } from "./betterauth.ts";
import { exportClerk } from "./clerk.ts";
import { exportFirebase } from "./firebase.ts";
import { exportSupabase } from "./supabase.ts";
import { exportWorkOs } from "./workos.ts";

export type ExportRegistryEntry = {
  key: string;
  label: string;
  description: string;
  /** Which `--transformer` reads the file this export writes. */
  transformerKey: string;
  run: (options: Record<string, unknown>) => Promise<void>;
};

export const exportPlatforms: ExportRegistryEntry[] = [
  {
    key: "clerk",
    label: "Clerk",
    description: "Another Clerk instance, e.g. development → production",
    transformerKey: "clerk",
    run: async (options) => exportClerk(options),
  },
  {
    key: "auth0",
    label: "Auth0",
    description: "An Auth0 tenant, via the Management API",
    transformerKey: "auth0",
    run: async (options) => exportAuth0(options),
  },
  {
    key: "supabase",
    label: "Supabase",
    description: "A Supabase Postgres database — includes password hashes",
    transformerKey: "supabase",
    run: async (options) => exportSupabase(options),
  },
  {
    key: "authjs",
    label: "Auth.js (NextAuth)",
    description: "An Auth.js database — Postgres, MySQL or SQLite",
    transformerKey: "authjs",
    run: async (options) => exportAuthJs(options),
  },
  {
    key: "firebase",
    label: "Firebase",
    description: "A Firebase project, via Identity Toolkit",
    transformerKey: "firebase",
    run: async (options) => exportFirebase(options),
  },
  {
    key: "betterauth",
    label: "Better Auth",
    description: "A Better Auth database — plugin columns detected automatically",
    transformerKey: "betterauth",
    run: async (options) => exportBetterAuth(options),
  },
  {
    key: "workos",
    label: "WorkOS",
    description: "A WorkOS tenant, via the User Management API — no password hashes",
    transformerKey: "workos",
    run: async (options) => exportWorkOs(options),
  },
];

export function exportPlatformKeys(): string[] {
  return exportPlatforms.map((entry) => entry.key);
}

export function getExportPlatform(key: string): ExportRegistryEntry | undefined {
  return exportPlatforms.find((entry) => entry.key === key);
}

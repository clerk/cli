import { flag, spell, value } from "./args";

/** The provider names accepted by `bun seed.ts` and `bun reset.ts`. */
export const PROVIDERS = [
  "authjs",
  "better-auth",
  "supabase",
  "firebase",
  "workos",
  // Auth0's bulk import job runs for an hour on 10k users, so it goes last —
  // every other provider is done and usable while it grinds.
  "auth0",
  "clerk",
] as const;

export type Provider = (typeof PROVIDERS)[number];

/**
 * What a bare `bun seed.ts` / `bun reset.ts` acts on. Clerk is the migration
 * destination — it has to be empty for a migration test to prove anything — so
 * it is only ever touched when named explicitly with --provider clerk.
 */
export const DEFAULT_PROVIDERS = PROVIDERS.filter((p) => p !== "clerk");

/**
 * Reads `--provider <name>` (or `-p`) out of argv. No flag means every provider
 * except Clerk. An unknown name exits rather than silently doing nothing.
 */
export function selectProviders(command: string): Provider[] {
  if (!flag("provider")) return [...DEFAULT_PROVIDERS];

  const name = value("provider");
  if (!name || !PROVIDERS.includes(name as Provider)) {
    console.error(
      `Unknown provider ${name ? `"${name}"` : "(none given)"}.\n` +
        `Usage: bun ${command}.ts [${spell("provider")} <${PROVIDERS.join("|")}>]`,
    );
    process.exit(1);
  }
  return [name as Provider];
}

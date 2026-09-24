import type { TransformerRegistryEntry } from "../types.ts";
import { routeByVerification, toIsoDate } from "./shared.ts";

/**
 * Supabase Auth → Clerk transformer.
 *
 * Works with a `auth.users` export, per
 * https://supabase.com/docs/guides/auth/managing-user-data#exporting-users
 *
 * Supabase records verification as a nullable confirmation timestamp
 * (`email_confirmed_at`) rather than a boolean, and stores timestamps in
 * PostgreSQL's format (`2024-06-29 20:25:06.126079+00`).
 */

/** Discord writes display names as `name#0`; the suffix reads as a URL to Clerk. */
const DISCORD_DISCRIMINATOR = /#\d+$/;

function stripDiscriminator(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(DISCORD_DISCRIMINATOR, "").trim() || undefined;
}

const supabaseTransformer = {
  key: "supabase",
  label: "Supabase",
  description:
    "Works with a Supabase `auth.users` export. Use --skip-unsupported-providers to drop users whose only social provider is not enabled in Clerk.",
  transformer: {
    id: "userId",
    email: "email",
    email_confirmed_at: "emailConfirmedAt",
    first_name: "firstName",
    last_name: "lastName",
    encrypted_password: "password",
    phone: "phone",
    phone_confirmed_at: "phoneConfirmedAt",
    raw_user_meta_data: "publicMetadata",
    created_at: "createdAt",
  },
  postTransform: (user) => {
    user.createdAt = toIsoDate(user.createdAt);
    routeByVerification(user, "email", "emailConfirmedAt", "timestamp");
    routeByVerification(user, "phone", "phoneConfirmedAt", "timestamp");

    // A basic SQL export has no first_name/last_name columns; the name lives in
    // user metadata instead, under whichever key the provider happened to use.
    if (!user.firstName && user.publicMetadata && typeof user.publicMetadata === "object") {
      const meta = user.publicMetadata as Record<string, unknown>;
      const displayName = stripDiscriminator(meta.display_name ?? meta.first_name ?? meta.name);
      if (displayName) {
        const parts = displayName.split(/\s+/);
        user.firstName = parts[0];
        if (parts.length > 1 && !user.lastName) user.lastName = parts.slice(1).join(" ");
      }
    }

    for (const field of ["firstName", "lastName"] as const) {
      if (typeof user[field] === "string") {
        const cleaned = stripDiscriminator(user[field]);
        if (cleaned) user[field] = cleaned;
        else delete user[field];
      }
    }
  },
  defaults: {
    passwordHasher: "bcrypt" as const,
  },
} satisfies TransformerRegistryEntry;

export default supabaseTransformer;

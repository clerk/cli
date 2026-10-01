import type { SourceEntry } from "../types.ts";
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

const supabaseSource = {
  key: "supabase",
  label: "Supabase",
  description:
    "Works with a Supabase `auth.users` export. Users whose only social provider is not enabled in Clerk are rejected by the import's checks.",
  carries: {
    passwords: { level: "yes", note: "bcrypt `encrypted_password` hashes come across." },
    mfa: {
      level: "no",
      note: "Supabase MFA factors are not exported. Users enrol again in Clerk.",
    },
    metadata: {
      level: "partial",
      note: "`raw_user_meta_data` → unsafe metadata, which users can edit, as in Supabase. `raw_app_meta_data` is not carried.",
    },
  },
  transformer: {
    id: "userId",
    email: "email",
    email_confirmed_at: "emailConfirmedAt",
    first_name: "firstName",
    last_name: "lastName",
    encrypted_password: "password",
    phone: "phone",
    phone_confirmed_at: "phoneConfirmedAt",
    raw_user_meta_data: "unsafeMetadata",
    banned_until: "bannedUntil",
    created_at: "createdAt",
  },
  postTransform: (user) => {
    user.createdAt = toIsoDate(user.createdAt);

    // Supabase bans until a time; a "permanent" ban is just a far-future one.
    // Clerk's ban has no end, so only a ban still in force carries, and it then
    // stays until someone lifts it in Clerk.
    const bannedUntil = Date.parse(String(toIsoDate(user.bannedUntil)));
    if (bannedUntil > Date.now()) user.banned = true;
    delete user.bannedUntil;
    routeByVerification(user, "email", "emailConfirmedAt", "timestamp");
    routeByVerification(user, "phone", "phoneConfirmedAt", "timestamp");

    // A basic SQL export has no first_name/last_name columns; the name lives in
    // user metadata instead, under whichever key the provider happened to use.
    if (!user.firstName && user.unsafeMetadata && typeof user.unsafeMetadata === "object") {
      const meta = user.unsafeMetadata as Record<string, unknown>;
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
} satisfies SourceEntry;

export default supabaseSource;

import type { TransformerRegistryEntry } from "../types.ts";
import { routeByVerification, splitName } from "./shared.ts";

/**
 * Better Auth → Clerk transformer.
 *
 * Works with `clerk migrate export betterauth`, which joins the user table
 * with the credential account row to pick up the bcrypt `password_hash`.
 *
 * Better Auth plugins add columns Clerk has no equivalent for
 * (`display_username`, `role`, `ban_reason`, `two_factor_enabled`). They need
 * no handling: the schema strips anything it does not declare. `banned` is the
 * exception, because that one *is* a Clerk field.
 */
const betterAuthTransformer = {
  key: "betterauth",
  label: "Better Auth",
  description:
    "Works with the Better Auth export. Supports bcrypt passwords and the admin plugin's banned flag.",
  transformer: {
    user_id: "userId",
    email: "email",
    email_verified: "emailVerified",
    name: "name",
    password_hash: "password",
    username: "username",
    phone_number: "phone",
    phone_number_verified: "phoneVerified",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  postTransform: (user) => {
    routeByVerification(user, "email", "emailVerified", "boolean");
    routeByVerification(user, "phone", "phoneVerified", "boolean");
    splitName(user);

    // Only carry `banned` when it is actually true — Better Auth writes false
    // for every user that was never banned, and sending that to Clerk is noise.
    if (user.banned !== true) delete user.banned;
  },
  defaults: {
    passwordHasher: "bcrypt" as const,
  },
} satisfies TransformerRegistryEntry;

export default betterAuthTransformer;

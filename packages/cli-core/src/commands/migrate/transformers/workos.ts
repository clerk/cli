import type { TransformerRegistryEntry } from "../types.ts";
import { routeByVerification } from "./shared.ts";

/**
 * WorkOS → Clerk transformer.
 *
 * Works with WorkOS's User Management API. `id` is a `user_…` string and is
 * carried through as the Clerk user's `external_id`.
 *
 * **There is no `passwordHasher` default here, and that is deliberate.** Every
 * other transformer names the hasher its platform ships so a digest can be
 * verified; WorkOS returns no digest to verify. It accepts password hashes on
 * import and never gives them back, and its TOTP secrets are returned on enrol
 * only — so a WorkOS migration moves identities, not credentials. Naming a
 * hasher here would imply a password column that cannot exist.
 *
 * WorkOS has no phone number and no username, which is why the map is short:
 * those fields have nothing to come from.
 */
const workosTransformer = {
  key: "workos",
  label: "WorkOS",
  description:
    "Works with WorkOS's User Management API. WorkOS returns no password hashes, so imported users sign in by reset or SSO.",
  transformer: {
    id: "userId",
    email: "email",
    email_verified: "emailVerified",
    first_name: "firstName",
    last_name: "lastName",
    metadata: "publicMetadata",
    created_at: "createdAt",
  },
  postTransform: (user) => {
    routeByVerification(user, "email", "emailVerified", "boolean");
  },
} satisfies TransformerRegistryEntry;

export default workosTransformer;

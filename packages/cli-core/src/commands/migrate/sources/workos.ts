import type { SourceEntry } from "../types.ts";
import { routeByVerification } from "./shared.ts";

/**
 * WorkOS → Clerk transformer.
 *
 * Works with WorkOS's User Management API. `id` is a `user_…` string and is
 * carried through as the Clerk user's `external_id`. WorkOS's own `external_id`
 * — the tenant's app ID, when they set one — has nowhere else to go, so it lands
 * in private metadata as `workosExternalId`: private because users can edit
 * unsafe metadata, and an ID other records key on must not be editable.
 *
 * **There is no `passwordHasher` default here, and that is deliberate.** Every
 * other source names the hasher its platform ships so a digest can be
 * verified; WorkOS returns no digest to verify. It accepts password hashes on
 * import and never gives them back, and its TOTP secrets are returned on enrol
 * only — so a WorkOS migration moves identities, not credentials. Naming a
 * hasher here would imply a password column that cannot exist.
 *
 * WorkOS has no phone number and no username, which is why the map is short:
 * those fields have nothing to come from.
 */
const workosSource = {
  key: "workos",
  label: "WorkOS",
  description:
    "Works with WorkOS's User Management API. WorkOS returns no password hashes, so imported users sign in by reset or SSO.",
  carries: {
    passwords: {
      level: "no",
      note: "WorkOS never returns password hashes. Users reset their password, or sign in with SSO.",
    },
    mfa: { level: "no", note: "WorkOS returns TOTP secrets at enrolment only." },
    metadata: {
      level: "yes",
      note: "`metadata` → unsafe metadata. WorkOS's `external_id` → private metadata `workosExternalId`; the WorkOS `id` becomes the Clerk external ID.",
    },
  },
  transformer: {
    id: "userId",
    email: "email",
    email_verified: "emailVerified",
    first_name: "firstName",
    last_name: "lastName",
    metadata: "unsafeMetadata",
    external_id: "workosExternalId",
    created_at: "createdAt",
  },
  postTransform: (user) => {
    routeByVerification(user, "email", "emailVerified", "boolean");

    if (user.workosExternalId) {
      user.privateMetadata = { workosExternalId: String(user.workosExternalId) };
    }
    delete user.workosExternalId;
  },
} satisfies SourceEntry;

export default workosSource;

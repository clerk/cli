/**
 * Seeds a WorkOS environment from data/users.json.
 *
 * There is no bulk import endpoint, so this is one POST /user_management/users
 * per user through the shared worker pool. The SDK already retries 429s with
 * backoff and honours Retry-After, and the pool retries on top of that.
 *
 * WorkOS User Management has no phone or username identifier — email is the
 * only one, and a user without one can't exist. Phone-only users are left out.
 * Phones and usernames go in `metadata` under the keys WorkOS's own migration
 * tool (@workos/migrations) writes, as an app that moved to WorkOS would have
 * them: half the phone users came "from Firebase" (`phone_number`), the other
 * half "from Clerk" (`primary_phone_number`, plus `verified_phone_numbers` or
 * `unverified_phone_numbers`). Usernames go in `username`.
 *
 * The migration-test variations (variations/workos.ts) also use:
 *   - `metadata.user` — replaces the default metadata outright (seed_id, phone
 *     and username keys), so a variation can seed empty or at-the-limit metadata.
 *     WorkOS metadata is string → string, at most 10 keys.
 *   - `sourceId` — the WorkOS `external_id` (default: the seed id).
 *   - `orgs` — memberships, in organizations named as given (created once).
 *   - `mfa` — a TOTP factor enrolled after the user exists.
 *
 * Not idempotent: a second run reports every user as email_not_available.
 * Clear the environment's users first, or seed once.
 *
 * Run: bun seed.ts -p workos
 */
import bcrypt from "bcryptjs";
import { WorkOS } from "@workos-inc/node";
import { loadUsers, pool, progressBar, reportFailures, type SeedUser } from "./lib/users";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID,
});
const { seedPassword, users: all } = loadUsers();
const users = all.filter((u) => u.email);

/** Phone users alternate between the Firebase and the Clerk metadata shape. */
const fromFirebase = new Set(users.filter((u) => u.phone).filter((_, i) => i % 2 === 0));
const phoneMetadata = (u: SeedUser): Record<string, string> =>
  !u.phone
    ? {}
    : fromFirebase.has(u)
      ? { phone_number: u.phone }
      : {
          primary_phone_number: u.phone,
          [u.phoneVerified ? "verified_phone_numbers" : "unverified_phone_numbers"]: u.phone,
        };

/*
 * Every user shares one password, so one bcrypt hash is computed and reused.
 * Per-user salting would cost 425 rounds of bcrypt to protect a password that
 * is written in the README. $2b$ with 10 rounds is what WorkOS expects for
 * passwordHashType: "bcrypt".
 */
const passwordHash = await bcrypt.hash(seedPassword, 10);

/** WorkOS metadata values are strings; anything else is stored as JSON. */
const stringify = (record: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );

/** Organizations by name, created on first use; concurrent workers share the promise. */
const orgs = new Map<string, Promise<string>>();
const orgId = (name: string) => {
  if (!orgs.has(name))
    orgs.set(
      name,
      workos.organizations.createOrganization({ name }).then((o) => o.id),
    );
  return orgs.get(name)!;
};

async function createUser(u: SeedUser) {
  const user = await workos.userManagement.createUser({
    email: u.email!,
    emailVerified: u.emailVerified,
    externalId: u.sourceId ?? u.id,
    firstName: u.firstName ?? undefined,
    lastName: u.lastName ?? undefined,
    ...(u.hasPassword ? { passwordHash, passwordHashType: "bcrypt" as const } : {}),
    metadata: u.metadata?.user
      ? stringify(u.metadata.user)
      : {
          seed_id: u.id,
          ...phoneMetadata(u),
          ...(u.username ? { username: u.username } : {}),
        },
  });

  for (const org of u.orgs ?? []) {
    const membership = { organizationId: await orgId(org.name), userId: user.id };
    // ponytail: an environment without the named role falls back to the
    // default one rather than failing the user; the export ignores roles anyway.
    await workos.userManagement
      .createOrganizationMembership({ ...membership, ...(org.role ? { roleSlug: org.role } : {}) })
      .catch((e) => {
        if (!org.role) throw e;
        return workos.userManagement.createOrganizationMembership(membership);
      });
  }

  if (u.mfa) await workos.multiFactorAuth.createUserAuthFactor({ userId: user.id, type: "totp" });
}

console.log(
  `Seeding ${users.length} users into WorkOS (${all.length - users.length} phone-only left out)…`,
);

const failures = await pool(users, 4, createUser, progressBar("created"));
reportFailures(failures);

console.log(`\nSeed password: ${seedPassword}`);
console.log(
  "Phone numbers and usernames are in user metadata — WorkOS has no identifier for either.",
);

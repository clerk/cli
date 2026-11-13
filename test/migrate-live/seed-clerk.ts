/**
 * Seeds a Clerk development instance from data/users.json (or SEED_USERS_FILE).
 *
 * Email addresses are rewritten to the +clerk_test subaddress on the way in.
 * Clerk only treats those as test addresses — it will not send them mail, and
 * they verify with the fixed code 424242. The master JSON stays clean.
 * The 555-01XX phone numbers are already test numbers as generated.
 *
 * Also writes the optional edge-case fields the migration tests set: metadata
 * (public/private/unsafe), banned, and TOTP + backup codes (`mfa`). See
 * lib/clerk-source.ts.
 *
 * Enable first: Dashboard -> Configure -> Email, phone, username
 *   Identifiers: Email address, Phone number, Username
 *   Strategies:  Password, Email verification code, SMS verification code
 * (variations/clerk.ts does this through `clerk config patch`).
 *
 * Run: bun seed.ts -p clerk
 */
import { clerkClient, createSeedUser } from "./lib/clerk-source";
import { loadUsers, pool, progressBar, reportFailures } from "./lib/users";

const { seedPassword, users } = loadUsers();

console.log(`Seeding ${users.length} users into Clerk…`);
console.log("  Clerk throttles user creation, so this takes a few minutes.\n");

// Clerk's Backend API allows roughly 20 user writes per 10 seconds; the pool
// retries 429s with backoff rather than trying to stay exactly under the line.
const failures = await pool(
  users,
  4,
  (u) => createSeedUser(u, seedPassword).then(() => {}),
  progressBar("created"),
);
reportFailures(failures);

const total = await clerkClient().users.getCount();
console.log(`\nClerk now reports ${total} users.`);
console.log(`Seed password: ${seedPassword}`);
console.log("Sign in with e.g. ada.lovelace4+clerk_test@example.com, code 424242.");

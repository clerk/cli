/**
 * Seeds a Firebase project from data/users.json using the Admin SDK.
 *
 * Two paths, by what the user needs:
 *   createUser   — the default. Takes the plaintext password and lets Firebase
 *                  hash it with the project's own scrypt, which is the only
 *                  kind of hash Firebase ever hands back out.
 *   importUsers  — users whose password came from somewhere else
 *                  (`passwordFormat`: bcrypt, HMAC, MD5), and OAuth-only users
 *                  (`providerData`), which createUser cannot make. One call per
 *                  hash algorithm, up to 1000 users each.
 *
 * Firebase has no username field — usernames, names and any `metadata.app` go
 * into custom claims. `banned` is Firebase's `disabled`. An `anonymous` user is
 * created with no email, phone or password at all. None of this depends on
 * which sign-in providers are enabled in the console.
 *
 * Run: bun seed.ts -p firebase
 */
import { createHash, createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type UserImportOptions, type UserImportRecord } from "firebase-admin/auth";
import { loadUsers, pool, progressBar, reportFailures, type SeedUser } from "./lib/users";

/**
 * Firebase only has a displayName when the user (or a provider) gave one. The
 * shared displayName() falls back to the phone number, which a real phone-only
 * Firebase account never carries — and which Clerk refuses as a first name.
 */
const firebaseName = (u: SeedUser) => {
  const name = u.fullName ?? u.username ?? u.email?.split("@")[0];
  return name ? { displayName: name } : {};
};

if (!getApps().length)
  initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!)),
  });

const auth = getAuth();
const { seedPassword, users } = loadUsers();

/** A fixed HMAC key: the hash only has to be a well-formed HMAC_SHA256 upload. */
const HMAC_KEY = Buffer.from("migration-test-hmac-key");

/** Per hash algorithm: the importUsers option and how to hash the seed password. */
const IMPORTED_HASHES: Partial<
  Record<
    NonNullable<SeedUser["passwordFormat"]>,
    { options: UserImportOptions; hash: () => Buffer }
  >
> = {
  bcrypt: {
    options: { hash: { algorithm: "BCRYPT" } },
    hash: () => Buffer.from(bcrypt.hashSync(seedPassword, 10)),
  },
  hmac_sha256: {
    options: { hash: { algorithm: "HMAC_SHA256", key: HMAC_KEY } },
    hash: () => createHmac("sha256", HMAC_KEY).update(seedPassword).digest(),
  },
  md5: {
    options: { hash: { algorithm: "MD5", rounds: 0 } },
    hash: () => createHash("md5").update(seedPassword).digest(),
  },
};

const claims = (u: SeedUser) =>
  u.username || u.firstName || u.metadata?.app
    ? {
        seedId: u.id,
        username: u.username ?? null,
        firstName: u.firstName ?? null,
        lastName: u.lastName ?? null,
        ...u.metadata?.app,
      }
    : undefined;

const googleProvider = (u: SeedUser) => ({
  uid: `google-${u.id}`,
  providerId: "google.com",
  email: u.email ?? undefined,
  ...firebaseName(u),
});

/** Needs importUsers: an imported hash, or OAuth with no password to create. */
const viaImport = (u: SeedUser) =>
  (u.hasPassword && !!u.passwordFormat) || (!u.hasPassword && !!u.oauth?.length);

async function createUser(u: SeedUser) {
  const record = await auth.createUser({
    ...(u.sourceId && { uid: u.sourceId }),
    // An anonymous user is just a uid: no email, phone or password.
    ...(!u.anonymous && {
      email: u.email ?? undefined,
      emailVerified: u.emailVerified,
      phoneNumber: u.phone ?? undefined,
      password: u.hasPassword ? seedPassword : undefined,
      ...firebaseName(u),
    }),
    disabled: !!u.banned,
  });

  // Password + Google: link the provider onto the account createUser made.
  // ponytail: only google.com — add others when a variation needs them.
  if (u.oauth?.includes("google"))
    await auth.updateUser(record.uid, { providerToLink: googleProvider(u) });

  const c = claims(u);
  if (c) await auth.setCustomUserClaims(record.uid, c);
}

function importRecord(u: SeedUser, hash?: () => Buffer): UserImportRecord {
  return {
    uid: u.sourceId ?? `seed-${u.id}`,
    email: u.email ?? undefined,
    emailVerified: u.emailVerified,
    phoneNumber: u.phone ?? undefined,
    ...firebaseName(u),
    disabled: !!u.banned,
    customClaims: claims(u),
    ...(hash && { passwordHash: hash() }),
    ...(u.oauth?.includes("google") && { providerData: [googleProvider(u)] }),
  };
}

const created = users.filter((u) => !viaImport(u));
const imported = users.filter(viaImport);

console.log(
  `Seeding ${users.length} users into Firebase (${created.length} created, ${imported.length} imported)…`,
);
const failures = await pool(created, 8, createUser, progressBar("created"));

// One importUsers call per hash algorithm (it takes a single hash option);
// OAuth-only users with no password go in a call of their own.
const groups = new Map<string, SeedUser[]>();
for (const u of imported) {
  const key = u.hasPassword ? u.passwordFormat! : "none";
  groups.set(key, [...(groups.get(key) ?? []), u]);
}
for (const [format, group] of groups) {
  const algo =
    format === "none" ? undefined : IMPORTED_HASHES[format as keyof typeof IMPORTED_HASHES];
  if (format !== "none" && !algo)
    throw new Error(`Firebase seeding has no "${format}" password format`);
  for (let i = 0; i < group.length; i += 1000) {
    const slice = group.slice(i, i + 1000);
    const result = await auth.importUsers(
      slice.map((u) => importRecord(u, algo?.hash)),
      algo?.options,
    );
    for (const { index, error } of result.errors) failures.push({ item: slice[index], error });
    console.log(
      `  imported ${result.successCount}/${slice.length} (${format === "none" ? "no password" : format})`,
    );
  }
}
reportFailures(failures);

let count = 0;
let page = await auth.listUsers(1000);
count += page.users.length;
while (page.pageToken) {
  page = await auth.listUsers(1000, page.pageToken);
  count += page.users.length;
}
console.log(`\nDone. Firebase reports ${count} users.`);
console.log(`Seed password: ${seedPassword}`);

/**
 * Firebase variations (F1–F8 in .testing-plan.md).
 *
 * Seeding never depends on which sign-in providers the console has enabled, so
 * these vary the data, not the project config. What the CLI can see is set by
 * `export/firebase.ts`: localId, email, emailVerified, displayName,
 * phoneNumber, disabled, and the password hash + salt only when both come back
 * non-empty. Firebase hands back hashes it made itself (scrypt) — a user
 * uploaded with bcrypt or HMAC exports an empty hash, so that password is lost.
 * Custom claims and provider data are not exported.
 */
import { run } from "../lib/run";
import type { SeedUser } from "../lib/users";
import { everyNth, expectLanded, mix, type Variation } from "../lib/variations";

const parsesAsJson = (s?: string) => {
  try {
    return typeof JSON.parse(s ?? "") === "object";
  } catch {
    return false;
  }
};

async function resetProject() {
  const { code, stderr } = await run("bun", ["reset.ts", "-p", "firebase", "-y"]);
  if (code !== 0) throw new Error(`Firebase reset failed: ${stderr.slice(-300)}`);
}

/** Also puts the export back on the seeding service account (F1H switches it). */
export async function reset() {
  delete process.env.FIREBASE_SERVICE_ACCOUNT_FOR_EXPORT;
  await resetProject();
}

export async function afterAll() {
  await resetProject();
  const { code, stderr } = await run("bun", ["seed.ts", "-p", "firebase"]);
  if (code !== 0) throw new Error(`reseeding the app's 500 users failed: ${stderr.slice(-300)}`);
}

const withEmail = (all: SeedUser[]) => all.filter((u) => u.email);
/** Usernames live in custom claims, which the CLI does not export. */
const firebase = { withUsername: 0 };
/** Only Firebase-native scrypt passwords survive the export. */
const nativePasswords = (seeded: SeedUser[]) =>
  seeded.filter((u) => u.hasPassword && !u.passwordFormat).length;

export const variations: Variation[] = [
  {
    id: "F1",
    describe: "email + password, Firebase's own scrypt: hashes export and verify in Clerk",
    // 20 users: every group, a username, a name and a European phone first.
    users: mix({ "email-only": 8, "phone-only": 4, both: 8 }),
    expect: expectLanded(firebase),
  },
  {
    id: "F1H",
    describe: "F1, exported with the custom firebaseauth.configs.getHashConfig role (plan bug #4)",
    skip: parsesAsJson(process.env.FIREBASE_SERVICE_ACCOUNT_JSON_HASH_ROLE)
      ? undefined
      : "FIREBASE_SERVICE_ACCOUNT_JSON_HASH_ROLE is not a service-account JSON yet",
    sourceConfig: async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_FOR_EXPORT =
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON_HASH_ROLE;
    },
    users: mix({ "email-only": 8, "phone-only": 4, both: 8 }),
    expect: expectLanded(firebase),
  },
  {
    id: "F2",
    describe: "email link only: no password",
    users: (all) =>
      mix({ "email-only": 6, both: 4 })(all).map((u) => ({ ...u, hasPassword: false })),
    expect: expectLanded(firebase),
  },
  {
    id: "F3",
    describe: "phone only",
    users: mix({ "phone-only": 10 }),
    expect: expectLanded(firebase),
  },
  {
    id: "F4",
    describe: "email + password + phone",
    users: mix({ both: 10 }),
    expect: expectLanded(firebase),
  },
  {
    id: "F5",
    describe:
      "imported bcrypt / HMAC_SHA256 hashes: Firebase exports them empty, so those passwords are lost",
    users: (all) =>
      withEmail(all)
        .slice(0, 15)
        .map((u, i) => ({
          ...u,
          hasPassword: true,
          passwordFormat: ([undefined, "bcrypt", "hmac_sha256"] as const)[i % 3],
        })),
    // f6a3232a: the export warns about these; the import carries no password for them.
    expect: expectLanded({ ...firebase, withPassword: nativePasswords }),
  },
  {
    id: "F6",
    describe: "Google: password + Google linked, and Google only (provider data is not exported)",
    users: (all) =>
      withEmail(all)
        .slice(0, 10)
        .map((u, i) =>
          i % 2 === 0
            ? { ...u, oauth: ["google"] }
            : { ...u, oauth: ["google"], hasPassword: false },
        ),
    expect: expectLanded(firebase),
  },
  {
    id: "F7",
    describe: "edge cases: disabled, unverified, custom claims, and anonymous users",
    users: (all) => [
      ...withEmail(all)
        .slice(0, 12)
        .map((u, i) => {
          switch (i % 4) {
            case 0:
              return { ...u, banned: true };
            case 1:
              return { ...u, emailVerified: false };
            // Custom claims are capped at 1000 bytes.
            case 2:
              return {
                ...u,
                metadata: { app: { plan: "enterprise", roles: ["admin", "billing"], seats: 25 } },
              };
            default:
              return u;
          }
        }),
      // Anonymous: a bare uid. No identifier at all, so the CLI must reject them.
      ...withEmail(all)
        .slice(12, 15)
        .map((u) => ({
          ...u,
          anonymous: true,
          email: null,
          phone: null,
          hasPassword: false,
          username: null,
        })),
    ],
    expect: (clerk, seeded, dest) => {
      if (dest !== "D1") return [];
      const real = seeded.filter((u) => !u.anonymous);
      const issues = expectLanded({ ...firebase, total: real.length })(clerk, real, dest);
      const unverified = real.filter((u) => !u.emailVerified).length;
      if (clerk.total - clerk.withVerifiedEmail !== unverified)
        issues.push(
          `unverified emails: expected ${unverified}, got ${clerk.total - clerk.withVerifiedEmail}`,
        );
      return issues;
    },
  },
  {
    id: "F8",
    describe: "combined: every group, disabled users, Google links and bcrypt imports",
    dests: ["D1", "D2", "D3", "D4", "D5"],
    users: (all) =>
      everyNth(10)(all).map((u, i) => ({
        ...u,
        ...(i % 7 === 0 && { banned: true }),
        ...(u.email && i % 6 === 2 && { oauth: ["google"] }),
        ...(u.hasPassword && i % 9 === 3 && { passwordFormat: "bcrypt" as const }),
      })),
    expect: expectLanded({ ...firebase, withPassword: nativePasswords }),
  },
];

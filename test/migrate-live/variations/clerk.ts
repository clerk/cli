/**
 * Clerk as a source (C1–C6 in .testing-plan.md): a Clerk-to-Clerk migration.
 *
 * The source is the dev instance and the destination pool-1: the CLI refuses
 * to import an export back into the instance it came from. The runner seeds,
 * exports, then calls reset(), which empties the source, before it imports.
 *
 * What `clerk migrate export clerk` can carry (export/clerk.ts): identifiers,
 * names, the three metadata blobs, banned, created_at and a few account flags.
 * The Backend API never returns password digests, TOTP secrets or backup
 * codes, so those never come across — "partial" for passwords and MFA in
 * `clerk migrate sources` means *a Dashboard export* carries them, the CLI's
 * own export does not. Every variation therefore expects 0 passwords.
 */
import { DESTS } from "../lib/clerk-dest";
import { clerkUsername, configPatch, configPull, deleteAllUsers } from "../lib/clerk-source";
import type { SeedUser } from "../lib/users";
import { expectLanded, mix, type Variation } from "../lib/variations";

export const reset = deleteAllUsers;

/** Everything on, nothing required: any seed shape can be created. */
const allOn = () => configPatch(DESTS.D1);

/**
 * C5 turns MFA on, which is outside the four keys the runner restores. Snapshot
 * it the first time, put it back in afterAll.
 */
let mfaBefore: unknown;
async function mfaOn() {
  await allOn();
  mfaBefore ??= (await configPull()).auth_multi_factor;
  await configPatch({
    auth_multi_factor: { authenticator_app: { enabled: true }, backup_code: { enabled: true } },
  });
}

export async function afterAll() {
  if (mfaBefore !== undefined) await configPatch({ auth_multi_factor: mfaBefore });
}

/** Clerk never exports password digests (see top). */
const noPasswords = { withPassword: 0 };
const plain = (u: SeedUser): SeedUser => ({ ...u, username: null, phone: null });

export const variations: Variation[] = [
  {
    id: "C1",
    describe: "email + password",
    sourceConfig: allOn,
    users: (all) => mix({ "email-only": 8 })(all).map(plain),
    expect: expectLanded({ ...noPasswords, withUsername: 0, withPhone: 0 }),
  },
  {
    id: "C2",
    describe: "email + username + phone + password",
    sourceConfig: allOn,
    users: (all) => [
      ...mix({ both: 8 })(all),
      ...mix({ "email-only": 2 })(all.filter((u) => u.username)),
    ],
    // The seeder makes usernames Clerk-safe (dots → _, under 4 chars dropped).
    expect: expectLanded({
      ...noPasswords,
      withUsername: (seeded) => seeded.filter((u) => clerkUsername(u.username)).length,
    }),
  },
  {
    id: "C3",
    describe: "phone only (incl. a European number)",
    sourceConfig: allOn,
    users: (all) => mix({ "phone-only": 8 })(all).map((u) => ({ ...u, username: null })),
    expect: expectLanded({ ...noPasswords, withUsername: 0 }),
  },
  {
    id: "C4",
    describe: "email code only: no passwords at the source (D5 as the source config)",
    sourceConfig: () => configPatch(DESTS.D5),
    users: (all) => mix({ "email-only": 6 })(all).map((u) => ({ ...plain(u), hasPassword: false })),
    expect: expectLanded({ ...noPasswords, withUsername: 0, withPhone: 0 }),
  },
  {
    id: "C5",
    describe: "TOTP + backup codes on half the users: not exportable through the API",
    sourceConfig: mfaOn,
    users: (all) =>
      mix({ "email-only": 6 })(all).map((u, i) => ({ ...plain(u), mfa: i % 2 === 0 })),
    // Want the users; the MFA itself can only come from a Dashboard export.
    expect: (clerk, seeded, dest, users) => [
      ...expectLanded({ ...noPasswords, withUsername: 0, withPhone: 0 })(clerk, seeded, dest),
      ...(users.some((u) => u.totpEnabled || u.backupCodeEnabled)
        ? ["an MFA factor came across, which the API export says it can't carry"]
        : []),
    ],
  },
  {
    id: "C6",
    describe: "public/private/unsafe metadata, and banned users",
    sourceConfig: allOn,
    users: (all) =>
      mix({ "email-only": 5, both: 5 })(all).map((u, i) => ({
        ...u,
        username: null,
        ...(i % 3 === 0 && { metadata: METADATA }),
        ...(i % 3 === 1 && { banned: true }),
      })),
    expect: (clerk, seeded, dest, users) => {
      if (dest !== "D1") return [];
      const issues = expectLanded({ ...noPasswords, withUsername: 0 })(clerk, seeded, dest);
      const want = seeded.filter((u) => u.metadata).length;
      const got = {
        public: users.filter((u) => (u.publicMetadata as { tier?: string }).tier === "gold").length,
        private: users.filter((u) => (u.privateMetadata as { plan?: string }).plan === "enterprise")
          .length,
        unsafe: users.filter((u) => (u.unsafeMetadata as { theme?: string }).theme === "dark")
          .length,
      };
      for (const [k, v] of Object.entries(got))
        if (v !== want) issues.push(`${k} metadata: expected ${want}, got ${v}`);
      return issues;
    },
  },
];

const METADATA = {
  public: { tier: "gold", badges: ["early-adopter"] },
  app: { plan: "enterprise", seats: 25, flags: { beta: true } },
  user: { theme: "dark", locale: "fr-CA" },
};

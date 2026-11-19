/**
 * WorkOS variations (W1–W7 in .testing-plan.md).
 *
 * Data-only: WorkOS has no API or CLI that turns sign-in methods on or off, and
 * the export reads only the user list (plus identities), so what varies is the
 * users themselves. Cohorts are small — WorkOS seeds and deletes one API call
 * per user.
 *
 * TODO(WorkOS MCP): if the WorkOS MCP server (https://mcp.workos.com/mcp) turns
 * out to toggle auth methods (password, Magic Auth, MFA policy), add a
 * sourceConfig per variation here. Until then config stays as the dashboard has it.
 *
 * Not seedable by API, so not here: OAuth identities and passkeys (both need a
 * real browser sign-in), SSO users (a paid connection plus an IdP login).
 *
 * afterAll leaves the environment empty: re-seeding the app's 500 users takes
 * minutes of one-call-per-user. `bun seed.ts -p workos` puts them back.
 */
import { WorkOS } from "@workos-inc/node";
import type { User } from "@clerk/backend";
import { pool, type SeedUser } from "../lib/users";
import { expectLanded, mix, reserving, type ClerkSummary, type Variation } from "../lib/variations";

const workos = () => new WorkOS(process.env.WORKOS_API_KEY!);

/** Every organization a variation creates is named with this, so reset can find them. */
const ORG = "mt-";

export async function reset() {
  const w = workos();
  const ids: string[] = [];
  for (let after: string | undefined; ;) {
    const page = await w.userManagement.listUsers({ limit: 100, after });
    ids.push(...page.data.map((u) => u.id));
    after = page.listMetadata.after ?? undefined;
    if (!after) break;
  }
  const failed = await pool(ids, 4, async (id) => {
    await w.userManagement.deleteUser(id);
  });
  if (failed.length)
    throw new Error(`${failed.length} WorkOS users would not delete: ${String(failed[0].error)}`);

  const orgs = (await w.organizations.listOrganizations({ limit: 100 })).data.filter((o) =>
    o.name.startsWith(ORG),
  );
  // The list lags deletes: it can still show an org an earlier reset removed.
  for (const o of orgs)
    await w.organizations.deleteOrganization(o.id).catch((e) => {
      if (e?.status !== 404) throw e;
    });
}

/** listUsers is the export's source of truth; make sure it shows every seeded user. */
export async function afterSeed(seeded: SeedUser[]) {
  const w = workos();
  for (let i = 0; i < 20; i++) {
    const page = await w.userManagement.listUsers({ limit: 100 });
    if (page.data.length >= seeded.length) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`WorkOS lists fewer than the ${seeded.length} seeded users`);
}

/**
 * WorkOS carries email only: no password hash comes back (ever), no phone, no
 * username. Phone-only users are left out of every cohort — WorkOS has no
 * phone, so they would be a `@phone.local` placeholder and nothing else.
 */
const workosLanded = { withPassword: 0, withUsername: 0, withPhone: 0 };
const cohort = (n: { emailOnly: number; both: number }) =>
  mix({ "email-only": n.emailOnly, both: n.both });

/** Every user: the WorkOS id became the Clerk external ID, and WorkOS's external_id is in private metadata. */
function idsCarried(seeded: SeedUser[], users: User[]) {
  const issues: string[] = [];
  const bad = users.filter((u) => !u.externalId?.startsWith("user_")).length;
  if (bad) issues.push(`${bad} users without a WorkOS user_… external ID`);
  const wanted = new Set(seeded.map((u) => u.sourceId ?? u.id));
  const carried = users.filter((u) =>
    wanted.has(String((u.privateMetadata as { workosExternalId?: unknown }).workosExternalId)),
  );
  if (carried.length !== users.length)
    issues.push(`workosExternalId in private metadata: ${carried.length}/${users.length}`);
  return issues;
}

const check =
  (extra: Partial<Record<keyof ClerkSummary, number | ((s: SeedUser[]) => number)>> = {}) =>
  (
    clerk: ClerkSummary,
    seeded: SeedUser[],
    dest: Parameters<NonNullable<Variation["expect"]>>[2],
    users: User[],
  ) =>
    dest === "D1"
      ? [
          ...expectLanded({ ...workosLanded, ...extra })(clerk, seeded, dest),
          ...idsCarried(seeded, users),
        ]
      : [];

/** 10 keys (WorkOS's cap), 40-char keys, 600-char ASCII values. */
const AT_LIMIT = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [
    `k${i}`.padEnd(40, "x"),
    String.fromCharCode(97 + i).repeat(600),
  ]),
);

const UNICODE_NAMES: [string | null, string | null][] = [
  ["Zoë", "Brontë"],
  ["Łukasz", "Żółć"],
  ["José", null],
  [null, "Nakamura"],
];

export const variations: Variation[] = [
  {
    id: "W1",
    describe: "email + password (bcrypt hash in; WorkOS never gives one back)",
    users: cohort({ emailOnly: 6, both: 4 }),
    expect: check(),
  },
  {
    id: "W2",
    describe: "no password (Magic Auth style): exports the same shape as W1",
    users: (all) =>
      cohort({ emailOnly: 6, both: 4 })(all).map((u) => ({ ...u, hasPassword: false })),
    expect: check(),
  },
  {
    id: "W3",
    describe: "unverified emails",
    users: (all) =>
      cohort({ emailOnly: 4, both: 4 })(all).map((u) => ({ ...u, emailVerified: false })),
    expect: check({ withVerifiedEmail: 0 }),
  },
  {
    id: "W4",
    describe:
      "metadata: empty, at the limits (10 keys × 40-char keys × 600-char values), and the default",
    users: (all) =>
      cohort({ emailOnly: 6, both: 0 })(all).map((u, i) =>
        i < 2
          ? { ...u, metadata: { user: {} } }
          : i < 4
            ? { ...u, metadata: { user: AT_LIMIT } }
            : u,
      ),
    expect: (clerk, seeded, dest, users) => {
      const issues = check()(clerk, seeded, dest, users);
      if (dest !== "D1") return issues;
      // WorkOS metadata lands in private metadata, next to the keys the import writes itself.
      const OWN = new Set(["workosExternalId", "clerkMigrateRun", "clerkExternalId"]);
      const meta = (u: User) =>
        Object.entries(u.privateMetadata ?? {}).filter(([k]) => !OWN.has(k));
      const full = users.filter(
        (u) => meta(u).length === 10 && meta(u).every(([, v]) => String(v).length === 600),
      );
      const empty = users.filter((u) => meta(u).length === 0);
      if (full.length !== 2)
        issues.push(`at-limit metadata → private metadata: ${full.length}/2 intact`);
      if (empty.length !== 2)
        issues.push(`empty metadata → no private metadata: ${empty.length}/2`);
      return issues;
    },
  },
  {
    id: "W5",
    describe:
      "external_id at the 64-char limit, and name edge cases (unicode, first-only, last-only)",
    users: (all) =>
      cohort({ emailOnly: 4, both: 2 })(all).map((u, i) => ({
        ...u,
        sourceId: `ext-${u.id}-`.padEnd(64, "0"),
        ...(i < UNICODE_NAMES.length && {
          firstName: UNICODE_NAMES[i][0],
          lastName: UNICODE_NAMES[i][1],
          fullName: UNICODE_NAMES[i].filter(Boolean).join(" "),
        }),
      })),
    expect: (clerk, seeded, dest, users) => {
      const issues = check()(clerk, seeded, dest, users);
      if (dest !== "D1") return issues;
      for (const [first, last] of UNICODE_NAMES) {
        const u = users.find(
          (x) => (x.firstName ?? null) === first && (x.lastName ?? null) === last,
        );
        if (!u) issues.push(`name ${JSON.stringify([first, last])} did not arrive intact`);
      }
      return issues;
    },
  },
  {
    id: "W6",
    describe:
      "orgs + memberships + roles, and TOTP factors: none exported, all should drop cleanly",
    users: (all) =>
      cohort({ emailOnly: 3, both: 3 })(all).map((u, i) => ({
        ...u,
        orgs:
          i % 3 === 0
            ? [{ name: `${ORG}acme`, role: "admin" }]
            : i % 3 === 1
              ? [{ name: `${ORG}acme` }, { name: `${ORG}globex` }]
              : [],
        mfa: i % 2 === 0,
      })),
    expect: (clerk, seeded, dest, users) => [
      ...check()(clerk, seeded, dest, users),
      ...(users.some((u) => u.totpEnabled)
        ? ["a TOTP factor came across, which the source says it can't"]
        : []),
    ],
  },
  {
    id: "W7",
    describe:
      "combined: passwords, no-password, unverified, metadata, external_id, orgs and TOTP mixed",
    dests: ["D1", "D2", "D3", "D4", "D5"],
    users: (all) =>
      cohort({ emailOnly: 7, both: 5 })(all).map((u, i) => ({
        ...u,
        ...(i % 4 === 1 && { hasPassword: false }),
        ...(i % 5 === 2 && { emailVerified: false }),
        ...(i % 6 === 3 && { metadata: { user: { plan: "pro", seats: 5 } } }),
        ...(i % 3 === 0 && { sourceId: `crm-${u.id}` }),
        ...(i % 4 === 0 && { orgs: [{ name: `${ORG}initech` }] }),
        ...(i % 5 === 4 && { mfa: true }),
      })),
    expect: check({ withVerifiedEmail: (s) => s.filter((u) => u.emailVerified).length }),
  },
];
variations.push(
  reserving(variations.find((v) => v.id === "W3")!),
  // D2 requires an email: reserved, an unverified-only one meets it.
  reserving(
    variations.find((v) => v.id === "W7")!,
    { dests: ["D2"] },
  ),
);

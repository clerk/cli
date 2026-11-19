import type { ClerkClient, User } from "@clerk/backend";
import type { DestId } from "./clerk-dest";
import type { SeedUser } from "./users";

/** What the Clerk instance holds after an import, counted by the runner. */
export type ClerkSummary = {
  total: number;
  withPassword: number;
  withUsername: number;
  withPhone: number;
  withVerifiedEmail: number;
  banned: number;
};

/** Clerk instances a run can import into (see TARGETS in test-migrate.ts). */
export type TargetName = "dev" | "10k-dev" | "10k-prod";

export type Variation = {
  id: string;
  describe: string;
  /** Which `--target` instances this variation runs on. Default: dev only. */
  targets?: TargetName[];
  /** Seed file to draw users from. Default: data/users.json. */
  usersFile?: string;
  /** The export is meant to fail (a schema the exporter can't read); pass if it does. */
  expectExportFailure?: boolean;
  /** Set to the reason, and the runner records the variation as skipped. */
  skip?: string;
  /** Switch the source's own config (connection, tables…). Runs after the reset. */
  sourceConfig?: () => Promise<void>;
  /** ≤100 users, unless the run is a 10K one. */
  users: (all: SeedUser[]) => SeedUser[];
  /** Seed these users some other way than `bun seed.ts -p <provider>`. */
  seed?: (users: SeedUser[], seedPassword: string) => Promise<void>;
  /** Destination configs to run against. Default: D1 only. */
  dests?: DestId[];
  /**
   * Field-level expectations beyond "imported matches the dry run". Return the
   * mismatches; an empty list passes.
   */
  expect?: (clerk: ClerkSummary, seeded: SeedUser[], dest: DestId, users: User[]) => string[];
  /**
   * Checks the dry run itself: which users it rejected and why. Each reject
   * comes with its row from the export file, so a variation can say which
   * users *should* be rejected under this dest and compare the sets.
   */
  expectChecks?: (
    checks: DryRunChecks,
    rejected: Rejected[],
    seeded: SeedUser[],
    dest: DestId,
    exported: Record<string, unknown>[],
  ) => string[];
  /** Extra flags for both the dry run and the import (e.g. --require-password). */
  importArgs?: string[];
  /**
   * Runs after the dest config is applied, before the dry run: put users in
   * Clerk that the import must collide with. Returns their IDs; the runner
   * leaves them out of the summary and deletes them afterwards.
   */
  beforeImport?: (clerk: ClerkClient, seeded: SeedUser[]) => Promise<string[]>;
  /** Import the same export a second time: it must report "already imported" and add nothing. */
  reimport?: boolean;
};

export type DryRunChecks = {
  total: number;
  importable: number;
  rejects: { sourceId: string; reason: string }[];
  rejectReasons: { reason: string; count: number }[];
  warnings: string[];
};
export type Rejected = { sourceId: string; reason: string; row?: Record<string, unknown> };

/**
 * Compares the users a dry run rejected with the users that should have been,
 * and checks each reason mentions what it was rejected for.
 * `want` returns, per export row, the keyword its reason must contain (or null:
 * not rejected).
 */
export function expectRejected(
  rejected: Rejected[],
  rows: Record<string, unknown>[],
  idOf: (row: Record<string, unknown>) => string,
  want: (row: Record<string, unknown>) => RegExp | null,
): string[] {
  const issues: string[] = [];
  const got = new Map(rejected.map((r) => [r.sourceId, r.reason]));
  for (const row of rows) {
    const id = idOf(row);
    const rule = want(row);
    const reason = got.get(id);
    if (rule && !reason) issues.push(`${id} should be rejected (${rule.source})`);
    else if (!rule && reason) issues.push(`${id} rejected unexpectedly: ${reason}`);
    else if (rule && reason && !rule.test(reason))
      issues.push(`${id} rejected for "${reason}", expected /${rule.source}/`);
  }
  return issues.length > 6 ? [...issues.slice(0, 6), `…and ${issues.length - 6} more`] : issues;
}

export const RESERVE = "--reserve-unverified";

/**
 * `v` imported with --reserve-unverified, as `<id>R`: its unverified emails and
 * phones go on the create reserved. The runner checks every unverified
 * identifier in Clerk is reserved in a variation that passes the flag, and
 * none is in one that doesn't.
 */
export const reserving = (v: Variation, overrides: Partial<Variation> = {}): Variation => ({
  ...v,
  id: `${v.id}R`,
  describe: `${v.describe}, created reserved (${RESERVE})`,
  importArgs: [...(v.importArgs ?? []), RESERVE],
  ...overrides,
});

/** A provider's variations file: the list, plus optional source lifecycle hooks. */
export type VariationModule = {
  variations: Variation[];
  /** Empty the source. Default: `bun reset.ts -p <provider> -y`. */
  reset?: () => Promise<void>;
  /** Wait until the source serves what was seeded (search-index lag). */
  afterSeed?: (seeded: SeedUser[]) => Promise<void>;
  /** Put the source back the way the app expects it, after every variation ran. */
  afterAll?: () => Promise<void>;
};

/** Every nth user: keeps the generator's group ratios (60/15/25 at n=5). */
export const everyNth = (n: number) => (all: SeedUser[]) => all.filter((_, i) => i % n === 0);

/**
 * A small cohort that still covers the combinations: `counts` users per group,
 * and within each group, someone with a username, someone with a full name and
 * (where the group has phones) a European number come first. For sources where
 * every user costs a slow API call to seed or delete.
 */
export const mix =
  (counts: Partial<Record<SeedUser["group"], number>>) =>
  (all: SeedUser[]): SeedUser[] =>
    Object.entries(counts).flatMap(([group, n]) => {
      const pool = all.filter((u) => u.group === group);
      const wanted = [
        pool.find((u) => u.username),
        pool.find((u) => u.fullName),
        pool.find((u) => u.phone && !u.phone.startsWith("+1")),
      ].filter((u): u is SeedUser => !!u);
      const picked = [...new Set([...wanted, ...pool])];
      return picked.slice(0, n);
    });

type Want = Partial<Record<keyof ClerkSummary, number | ((seeded: SeedUser[]) => number)>>;

/**
 * On D1 everything the source carries should land. By default that is every
 * user, password, username and phone in the seed; `overrides` adjusts the
 * counts for a source that cannot carry one of them (Auth0 passwords, say).
 */
export const expectLanded =
  (overrides: Want = {}) =>
  (clerk: ClerkSummary, seeded: SeedUser[], dest: DestId) => {
    if (dest !== "D1") return [];
    const want: Want = {
      total: seeded.length,
      withPassword: seeded.filter((u) => u.hasPassword).length,
      withUsername: seeded.filter((u) => u.username).length,
      withPhone: seeded.filter((u) => u.phone).length,
      banned: seeded.filter((u) => u.banned).length,
      ...overrides,
    };
    return Object.entries(want).flatMap(([k, v]) => {
      const expected = typeof v === "function" ? v(seeded) : v;
      const got = clerk[k as keyof ClerkSummary];
      return got === expected ? [] : [`${k}: expected ${expected}, got ${got}`];
    });
  };

export const expectAllLanded = expectLanded();

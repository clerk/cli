/**
 * Grades an import against an answer key (data/custom-sources-answers/<name>.expected.json,
 * written by generate-custom-exports.ts in migration-test-apps).
 *
 * Every expected fact about a user is one check: it exists, each email and
 * phone (and whether it is verified), the primary of each, username, names,
 * banned, password, and each metadata key. Accuracy is checks passed over
 * checks made. A user that never landed fails every one of its checks, so
 * losing a user costs more than getting one field wrong.
 *
 * Failures are grouped by field + reason, so five users with a broken phone are
 * one problem listing five IDs, not five problems.
 */
import { isDeepStrictEqual } from "node:util";
import type { User } from "@clerk/backend";

/** What one user should become in Clerk. Absent = must be absent in Clerk too. */
export type Expected = {
  externalId: string;
  /** Rejected by the source (soft-deleted): must not be in Clerk. */
  skip?: string;
  /** A skipped user's emails, phones and username, for matching it by identifier. */
  identifiers?: string[];
  primaryEmail?: string;
  emails: string[];
  unverifiedEmails: string[];
  primaryPhone?: string;
  phones: string[];
  unverifiedPhones: string[];
  username?: string;
  firstName?: string;
  lastName?: string;
  banned: boolean;
  hasPassword: boolean;
  publicMetadata: Record<string, unknown>;
  privateMetadata: Record<string, unknown>;
  unsafeMetadata: Record<string, unknown>;
};

export type AnswerKey = {
  source: string;
  seedPassword: string;
  /**
   * strict: each metadata key must land in the field named here.
   * advisory: the export does not say where a key belongs, so any metadata
   *   field counts; a different one than the reference source's is a note.
   */
  metadataPlacement: "strict" | "advisory";
  /** Private keys graded even when placement is advisory or lenient: billing and CRM IDs, internal notes. */
  sensitive?: string[];
  /** Whether each unverified email and phone must land reserved (true) or not (false). Unset: not graded. */
  reserveUnverified?: boolean;
  users: Expected[];
};

export type Problem = { field: string; reason: string; ids: string[]; example?: string };

export type Grade = {
  grade: string;
  accuracy: number;
  passed: number;
  total: number;
  users: {
    expected: number;
    shouldImport: number;
    imported: number;
    correct: number;
    withProblems: number;
    notImported: number;
  };
  problems: Problem[];
  /** Not graded: advisory metadata placements and stray metadata keys. */
  notes: Problem[];
};

type Check = { field: string; ok: boolean; reason?: string; example?: string; note?: boolean };

const META = {
  publicMetadata: "public",
  privateMetadata: "private",
  unsafeMetadata: "unsafe",
} as const;
/** Private metadata keys the import adds on its own, not from the source data. */
const CLI_KEYS = new Set(["clerkMigrateRun", "clerkExternalId"]);
type MetaField = keyof typeof META;

export function letter(accuracy: number): string {
  if (accuracy === 1) return "A+";
  if (accuracy >= 0.95) return "A";
  if (accuracy >= 0.85) return "B";
  if (accuracy >= 0.7) return "C";
  if (accuracy >= 0.5) return "D";
  return "F";
}

const show = (v: unknown) =>
  v === undefined || v === null || v === "" ? "none" : JSON.stringify(v);

/** Checks for one expected user against what Clerk holds (`u` absent = not imported). */
/**
 * What the agent was never told, so its safe default shouldn't count against it:
 *   email / phone  no informative answer about verification: importing as
 *                  unverified is what the skill says to do, so it is a note
 *   placement      no informative answer about metadata: where each key landed
 *                  is a note, as long as it landed
 *   status         no informative answer about account states: banned where the
 *                  key skips, skipped (with a reason) or not banned where it bans,
 *                  is a note; nobody said what the state means
 */
export type Lenient = { email?: boolean; phone?: boolean; placement?: boolean; status?: boolean };

const UNTOLD_STATE = "nobody told the agent what this account state means";

function checksFor(
  e: Expected,
  u: User | undefined,
  badPasswords: Set<string>,
  placement: AnswerKey["metadataPlacement"],
  lenient: Lenient = {},
  sensitive: string[] = [],
  reserve?: boolean,
): Check[] {
  const checks: Check[] = [{ field: "user", ok: Boolean(u), reason: "not imported" }];
  // The @clerk/backend resources leave `reserved` out, so read the raw JSON.
  const raw = u?.raw as
    | {
        email_addresses?: { id: string; reserved?: boolean }[];
        phone_numbers?: { id: string; reserved?: boolean }[];
      }
    | null
    | undefined;
  const reservedIds = new Set(
    [...(raw?.email_addresses ?? []), ...(raw?.phone_numbers ?? [])]
      .filter((i) => i.reserved)
      .map((i) => i.id),
  );

  // ── identifiers: each expected one present, verified as expected, nothing extra ──
  const idChecks = (
    kind: "email" | "phone",
    verified: string[],
    unverified: string[],
    primary: string | undefined,
    held: { value: string; verified: boolean; reserved: boolean; id: string }[],
    primaryId: string | null | undefined,
  ) => {
    const find = (v: string) => held.find((h) => h.value.toLowerCase() === v.toLowerCase());
    const safeDefault = Boolean(lenient[kind]);
    const UNTOLD = "imported unverified; nobody told the agent how verification is marked";
    for (const v of verified) {
      const h = find(v);
      if (h && !h.verified && safeDefault) {
        checks.push(
          { field: kind, ok: true },
          { field: kind, ok: false, reason: UNTOLD, example: `${v}`, note: true },
        );
        continue;
      }
      checks.push({
        field: kind,
        ok: Boolean(h?.verified),
        reason: h ? "not verified" : "missing",
        example: `expected ${v}`,
      });
    }
    for (const v of unverified) {
      const h = find(v);
      checks.push({
        field: kind,
        ok: Boolean(h && !h.verified),
        reason: h ? "verified, should be unverified" : "missing",
        example: `expected ${v} (unverified)`,
      });
      // Reserved is still unverified: graded only where the key says which it should be.
      if (h && !h.verified && reserve !== undefined)
        checks.push({
          field: kind,
          ok: h.reserved === reserve,
          reason: reserve ? "unverified, should be reserved" : "reserved, should be unverified",
          example: v,
        });
    }
    if (primary) {
      const got = held.find((h) => h.id === primaryId)?.value;
      const ok = got?.toLowerCase() === primary.toLowerCase();
      // An unverified address can't be primary: that follows from the safe default above.
      if (!ok && safeDefault && find(primary) && !find(primary)!.verified)
        checks.push({ field: `primary ${kind}`, ok: true });
      else
        checks.push({
          field: `primary ${kind}`,
          ok,
          reason: "wrong value",
          example: `expected ${primary}, got ${show(got)}`,
        });
    }
    const want = new Set([...verified, ...unverified].map((v) => v.toLowerCase()));
    for (const h of held) {
      if (!want.has(h.value.toLowerCase()))
        checks.push({
          field: kind,
          ok: false,
          reason: "unexpected value",
          example: `got ${h.value}`,
        });
    }
  };
  idChecks(
    "email",
    e.emails,
    e.unverifiedEmails,
    e.primaryEmail,
    (u?.emailAddresses ?? []).map((a) => ({
      value: a.emailAddress,
      verified: a.verification?.status === "verified",
      reserved: reservedIds.has(a.id),
      id: a.id,
    })),
    u?.primaryEmailAddressId,
  );
  idChecks(
    "phone",
    e.phones,
    e.unverifiedPhones,
    e.primaryPhone,
    (u?.phoneNumbers ?? []).map((p) => ({
      value: p.phoneNumber,
      verified: p.verification?.status === "verified",
      reserved: reservedIds.has(p.id),
      id: p.id,
    })),
    u?.primaryPhoneNumberId,
  );

  // ── plain fields: checked when either side has a value ──
  for (const field of ["username", "firstName", "lastName"] as const) {
    const want = e[field];
    const got = u?.[field] ?? undefined;
    if (!want && !got) continue;
    // Clerk lowercases usernames.
    const same = field === "username" ? want?.toLowerCase() === got?.toLowerCase() : want === got;
    checks.push({
      field,
      ok: same,
      reason: !got ? "missing" : !want ? "unexpected value" : "wrong value",
      example: `expected ${show(want)}, got ${show(got)}`,
    });
  }
  const bannedOk = Boolean(u?.banned) === e.banned;
  const bannedExample = `expected ${e.banned}, got ${Boolean(u?.banned)}`;
  if (!bannedOk && u && lenient.status) {
    checks.push(
      { field: "banned", ok: true },
      {
        field: "banned",
        ok: false,
        reason: `wrong value; ${UNTOLD_STATE}`,
        example: bannedExample,
        note: true,
      },
    );
  } else {
    checks.push({ field: "banned", ok: bannedOk, reason: "wrong value", example: bannedExample });
  }

  if (e.hasPassword) {
    const ok = Boolean(u?.passwordEnabled) && !badPasswords.has(u!.id);
    checks.push({
      field: "password",
      ok,
      reason: u?.passwordEnabled ? "won't sign in" : "missing",
    });
  } else if (u?.passwordEnabled) {
    checks.push({ field: "password", ok: false, reason: "unexpected value" });
  }

  // ── metadata: each expected key, by value, wherever it landed ──
  const fields = Object.keys(META) as MetaField[];
  const held = (f: MetaField) => (u?.[f] ?? {}) as Record<string, unknown>;
  const expectedKeys = new Set<string>();
  for (const want of fields) {
    for (const [k, v] of Object.entries(e[want])) {
      expectedKeys.add(k);
      // A golden key holds its own import's run ID; every import writes a new one. clerkExternalId is the
      // source's own ID, the same every time, so it is still compared.
      if (k === "clerkMigrateRun") continue;
      const where = fields.filter((f) => isDeepStrictEqual(held(f)[k], v));
      const there = fields.find((f) => k in held(f));
      const reason = where.length ? "wrong metadata field" : there ? "wrong value" : "missing";
      const example = where.length
        ? `${k} expected in ${META[want]}, found in ${where.map((f) => META[f]).join(" + ")}`
        : `${k} expected ${show(v)}, got ${there ? show(held(there)[k]) : "none"}`;
      if (placement === "strict") {
        checks.push({ field: "metadata", ok: where.includes(want), reason, example });
      } else if (sensitive.includes(k) && where.some((f) => f !== "privateMetadata")) {
        // Placement is advisory, but a billing or CRM ID or an internal note must never reach the browser.
        checks.push({
          field: "metadata",
          ok: false,
          reason: "sensitive key readable in the browser",
          example,
        });
      } else {
        checks.push({ field: "metadata", ok: where.length > 0, reason, example });
        if (where.length && !where.includes(want))
          checks.push({ field: "metadata", ok: false, reason, example, note: true });
      }
    }
  }
  for (const f of fields) {
    for (const k of Object.keys(held(f))) {
      // The CLI writes these itself: the import's run ID on every user, and a Clerk source's own external ID.
      // ponytail: skipped, not checked against the run ID; compare them if the CLI ever gets them wrong.
      if (f === "privateMetadata" && CLI_KEYS.has(k)) continue;
      if (!expectedKeys.has(k))
        checks.push({
          field: "metadata",
          ok: false,
          reason: "unexpected key",
          example: `${META[f]}.${k} = ${show(held(f)[k])}`,
          note: true,
        });
    }
  }
  return checks;
}

/**
 * @param users - Everything in the Clerk instance after the import.
 * @param rejected - Source ID (or a lowercased identifier) → why the CLI did not create that user.
 * @param badPasswords - Clerk IDs whose password did not verify.
 * @param opts.matchBy - "identifiers" when the source was seeded afresh, so its
 *   IDs differ from the answer key's: users are matched by email, phone or
 *   username alone, and a different user ID is not a problem.
 */
export function grade(
  key: AnswerKey,
  users: User[],
  rejected: Map<string, string>,
  badPasswords: Set<string>,
  opts: { matchBy?: "id" | "identifiers"; lenient?: Lenient } = {},
): Grade {
  const byIdentifiers = opts.matchBy === "identifiers";
  const problems = new Map<string, Problem>();
  const notes = new Map<string, Problem>();
  const add = (
    into: Map<string, Problem>,
    field: string,
    reason: string,
    id: string,
    example?: string,
  ) => {
    const k = `${field}\u0000${reason}`;
    const p = into.get(k) ?? into.set(k, { field, reason, ids: [], example }).get(k)!;
    if (!p.ids.includes(id)) p.ids.push(id);
  };

  const byExternal = new Map(users.filter((u) => u.externalId).map((u) => [u.externalId!, u]));
  const claimed = new Set<string>();
  let passed = 0;
  let total = 0;
  let imported = 0;
  let correct = 0;
  let importedCorrect = 0;
  let notImported = 0;

  const idsOf = (e: Expected) =>
    new Set(
      [
        ...e.emails,
        ...e.unverifiedEmails,
        ...e.phones,
        ...e.unverifiedPhones,
        e.username,
        ...(e.identifiers ?? []),
      ]
        .filter(Boolean)
        .map((v) => v!.toLowerCase()),
    );
  const findByIdentifiers = (mine: Set<string>) =>
    users.find(
      (c) =>
        !claimed.has(c.id) &&
        [
          ...c.emailAddresses.map((a) => a.emailAddress),
          ...c.phoneNumbers.map((p) => p.phoneNumber),
          c.username ?? "",
        ].some((v) => mine.has(v.toLowerCase())),
    );

  for (const e of key.users) {
    let u = byIdentifiers ? findByIdentifiers(idsOf(e)) : byExternal.get(e.externalId);
    let idProblem: string | undefined;
    // A wrong userId mapping still lands the user: find it by identifier so the
    // rest of its fields are graded, and report the ID once.
    if (!u && !byIdentifiers) {
      u = findByIdentifiers(idsOf(e));
      if (u) idProblem = `expected ${e.externalId}, got ${show(u.externalId)}`;
    }
    if (u) claimed.add(u.id);

    const lenient = opts.lenient ?? {};
    const ownRejection = () =>
      rejected.get(e.externalId) ?? [...idsOf(e)].map((i) => rejected.get(i)).find(Boolean);
    const rejection = () => ownRejection() ?? rejected.get("*");
    if (e.skip) {
      total++;
      // Banned keeps them out as surely as skipped, and nobody said the state meant deleted.
      if (u && lenient.status && u.banned)
        add(notes, "user", `imported banned, not skipped; ${UNTOLD_STATE}`, e.externalId, e.skip);
      if (u && !(lenient.status && u.banned))
        add(problems, "user", "should have been skipped", e.externalId, e.skip);
      else {
        passed++;
        correct++;
      }
      continue;
    }
    // The reverse: a banned user the source left out with a recorded reason.
    // ponytail: any per-user reason counts, so a CLI rejection of a banned user also reads as a skip.
    const skippedFor = !u && e.banned && lenient.status ? ownRejection() : undefined;
    if (skippedFor) {
      total++;
      passed++;
      correct++;
      add(notes, "user", `skipped, not imported banned; ${UNTOLD_STATE}`, e.externalId, skippedFor);
      continue;
    }

    const checks = checksFor(
      e,
      u,
      badPasswords,
      lenient.placement ? "advisory" : key.metadataPlacement,
      lenient,
      key.sensitive,
      key.reserveUnverified,
    );
    if (idProblem)
      checks.push({ field: "userId", ok: false, reason: "wrong value", example: idProblem });
    const graded = checks.filter((c) => !c.note);
    total += graded.length;
    passed += graded.filter((c) => c.ok).length;
    for (const c of checks.filter((c) => c.note))
      add(notes, c.field, c.reason!, e.externalId, c.example);

    if (!u) {
      // One problem for the user, not one per field it would have had.
      notImported++;
      const reason = rejection();
      // No record at all: the CLI never saw the user, because the source left it out.
      add(
        problems,
        "user",
        `not imported: ${reason ?? "never reached the CLI (the source left it out)"}`,
        e.externalId,
      );
      continue;
    }
    imported++;
    const failed = graded.filter((c) => !c.ok);
    if (!failed.length) {
      correct++;
      importedCorrect++;
    }
    for (const c of failed) add(problems, c.field, c.reason!, e.externalId, c.example);
  }

  for (const u of users.filter((c) => !claimed.has(c.id))) {
    total++;
    add(
      problems,
      "user",
      "unexpected user",
      u.externalId ?? u.id,
      "in Clerk but not in the answer key",
    );
  }

  const accuracy = total ? passed / total : 0;
  const byCount = (a: Problem, b: Problem) => b.ids.length - a.ids.length;
  const shouldImport = key.users.filter((e) => !e.skip).length;
  return {
    grade: letter(accuracy),
    accuracy,
    passed,
    total,
    users: {
      expected: key.users.length,
      shouldImport,
      imported,
      correct,
      withProblems: imported - importedCorrect,
      notImported,
    },
    problems: [...problems.values()].sort(byCount),
    notes: [...notes.values()].sort(byCount),
  };
}

const pct = (n: number) => `${(Math.floor(n * 1000) / 10).toFixed(1)}%`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** One line for the terminal. */
export function summaryLine(name: string, g: Grade) {
  return (
    `${name.padEnd(14)} ${g.grade.padEnd(3)} ${pct(g.accuracy).padStart(6)}   ${g.users.correct}/${g.users.expected} users correct` +
    (g.problems.length ? `   ${plural(g.problems.length, "problem")}` : "")
  );
}

/** The report section for one export. */
export function section(name: string, source: string, g: Grade, error?: string): string {
  const out = [
    `## ${name}: ${g.grade} (${pct(g.accuracy)}, ${g.passed} / ${g.total} checks)`,
    "",
    `Source: \`${source}\``,
    "",
  ];
  if (error) out.push(`**Run failed:** ${error}`, "");
  const u = g.users;
  out.push(
    `Users: ${u.expected} in export · ${u.shouldImport} should import · ${u.imported} imported · ` +
      `${u.correct} correct · ${u.withProblems} with problems · ${u.notImported} not imported`,
    "",
  );
  const list = (title: string, ps: Problem[]) => {
    if (!ps.length) return;
    out.push(`### ${title} (${ps.length})`, "");
    ps.forEach((p, i) => {
      out.push(`${i + 1}. **${p.field} · ${p.reason}** · ${plural(p.ids.length, "user")}`);
      out.push(`   ${p.ids.map((id) => `\`${id}\``).join(" ")}`);
      if (p.example) out.push(`   e.g. ${p.example}`);
    });
    out.push("");
  };
  if (!g.problems.length && !error) out.push("✅ Every user fully and correctly imported.", "");
  list("Problems", g.problems);
  list("Notes (not graded)", g.notes);
  return out.join("\n");
}

/**
 * The Migration Readiness report: what the import file contains, cross-
 * referenced against what the destination instance actually accepts.
 *
 * Ported from the standalone migration-tool's `displayCrossReference`. Split
 * into a pure {@link buildReadinessReport} and a separate renderer so the
 * cross-reference decisions are testable without parsing coloured output.
 *
 * The point of the report is to surface, *before* anything is written to
 * Clerk, the two failure modes a migration only discovers halfway through:
 * a field Clerk requires that some users lack, and a social provider users
 * signed up with that Clerk has not enabled.
 */

import type { UserSettingsJSON } from "../../../lib/fapi.ts";
import { bold, dim, green, red, yellow } from "../../../lib/color.ts";
// Pure attribute lookups, shared with the `users` create wizard.
import { isEnabled, isRequired, type AttributeName } from "../../users/interactive/attributes.ts";
import type { User } from "../types.ts";
import { hasValue, type FieldAnalysis } from "./analysis.ts";
import { providerLabel, toClerkStrategy } from "./clerk-config.ts";

export const DASHBOARD_URL = "https://dashboard.clerk.com/~/user-authentication";

export type ReadinessSection = "identifiers" | "auth" | "social" | "model";

/**
 * One row of the report.
 *
 * @property clerkEnabled - `null` when the instance settings could not be read,
 *   which is different from `false` ("read, and it is off").
 * @property blocking - This row will cost users unless the operator acts.
 */
export type ReadinessItem = {
  label: string;
  /**
   * What the row is about, machine-side: an {@link AttributeName} for every
   * section but `social`, and the source platform's provider key for that one.
   * `label` is for humans; this is what `modify-settings.ts` looks up.
   */
  key: string;
  section: ReadinessSection;
  /** Users in the file that carry this field or provider. */
  userCount: number;
  clerkEnabled: boolean | null;
  clerkRequired: boolean | null;
  blocking: boolean;
  /**
   * What this row costs the users it affects.
   *
   * - `rejects` — Clerk refuses the user outright. Only a required identifier
   *   does this: `POST /v1/users` enforces the instance's sign-up identifier
   *   requirements, and a user carrying none of them has nothing to be created
   *   under.
   * - `drops` — the user is created, but this piece of them is not. A required
   *   password is in this group rather than `rejects` because the import sends
   *   `skip_password_requirement` (see `import-users.ts`), so the user lands
   *   without one and has to reset it before they can sign in that way.
   */
  consequence?: "rejects" | "drops";
  /** Why it blocks — omitted when it does not. */
  detail?: string;
};

/** One reason users are affected, and how many of them it affects. */
export type OutcomeReason = { label: string; count: number; detail: string };

/**
 * What the settings mean for the users in the file, counted per user rather
 * than per field.
 *
 * Per-field coverage cannot answer "how many users will not be imported" —
 * the users missing an email and the users missing a username overlap by an
 * unknown amount. Each user is classified once, into the worst outcome that
 * applies to them, so the three totals add up to the file.
 */
export type ImportOutcomes = {
  rejected: number;
  rejectedReasons: OutcomeReason[];
  /**
   * What *else* affects the rejected users — surfaced now rather than after
   * they become importable.
   *
   * A user who is not being created cannot lose a field, so these settings cost
   * nothing today and would otherwise go unmentioned. But the moment the
   * operator relaxes the requirement rejecting them, every one of these lands.
   * Reporting it only afterwards turns one decision into a apply → re-check →
   * discover → apply → re-check loop, which is exactly what the report exists
   * to prevent.
   */
  maskedReasons: OutcomeReason[];
  incomplete: number;
  incompleteReasons: OutcomeReason[];
  /** Imported with everything the file carries for them. */
  complete: number;
};

export type ReadinessReport = {
  totalUsers: number;
  /** Users with no identifier at all; they cannot be imported under any settings. */
  withoutIdentifier: number;
  validationFailed: number;
  items: ReadinessItem[];
  /** Every item flagged `blocking`, in report order. */
  blocking: ReadinessItem[];
  /** True when the instance settings could not be read. */
  settingsUnavailable: boolean;
  /** Omitted when the caller passed no users to classify. */
  outcomes?: ImportOutcomes;
};

type BuildInput = {
  analysis: FieldAnalysis;
  /** `null` when no publishable key was available, or FAPI could not be read. */
  settings: UserSettingsJSON | null;
  validationFailed?: number;
  /** Source-platform provider key → user count. Supabase exports only. */
  providerCounts?: Record<string, number>;
  /**
   * The users themselves, for the per-user outcome counts. Optional so callers
   * that only need the coverage rows (and tests working from a synthetic
   * {@link FieldAnalysis}) do not have to supply them.
   */
  users?: User[];
};

/**
 * Identifiers Clerk creates a user *under*. A required one that a user does not
 * carry leaves nothing to create them with, so the API refuses them — which is
 * why these are the only attributes whose consequence is `rejects`.
 */
const IDENTIFIER_ATTRIBUTES = new Set<AttributeName>(["email_address", "phone_number", "username"]);

/** An identifier or user-model row, with its blocking verdict. */
function buildAttributeItem(
  label: string,
  section: ReadinessSection,
  attribute: AttributeName,
  userCount: number,
  settings: UserSettingsJSON | null,
  totalUsers: number,
): ReadinessItem {
  const enabled = settings ? isEnabled(settings, attribute) : null;
  const required = settings ? isRequired(settings, attribute) : null;
  const missing = totalUsers - userCount;

  // Required but not universal is the expensive case: those users fail one by
  // one, mid-import, after earlier users have already been created.
  if (required === true && missing > 0) {
    return {
      label,
      key: attribute,
      section,
      userCount,
      clerkEnabled: enabled,
      clerkRequired: required,
      blocking: true,
      consequence: IDENTIFIER_ATTRIBUTES.has(attribute) ? "rejects" : "drops",
      // How many users this costs is the outcome block's job. Restating it here
      // reads as a contradiction, because that block counts each user once and
      // this row counts the field — a user missing both an email and a password
      // appears in both rows but only in the first outcome.
      detail: "required in Clerk, and not every user has one",
    };
  }

  // Present in the file but switched off in Clerk: the data is silently dropped.
  if (enabled === false && userCount > 0) {
    return {
      label,
      key: attribute,
      section,
      userCount,
      clerkEnabled: enabled,
      clerkRequired: required,
      blocking: true,
      consequence: "drops",
      detail: "not enabled in Clerk",
    };
  }

  return {
    label,
    key: attribute,
    section,
    userCount,
    clerkEnabled: enabled,
    clerkRequired: required,
    blocking: false,
  };
}

/**
 * Cross-references the file against the instance.
 *
 * A field absent from the file contributes no row — the report describes what
 * is actually being imported, not every setting Clerk supports.
 */
export function buildReadinessReport(input: BuildInput): ReadinessReport {
  const { analysis, settings, validationFailed = 0, providerCounts = {} } = input;
  const total = analysis.totalUsers;
  const items: ReadinessItem[] = [];

  const emailCount = analysis.identifiers.verifiedEmails + analysis.identifiers.unverifiedEmails;
  const phoneCount = analysis.identifiers.verifiedPhones + analysis.identifiers.unverifiedPhones;

  const attributeRows: [string, ReadinessSection, AttributeName, number][] = [
    ["Email", "identifiers", "email_address", emailCount],
    ["Phone", "identifiers", "phone_number", phoneCount],
    ["Username", "identifiers", "username", analysis.identifiers.username],
    ["Password", "auth", "password", analysis.fieldCounts.password ?? 0],
    ["First name", "model", "first_name", analysis.fieldCounts.firstName ?? 0],
    ["Last name", "model", "last_name", analysis.fieldCounts.lastName ?? 0],
  ];

  for (const [label, section, attribute, count] of attributeRows) {
    if (count > 0) {
      items.push(buildAttributeItem(label, section, attribute, count, settings, total));
    }
  }

  for (const [provider, count] of Object.entries(providerCounts)) {
    if (count === 0) continue;
    const enabled = settings
      ? (settings.social?.[toClerkStrategy(provider) as keyof typeof settings.social]?.enabled ??
        false)
      : null;
    items.push({
      label: providerLabel(provider),
      key: provider,
      section: "social",
      userCount: count,
      clerkEnabled: enabled,
      clerkRequired: null,
      blocking: enabled === false,
      ...(enabled === false
        ? { consequence: "drops" as const, detail: "not enabled in Clerk" }
        : {}),
    });
  }

  const blocking = items.filter((item) => item.blocking);

  return {
    totalUsers: total,
    withoutIdentifier: total - analysis.identifiers.hasAnyIdentifier,
    validationFailed,
    items,
    blocking,
    settingsUnavailable: settings === null,
    ...(input.users ? { outcomes: countOutcomes(input.users, blocking) } : {}),
  };
}

/** Whether a user carries the field an attribute row is about. */
const CARRIES: Record<string, (user: Record<string, unknown>) => boolean> = {
  email_address: (u) =>
    hasValue(u.email) || hasValue(u.emailAddresses) || hasValue(u.unverifiedEmailAddresses),
  phone_number: (u) =>
    hasValue(u.phone) || hasValue(u.phoneNumbers) || hasValue(u.unverifiedPhoneNumbers),
  username: (u) => hasValue(u.username),
  password: (u) => hasValue(u.password),
  first_name: (u) => hasValue(u.firstName),
  last_name: (u) => hasValue(u.lastName),
};

/** Which users a flagged row actually affects: the ones missing it, or carrying it. */
function affects(item: ReadinessItem, user: Record<string, unknown>): boolean {
  const carries = CARRIES[item.key];
  if (!carries) return false;
  // A required row costs the users without it; a disabled row costs the ones with it.
  return item.clerkRequired === true ? !carries(user) : carries(user);
}

/**
 * One reason line: how many users, what they are missing or carrying, and what
 * the instance does about it. Count first, because that is what is being
 * decided on.
 */
function describe(item: ReadinessItem, count: number): string {
  const noun = item.label.toLowerCase();
  const have = count === 1 ? "has" : "have";

  if (item.clerkRequired === true) {
    const consequence = item.key === "password" ? " — they will have to reset it to sign in" : "";
    return `${count} ${have} no ${noun}, which this instance requires${consequence}`;
  }
  return `${count} ${have} a ${noun}, which this instance is not set up to store`;
}

function toReasons(counts: Map<string, { item: ReadinessItem; count: number }>): OutcomeReason[] {
  return [...counts].map(([label, { item, count }]) => ({
    label,
    count,
    detail: describe(item, count),
  }));
}

/**
 * Classifies every user into exactly one outcome, worst first.
 *
 * Social rows are left out: which providers a user signed up with lives in the
 * raw export rather than the transformed `User`, so they cannot be counted per
 * user here. Their coverage row still names them.
 */
function countOutcomes(users: User[], blocking: ReadinessItem[]): ImportOutcomes {
  const rejecting = blocking.filter((item) => item.consequence === "rejects");
  const dropping = blocking.filter(
    (item) => item.consequence === "drops" && item.section !== "social",
  );

  type Tally = Map<string, { item: ReadinessItem; count: number }>;
  const rejectedBy: Tally = new Map();
  const droppedBy: Tally = new Map();
  const maskedBy: Tally = new Map();
  let rejected = 0;
  let incomplete = 0;
  let complete = 0;

  const tally = (into: Tally, item: ReadinessItem) => {
    const entry = into.get(item.label) ?? { item, count: 0 };
    entry.count++;
    into.set(item.label, entry);
  };

  for (const entry of users) {
    const user = entry as unknown as Record<string, unknown>;
    const gaps = dropping.filter((item) => affects(item, user));

    const refusals = rejecting.filter((item) => affects(item, user));
    if (refusals.length > 0) {
      rejected++;
      for (const item of refusals) tally(rejectedBy, item);
      // Their gaps are still tallied, into a separate bucket. Dropping them
      // here is what makes the settings interact invisibly: relaxing the
      // requirement that rejects these users lets them in, and only then does
      // whatever else affects them show up — a second round trip to learn
      // something that was knowable now.
      for (const item of gaps) tally(maskedBy, item);
      continue;
    }

    if (gaps.length === 0) {
      complete++;
      continue;
    }

    incomplete++;
    for (const item of gaps) tally(droppedBy, item);
  }

  return {
    rejected,
    rejectedReasons: toReasons(rejectedBy),
    maskedReasons: toReasons(maskedBy),
    incomplete,
    incompleteReasons: toReasons(droppedBy),
    complete,
  };
}

const SECTION_ORDER: ReadinessSection[] = ["identifiers", "auth", "social", "model"];
const SECTION_LABELS: Record<ReadinessSection, string> = {
  identifiers: "Identifiers",
  auth: "Authentication",
  social: "Social connections",
  model: "User model",
};

function renderItem(item: ReadinessItem, total: number): string {
  const coverage = item.userCount === total ? "all users" : `${item.userCount}/${total} users`;

  if (item.blocking) {
    return `  ${yellow("⚠")} ${item.label} — ${yellow(item.detail ?? "needs attention")} — ${dim(coverage)}`;
  }
  if (item.clerkEnabled === true) {
    return `  ${green("✓")} ${item.label} — ${dim(`enabled in Clerk — ${coverage}`)}`;
  }
  // Settings unavailable: state coverage without claiming anything about Clerk.
  return `  ${yellow("!")} ${item.label} — ${dim(`${coverage} — check it is enabled in Clerk`)}`;
}

const users = (count: number) => `${count} user${count === 1 ? "" : "s"}`;

/**
 * The three outcomes, each with the reasons behind it.
 *
 * This is the part of the report that answers "so what": which users the
 * instance will refuse, which will arrive with something missing, and why.
 * Per-field coverage lives further down and is a different question.
 */
function renderOutcomes(outcomes: ImportOutcomes): string[] {
  const lines: string[] = [];

  const group = (
    symbol: string,
    colour: (text: string) => string,
    headline: string,
    reasons: OutcomeReason[],
  ) => {
    lines.push(`  ${colour(symbol)} ${colour(headline)}`);
    for (const reason of reasons) lines.push(`      ${dim(reason.detail)}`);
  };

  if (outcomes.rejected > 0) {
    group("✗", red, `${users(outcomes.rejected)} will not be imported`, outcomes.rejectedReasons);

    // Named here rather than left for a second run of the report: these are the
    // settings that start costing something the moment the rejection above is
    // lifted, and lifting it is one of the changes on offer.
    if (outcomes.maskedReasons.length > 0) {
      lines.push(`      ${dim("If you import them, this applies to them too:")}`);
      for (const reason of outcomes.maskedReasons) lines.push(`        ${dim(reason.detail)}`);
    }
  }
  if (outcomes.incomplete > 0) {
    group(
      "⚠",
      yellow,
      `${users(outcomes.incomplete)} will be imported, but not everything they carry`,
      outcomes.incompleteReasons,
    );
  }
  if (outcomes.complete > 0) {
    lines.push(`  ${green("✓")} ${green(`${users(outcomes.complete)} will be imported in full`)}`);
  }

  return lines;
}

/** Renders the report for a human, as lines. */
export function formatReadinessReport(report: ReadinessReport): string[] {
  const lines: string[] = [bold("Migration readiness")];

  lines.push(`  ${users(report.totalUsers)} in this file`);
  if (report.validationFailed > 0) {
    lines.push(`  ${yellow(`${report.validationFailed} failed validation and will be skipped`)}`);
  }
  if (report.withoutIdentifier > 0) {
    lines.push(
      `  ${red(`${report.withoutIdentifier} without any identifier — cannot be imported`)}`,
    );
  }

  if (report.outcomes) {
    const outcomeLines = renderOutcomes(report.outcomes);
    if (outcomeLines.length > 0) lines.push("", ...outcomeLines);
  }

  if (report.settingsUnavailable) {
    lines.push(
      "",
      `  ${yellow("!")} ${dim("Could not read this instance's settings, so the checks below are coverage only.")}`,
      `  ${dim(`  Verify your settings at ${DASHBOARD_URL}`)}`,
    );
  }

  for (const section of SECTION_ORDER) {
    const sectionItems = report.items.filter((item) => item.section === section);
    if (sectionItems.length === 0) continue;

    lines.push("", bold(SECTION_LABELS[section]));
    for (const item of sectionItems) lines.push(renderItem(item, report.totalUsers));
  }

  lines.push("");
  if (report.blocking.length > 0) {
    const count = report.blocking.length;
    lines.push(
      yellow(`⚠ ${count} setting${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} attention`),
      dim(`  ${DASHBOARD_URL}`),
    );
  } else if (!report.settingsUnavailable) {
    lines.push(green("✓ Every field in this file is configured in Clerk"));
  }

  return lines;
}

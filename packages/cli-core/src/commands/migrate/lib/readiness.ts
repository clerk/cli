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
import type { FieldAnalysis } from "./analysis.ts";
import { providerLabel, toClerkStrategy } from "./clerk-config.ts";

const DASHBOARD_URL = "https://dashboard.clerk.com/~/user-authentication";

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
  section: ReadinessSection;
  /** Users in the file that carry this field or provider. */
  userCount: number;
  clerkEnabled: boolean | null;
  clerkRequired: boolean | null;
  blocking: boolean;
  /** Why it blocks — omitted when it does not. */
  detail?: string;
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
};

type BuildInput = {
  analysis: FieldAnalysis;
  /** `null` when no publishable key was available, or FAPI could not be read. */
  settings: UserSettingsJSON | null;
  validationFailed?: number;
  /** Source-platform provider key → user count. Supabase exports only. */
  providerCounts?: Record<string, number>;
};

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
      section,
      userCount,
      clerkEnabled: enabled,
      clerkRequired: required,
      blocking: true,
      detail:
        missing === 1
          ? "required in Clerk, but 1 user lacks it"
          : `required in Clerk, but ${missing} users lack it`,
    };
  }

  // Present in the file but switched off in Clerk: the data is silently dropped.
  if (enabled === false && userCount > 0) {
    return {
      label,
      section,
      userCount,
      clerkEnabled: enabled,
      clerkRequired: required,
      blocking: true,
      detail: "not enabled in Clerk",
    };
  }

  return {
    label,
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
      section: "social",
      userCount: count,
      clerkEnabled: enabled,
      clerkRequired: null,
      blocking: enabled === false,
      ...(enabled === false ? { detail: "not enabled in Clerk" } : {}),
    });
  }

  return {
    totalUsers: total,
    withoutIdentifier: total - analysis.identifiers.hasAnyIdentifier,
    validationFailed,
    items,
    blocking: items.filter((item) => item.blocking),
    settingsUnavailable: settings === null,
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
  return `  ${yellow("○")} ${item.label} — ${dim(`${coverage} — check it is enabled in Clerk`)}`;
}

/** Renders the report for a human, as lines. */
export function formatReadinessReport(report: ReadinessReport): string[] {
  const lines: string[] = [bold("Migration readiness")];

  lines.push(`  ${report.totalUsers} user${report.totalUsers === 1 ? "" : "s"} ready to import`);
  if (report.validationFailed > 0) {
    lines.push(`  ${yellow(`${report.validationFailed} failed validation and will be skipped`)}`);
  }
  if (report.withoutIdentifier > 0) {
    lines.push(
      `  ${red(`${report.withoutIdentifier} without any identifier — cannot be imported`)}`,
    );
  }

  if (report.settingsUnavailable) {
    lines.push(
      "",
      `  ${yellow("○")} ${dim("Could not read this instance's settings, so the checks below are coverage only.")}`,
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

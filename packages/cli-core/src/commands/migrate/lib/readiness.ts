/**
 * What the import file contains, cross-referenced against what the
 * destination instance accepts, one row per field.
 *
 * Ported from the standalone migration-tool's `displayCrossReference`. The
 * import's checks read the flagged rows for their drop warnings and their
 * `clerk config patch` fixes; which users are rejected is decided per user in
 * `checks.ts`.
 */

import type { UserSettingsJSON } from "../../../lib/fapi.ts";
// Pure attribute lookups, shared with the `users` create wizard.
import { isEnabled, isRequired, type AttributeName } from "../../users/interactive/attributes.ts";
import type { FieldAnalysis } from "./analysis.ts";
import { clerkOffersProvider, providerLabel, toClerkStrategy } from "./clerk-config.ts";

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
   *   without one and signs in another way. With no other way, the checks
   *   reject the user (`passwordIsOnlySignIn`).
   * - `stored` — the user is created with it, but the instance does not use
   *   it until the setting is turned on. Clerk stores these whatever the
   *   setting (`create_service.go` validates them but never checks it).
   */
  consequence?: "rejects" | "drops" | "stored";
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

/**
 * Identifiers Clerk creates a user *under*. A required one that a user does not
 * carry leaves nothing to create them with, so the API refuses them — which is
 * why these are the only attributes whose consequence is `rejects`.
 */
const REJECTING_ATTRIBUTES = new Set<AttributeName>([
  "email_address",
  "phone_number",
  "username",
  "first_name",
  "last_name",
]);

/** Fields Clerk stores with their setting off, where it works once turned on. */
const STORED_WHEN_OFF = new Set<AttributeName>(["password", "username", "first_name", "last_name"]);

/**
 * True when Clerk keeps an email or phone on create: its setting is on, or
 * the instance signs in or does MFA with it (`IsEnabledOrFactor` in clerk_go).
 * Sign-up off alone does not refuse it.
 */
export function acceptsIdentifier(
  settings: UserSettingsJSON,
  attribute: "email_address" | "phone_number",
): boolean {
  const data = settings.attributes?.[attribute];
  return Boolean(data?.enabled || data?.used_for_first_factor || data?.used_for_second_factor);
}

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
  const accepted =
    settings && (attribute === "email_address" || attribute === "phone_number")
      ? acceptsIdentifier(settings, attribute)
      : enabled;
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
      consequence: REJECTING_ATTRIBUTES.has(attribute) ? "rejects" : "drops",
      // How many users this costs is the outcome block's job. Restating it here
      // reads as a contradiction, because that block counts each user once and
      // this row counts the field — a user missing both an email and a password
      // appears in both rows but only in the first outcome.
      detail: "required in Clerk, and not every user has one",
    };
  }

  // Present in the file but switched off in Clerk: dropped, or stored unused.
  if (accepted === false && userCount > 0) {
    return {
      label,
      key: attribute,
      section,
      userCount,
      clerkEnabled: enabled,
      clerkRequired: required,
      blocking: true,
      consequence: STORED_WHEN_OFF.has(attribute) ? "stored" : "drops",
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

  // Users, not fields: one with both a verified and an unverified phone is one.
  const emailCount = analysis.identifiers.anyEmail;
  const phoneCount = analysis.identifiers.anyPhone;

  const attributeRows: [string, ReadinessSection, AttributeName, number][] = [
    ["Email", "identifiers", "email_address", emailCount],
    ["Phone", "identifiers", "phone_number", phoneCount],
    ["Username", "identifiers", "username", analysis.identifiers.username],
    ["Password", "auth", "password", analysis.fieldCounts.password ?? 0],
    ["First name", "model", "first_name", analysis.fieldCounts.firstName ?? 0],
    ["Last name", "model", "last_name", analysis.fieldCounts.lastName ?? 0],
  ];

  for (const [label, section, attribute, count] of attributeRows) {
    // A required field nobody has still costs every user, so it gets a row.
    if (count > 0 || (settings && isRequired(settings, attribute))) {
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
        ? {
            consequence: "drops" as const,
            detail: clerkOffersProvider(provider) ? "not enabled in Clerk" : "not offered by Clerk",
          }
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
  };
}

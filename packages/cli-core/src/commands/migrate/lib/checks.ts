/**
 * `checkImport()`: what the instance will do with each user, worked out before
 * anything is written.
 *
 * Every import runs these checks, and `--dry-run` stops after them. They sort
 * the file into three piles:
 *
 * - **Rejects** — users Clerk would refuse, or that the run would refuse on
 *   Clerk's behalf. Any reject stops the import unless `--allow-partial` is
 *   passed, and then each one is recorded as `skipped` with its reason.
 * - **Warnings** — users that import, but lose something on the way: a field
 *   the instance is not set up to store, a field Clerk has no place for, a
 *   password it cannot verify.
 * - **Importable** — everyone else, in file order.
 *
 * Each rejected user gets the first reason that applies to them, so the counts
 * add up to the file.
 */

import type { UserSettingsJSON } from "../../../lib/fapi.ts";
import type { SpinnerControls } from "../../../lib/spinner.ts";
import { isEnabled, isRequired, type AttributeName } from "../../users/interactive/attributes.ts";
import { splitIdentifiers } from "../import-users.ts";
import type { User } from "../types.ts";
import { analyzeFields, hasValue } from "./analysis.ts";
import {
  clerkOffersProvider,
  enabledSocialProviders,
  providerLabel,
  toClerkStrategy,
} from "./clerk-config.ts";
import { resolveDevUserLimit } from "./instance.ts";
import { buildChangePayload, buildSettingChanges } from "./modify-settings.ts";
import { buildReadinessReport } from "./readiness.ts";
import type { ApiScheduler } from "./scheduler.ts";
import {
  countSocialProviders,
  findDisabledProviders,
  findUsersWithOnlyDisabledProviders,
  getUserProviders,
} from "./supabase-providers.ts";
import type { ClerkTarget } from "./target.ts";
import type { ValidationFailure } from "./transform.ts";
import { lookupUsers, type LookedUpUser } from "./user-lookup.ts";

export type Reject = {
  sourceId: string;
  reason: string;
  /** For a duplicate: the earlier user in the file that is kept instead. */
  keptSourceId?: string;
};

export type ReasonCount = { reason: string; count: number };

/** A `clerk config patch` that would stop a setting costing users. */
/**
 * A setting change that would stop users being flagged: a `clerk config patch`
 * command, or a Dashboard link when the instance can't be named for one.
 */
export type Fix = { label: string; command?: string; url?: string };

const DASHBOARD_URL = "https://dashboard.clerk.com";

export type Quota = {
  /** Users already in the instance, or `null` when the count could not be read. */
  existing: number | null;
  limit: number;
  headroom: number;
  /** Importable users over the headroom. */
  over: number;
};

export type ImportChecks = {
  /** Users in the file being considered, valid or not. */
  total: number;
  /** Users that pass every check, in file order. */
  importable: User[];
  /** Users that do not, each with the first reason that applies to them. */
  rejects: Reject[];
  rejectReasons: ReasonCount[];
  warnings: string[];
  fixes: Fix[];
  quota?: Quota;
  /** True when the instance's settings could not be read. */
  settingsUnavailable: boolean;
};

export type CheckInput = {
  users: User[];
  failures: ValidationFailure[];
  /** Fields the source produced that Clerk has no place for → how many users carry each. */
  unknownFields?: Record<string, number>;
  /** The raw Supabase rows, for the provider checks. Absent for any other source. */
  supabaseRows?: Record<string, unknown>[];
  settings: UserSettingsJSON | null;
  /** Users already in the instance, for the quota. Development instances only. */
  existingUsers?: number | null;
  instanceType: "dev" | "prod";
  target: ClerkTarget;
  secretKey: string;
  schedule: ApiScheduler;
  /**
   * Import users with no legal acceptance into an instance that requires it,
   * sending `skip_legal_checks`. Without it they are rejected.
   */
  skipLegalChecks?: boolean;
  spinner?: SpinnerControls;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// --- Hash shapes -----------------------------------------------------------

/**
 * Why a password digest cannot be what its hasher says it is, for the hashers
 * whose shape is cheap and certain to check.
 *
 * Every other hasher's shape is not checked here: BAPI validates it at
 * create, so a bad digest there fails that user mid-import.
 */
export function hashShapeProblem(password: string, hasher: string): string | undefined {
  switch (hasher) {
    case "bcrypt":
      // clerk_go caps the cost at 15 (pkg/hash/bcrypt.go).
      return /^\$2[aby]\$(0\d|1[0-5])\$[./A-Za-z0-9]{53}$/.test(password)
        ? undefined
        : "password is not a bcrypt hash Clerk accepts ($2a$/$2b$/$2y$, cost up to 15, 60 characters)";
    case "scrypt_firebase": {
      const parts = password.split("$");
      const numeric = (value: string | undefined) => /^\d+$/.test(value ?? "");
      return parts.length === 6 &&
        parts.slice(0, 4).every(Boolean) &&
        numeric(parts[4]) &&
        numeric(parts[5])
        ? undefined
        : "password is not a Firebase scrypt digest (hash$salt$signerKey$saltSeparator$rounds$memCost)";
    }
    case "argon2i":
    case "argon2id":
      return password.startsWith("$argon2") ? undefined : "password is not an argon2 hash";
    case "scrypt_werkzeug":
      return /^scrypt:\d+:\d+:\d+\$[^$]+\$[0-9a-f]+$/i.test(password)
        ? undefined
        : "password is not a Werkzeug scrypt hash (scrypt:N:r:p$salt$hex)";
    default:
      return undefined;
  }
}

// --- Per-user checks -------------------------------------------------------

/**
 * Identifiers Clerk creates a user under. A required one the user does not
 * carry leaves nothing to create them with.
 *
 * An email or phone counts only when it is verified: an unverified one is
 * attached after the user exists, so it cannot satisfy a sign-up requirement.
 */
function missingRequiredIdentifier(
  user: User,
  settings: UserSettingsJSON | null,
): string | undefined {
  if (!settings) return undefined;
  const required = (attribute: AttributeName) => isRequired(settings, attribute);
  const identifiers = splitIdentifiers(user);

  if (required("email_address") && !identifiers.primaryEmail) {
    return identifiers.unverifiedEmails.length > 0
      ? "only has an unverified email, and this instance requires an email"
      : "no email, which this instance requires";
  }
  if (required("phone_number") && !identifiers.primaryPhone) {
    return identifiers.unverifiedPhones.length > 0
      ? "only has an unverified phone number, and this instance requires one"
      : "no phone number, which this instance requires";
  }
  if (required("username") && !hasValue(user.username)) {
    return "no username, which this instance requires";
  }
  return undefined;
}

/** A required first or last name the user lacks: `POST /v1/users` refuses it. */
function missingRequiredName(user: User, settings: UserSettingsJSON | null): string | undefined {
  if (!settings) return undefined;
  if (isRequired(settings, "first_name") && !hasValue(user.firstName)) {
    return "no first name, which this instance requires";
  }
  if (isRequired(settings, "last_name") && !hasValue(user.lastName)) {
    return "no last name, which this instance requires";
  }
  return undefined;
}

/** MFA a user can carry, and the setting `POST /v1/users` refuses it without. */
const MFA_SETTINGS = [
  {
    field: "totpSecret",
    attribute: "authenticator_app",
    reason: "has an authenticator app (TOTP) secret, and this instance has authenticator apps off",
    label: "Enable authenticator apps",
    path: ["auth_multi_factor", "authenticator_app", "enabled"],
  },
  {
    field: "backupCodes",
    attribute: "backup_code",
    reason: "has backup codes, and this instance has backup codes off",
    label: "Enable backup codes",
    path: ["auth_multi_factor", "backup_code", "enabled"],
  },
] as const;

/**
 * MFA the instance has off. Rejected rather than dropped: importing the user
 * without it would quietly take away their second factor.
 */
function mfaProblem(user: User, settings: UserSettingsJSON | null): string | undefined {
  if (!settings) return undefined;
  return MFA_SETTINGS.find(
    ({ field, attribute }) => hasValue(user[field]) && !isEnabled(settings, attribute),
  )?.reason;
}

/** Sign-in strategies that don't count as a way in without a password, per clerk_go. */
const NOT_ALTERNATIVE_SIGN_IN = new Set([
  "password",
  "passkey",
  "ticket",
  "reset_password_email_code",
  "reset_password_phone_code",
]);

/**
 * True when the instance has no sign-in strategy but a password. Clerk then
 * refuses `skip_password_requirement`, so a user without a digest can't be
 * created. Mirrors `create_service.go` and `UserSettings.FirstFactors()`.
 */
export function passwordIsOnlySignIn(settings: UserSettingsJSON): boolean {
  const strategies = firstFactorStrategies(settings);
  for (const [strategy, social] of Object.entries(settings.social ?? {})) {
    if (social?.enabled && social.authenticatable) strategies.add(strategy);
  }
  if (settings.enterprise_sso?.enabled) strategies.add("enterprise_sso");
  return (
    strategies.has("password") &&
    [...strategies].every((strategy) => NOT_ALTERNATIVE_SIGN_IN.has(strategy))
  );
}

/** The first-factor strategies the instance's identifiers offer (`email_code`, `password`, …). */
function firstFactorStrategies(settings: UserSettingsJSON): Set<string> {
  const strategies = new Set<string>();
  for (const attribute of Object.values(settings.attributes ?? {})) {
    if (attribute?.used_for_first_factor) {
      for (const strategy of attribute.first_factors ?? []) strategies.add(strategy);
    }
  }
  return strategies;
}

/** True when the instance needs legal acceptance this user has no record of. */
function lacksLegalAcceptance(user: User, settings: UserSettingsJSON | null): boolean {
  return (
    Boolean(settings?.sign_up?.legal_consent_enabled) &&
    !user.legalAcceptedAt &&
    !user.skipLegalChecks
  );
}

/** What FAPI serves under `username_settings`; `@clerk/shared` types only the lengths. */
type UsernameSettings = {
  min_length?: number;
  max_length?: number;
  allow_extended_special_characters?: boolean;
  allow_numeric_usernames?: boolean;
};

const USERNAME_DEFAULT = /^[a-zA-Z0-9_-]+$/;
const USERNAME_EXTENDED = /^[a-zA-Z0-9!#$'+.^_`~-]+$/;

/**
 * Clerk's username rules, mirrored from `validate.Username` in clerk_go, so a
 * username the instance would refuse is a reject here rather than a failed
 * create. Skipped when usernames are off: the readiness warnings cover that.
 */
function usernameProblem(user: User, settings: UserSettingsJSON | null): string | undefined {
  const username = user.username;
  if (!settings || typeof username !== "string" || !username) return undefined;
  if (!isEnabled(settings, "username")) return undefined;

  const rules = (settings as { username_settings?: UsernameSettings }).username_settings ?? {};
  const length = [...username].length;
  if (rules.min_length !== undefined && rules.max_length !== undefined) {
    if (length < rules.min_length || length > rules.max_length) {
      return `username is not ${rules.min_length}–${rules.max_length} characters, which this instance requires`;
    }
  }
  if (!rules.allow_numeric_usernames && !/[a-zA-Z]/.test(username)) {
    return "username has no letters; turn on numeric usernames to allow it";
  }
  if (rules.allow_extended_special_characters) {
    if (!USERNAME_EXTENDED.test(username)) return "username has characters Clerk does not allow";
    if (/^\+[1-9]\d{1,14}$/.test(username))
      return "username is a phone number, which Clerk does not allow";
    return undefined;
  }
  if (!USERNAME_DEFAULT.test(username)) {
    return USERNAME_EXTENDED.test(username)
      ? "username has special characters this instance does not allow; turn on extended special characters"
      : "username has characters Clerk does not allow";
  }
  return undefined;
}

/**
 * TLDs Clerk refuses for any email: clerk_go's `emailaddress.nonRoutableTLDs`,
 * where placeholder addresses live (`…@phone.local`, `anon-…@anonymous.invalid`),
 * plus the common private ones the public suffix list leaves out.
 *
 * ponytail: Clerk refuses any TLD not on the public suffix list; this names
 * the usual ones instead of taking the list as a dependency.
 */
const NON_ROUTABLE_TLDS = new Set([
  "arpa",
  "local",
  "invalid",
  "example",
  "test",
  "internal",
  "lan",
  "corp",
  "home",
  "localdomain",
  "intranet",
  "private",
]);

/**
 * An address shape Clerk accepts, loosely: one `@`, no spaces, a dotted host,
 * a local part of at most 64 bytes and 254 in all. Non-ASCII is fine, as it
 * is in clerk_go (`josé@x.dev`).
 */
function isEmailShaped(email: string): boolean {
  const at = email.lastIndexOf("@");
  return (
    /^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(email) &&
    Buffer.byteLength(email.slice(0, at)) <= 64 &&
    email.length <= 254
  );
}
const EMAIL_FIELDS = ["email", "emailAddresses", "unverifiedEmailAddresses"] as const;

function isRefusedEmail(email: string): boolean {
  if (!isEmailShaped(email)) return true;
  const host = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  // Clerk's own dev domains sit under `.test` and are accepted.
  if (host.endsWith(".clerk.test")) return false;
  return NON_ROUTABLE_TLDS.has(host.slice(host.lastIndexOf(".") + 1));
}

/** The user without the emails Clerk would refuse, and those emails. */
function dropRefusedEmails(user: User): { user: User; refused: string[] } {
  const refused: string[] = [];
  let kept: User | undefined;
  for (const field of EMAIL_FIELDS) {
    const value = user[field];
    if (value === undefined) continue;
    const list = Array.isArray(value) ? value : [value];
    const bad = list.filter(isRefusedEmail);
    if (bad.length === 0) continue;
    refused.push(...bad);
    kept ??= { ...user };
    const good = list.filter((email) => !isRefusedEmail(email));
    if (good.length > 0) kept[field] = good;
    else delete kept[field];
  }
  return { user: kept ?? user, refused };
}

/**
 * A name Clerk refuses, approximating clerk_go's `NameForAbusePreventionLoose`:
 * a phone number (10–15 digits, or fewer behind a `+`/`00`), a URL with a
 * scheme or path that isn't part of an email, or an HTML tag. Better Auth's phone sign-up stores the
 * number as the name, so this is common, not exotic.
 */
function nameProblem(name: string): string | undefined {
  for (const candidate of name.match(/(?:\+|00)?\d[\d\s().-]{5,}\d/g) ?? []) {
    const digits = candidate.replace(/\D/g, "").length;
    const international = /^(\+|00)/.test(candidate.trim());
    if (digits <= 15 && (digits >= 10 || (international && digits >= 7))) return "a phone number";
  }
  // Clerk accepts an email as a name (NameForAbusePreventionLoose), and a URL
  // that is part of one.
  const hasEmail = /\S+@\S+\.\S+/.test(name);
  if (!hasEmail && /:\/\/|\b[\w-]+(\.[\w-]+)+[/?#]/.test(name)) return "a URL";
  if (/<\/?[a-z!][^>]*>/i.test(name)) return "HTML";
  return undefined;
}

/** The user without a first or last name Clerk would refuse. */
function dropRefusedNames(user: User): { user: User; dropped: boolean } {
  let kept: User | undefined;
  for (const field of ["firstName", "lastName"] as const) {
    const value = user[field];
    if (typeof value === "string" && nameProblem(value)) {
      kept ??= { ...user };
      delete kept[field];
    }
  }
  return { user: kept ?? user, dropped: kept !== undefined };
}

/**
 * A phone number with its punctuation stripped, so `+1 555-555-0100` and
 * `+15555550100` compare equal.
 *
 * ponytail: punctuation only; a national number without its country code
 * still differs from its E.164 form. Full parsing would need a dependency.
 */
const phoneKey = (phone: string) => phone.replace(/[^\d+]/g, "");

const hasAnyIdentifier = (user: User) =>
  [...EMAIL_FIELDS, "phone", "phoneNumbers", "unverifiedPhoneNumbers", "username"].some((field) =>
    hasValue(user[field as keyof User]),
  );

/**
 * First user in the file to claim each email, phone and source ID.
 *
 * Keyed by record, not source ID: two records with one source ID must not
 * share a verdict, or the one kept would be rejected along with its copy.
 *
 * @returns Each duplicate's reason, and the earlier user kept in its place.
 */
function findFileDuplicates(users: User[]): {
  reasons: Map<User, string>;
  keptBy: Map<User, string>;
} {
  const reasons = new Map<User, string>();
  const keptBy = new Map<User, string>();
  const seenIds = new Set<string>();
  const emails = new Map<string, string>();
  const phones = new Map<string, string>();
  const usernames = new Map<string, string>();

  for (const user of users) {
    if (seenIds.has(user.userId)) {
      reasons.set(user, "duplicate source ID in the file");
      continue;
    }
    seenIds.add(user.userId);

    const identifiers = splitIdentifiers(user);
    const ownEmails = [identifiers.primaryEmail, ...identifiers.additionalEmails].filter(
      (value): value is string => Boolean(value),
    );
    const ownPhones = [identifiers.primaryPhone, ...identifiers.additionalPhones].filter(
      (value): value is string => Boolean(value),
    );

    const emailOwner = ownEmails.map((email) => emails.get(email.toLowerCase())).find(Boolean);
    const phoneOwner = ownPhones.map((phone) => phones.get(phoneKey(phone))).find(Boolean);
    // Clerk lowercases usernames, so the second create would fail.
    const username = typeof user.username === "string" ? user.username.toLowerCase() : "";
    const usernameOwner = username ? usernames.get(username) : undefined;
    // The first record in the file wins, whatever either holds: the source's
    // order decides, so the kept ID is named alongside the reject.
    if (emailOwner) {
      reasons.set(user, "email is also used by an earlier user in the file, which is kept");
      keptBy.set(user, emailOwner);
      continue;
    }
    if (phoneOwner) {
      reasons.set(user, "phone number is also used by an earlier user in the file, which is kept");
      keptBy.set(user, phoneOwner);
      continue;
    }
    if (usernameOwner) {
      reasons.set(user, "username is also used by an earlier user in the file, which is kept");
      keptBy.set(user, usernameOwner);
      continue;
    }
    for (const email of ownEmails) emails.set(email.toLowerCase(), user.userId);
    for (const phone of ownPhones) phones.set(phoneKey(phone), user.userId);
    if (username) usernames.set(username, user.userId);
  }
  return { reasons, keptBy };
}

/**
 * Users the instance already holds, found by source ID, primary email,
 * primary phone or username.
 *
 * Only what `POST /v1/users` itself carries is looked up: an extra email that
 * collides is attached after the user exists, fails on its own, and is noted
 * on the user's line rather than failing them.
 */
async function findInstanceDuplicates(
  users: User[],
  input: CheckInput,
): Promise<Map<string, string>> {
  const byExternalId = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const byPhone = new Map<string, string>();
  const byUsername = new Map<string, string>();

  for (const user of users) {
    const identifiers = splitIdentifiers(user);
    byExternalId.set(user.userId, user.userId);
    if (identifiers.primaryEmail) byEmail.set(identifiers.primaryEmail.toLowerCase(), user.userId);
    if (identifiers.primaryPhone) byPhone.set(phoneKey(identifiers.primaryPhone), user.userId);
    if (typeof user.username === "string" && user.username) {
      byUsername.set(user.username.toLowerCase(), user.userId);
    }
  }

  const lookup = async (
    filter: "external_id" | "email_address" | "phone_number" | "username",
    values: Iterable<string>,
  ) =>
    lookupUsers({
      filter,
      values: [...values],
      secretKey: input.secretKey,
      schedule: input.schedule,
      spinner: input.spinner,
      label: "Checking for users already in the instance",
    });

  const found: LookedUpUser[] = (
    await Promise.all([
      lookup("external_id", byExternalId.keys()),
      lookup("email_address", byEmail.keys()),
      lookup("phone_number", byPhone.keys()),
      lookup("username", byUsername.keys()),
    ])
  ).flat();

  const reasons = new Map<string, string>();
  const claim = (sourceId: string | undefined, reason: string) => {
    if (sourceId && !reasons.has(sourceId)) reasons.set(sourceId, reason);
  };

  for (const existing of found) {
    if (existing.external_id) {
      claim(byExternalId.get(existing.external_id), "already in the instance, with this source ID");
    }
    for (const email of existing.email_addresses ?? []) {
      claim(
        byEmail.get((email.email_address ?? "").toLowerCase()),
        "email is already used by a user in the instance",
      );
    }
    for (const phone of existing.phone_numbers ?? []) {
      claim(
        byPhone.get(phoneKey(phone.phone_number ?? "")),
        "phone number is already used by a user in the instance",
      );
    }
    if (existing.username) {
      claim(
        byUsername.get(existing.username.toLowerCase()),
        "username is already taken in the instance",
      );
    }
  }
  return reasons;
}

/** Supabase users whose every provider is off in Clerk: they could never sign in. */
function findDisabledProviderRejects(input: CheckInput): Map<string, string> {
  const reasons = new Map<string, string>();
  if (!input.supabaseRows || !input.settings) return reasons;

  const enabled = enabledSocialProviders(input.settings);
  const disabled = findDisabledProviders(input.supabaseRows, enabled, toClerkStrategy);
  if (disabled.length === 0) return reasons;

  const { excludedIds } = findUsersWithOnlyDisabledProviders(input.supabaseRows, disabled);
  // A disabled provider only strands a user with no other way in: a verified
  // email or phone the instance signs in with by code or link still works.
  const strategies = firstFactorStrategies(input.settings);
  const usersById = new Map(input.users.map((user) => [user.userId, user]));
  const canSignInOtherwise = (id: string) => {
    const user = usersById.get(id);
    if (!user) return false;
    const { primaryEmail, primaryPhone } = splitIdentifiers(user);
    return (
      (Boolean(primaryEmail) && (strategies.has("email_code") || strategies.has("email_link"))) ||
      (Boolean(primaryPhone) && strategies.has("phone_code"))
    );
  };
  // Each reject names only that user's own providers.
  const rowsById = new Map(input.supabaseRows.map((row) => [String(row.id), row]));
  for (const id of excludedIds) {
    if (canSignInOtherwise(id)) continue;
    const own = getUserProviders(rowsById.get(id) ?? {}).filter((p) => disabled.includes(p));
    // Clerk can't turn on a provider it doesn't offer, so say which is which.
    const why = (provider: string) =>
      clerkOffersProvider(provider) ? "not enabled in Clerk" : "not offered by Clerk";
    const kinds = new Set(own.map(why));
    const names =
      kinds.size === 1
        ? `${own.map(providerLabel).join(", ")}, which ${own.length === 1 ? "is" : "are"} ${[...kinds][0]}`
        : own.map((provider) => `${providerLabel(provider)} (${why(provider)})`).join(", ");
    reasons.set(id, `only signs in with ${names}`);
  }
  return reasons;
}

// --- Warnings and fixes ----------------------------------------------------

/** The Supabase rows for just these users, so provider counts describe them alone. */
function rowsFor(input: CheckInput, users: User[]): Record<string, unknown>[] {
  if (!input.supabaseRows) return [];
  const ids = new Set(users.map((user) => user.userId));
  return input.supabaseRows.filter((row) => ids.has(String(row.id)));
}

function buildWarnings(input: CheckInput, importable: User[]): string[] {
  const warnings: string[] = [];

  if (input.settings && importable.length > 0) {
    const report = buildReadinessReport({
      analysis: analyzeFields(importable),
      settings: input.settings,
      providerCounts: countSocialProviders(rowsFor(input, importable)),
    });
    for (const item of report.blocking) {
      if (item.consequence !== "drops") continue;
      if (item.clerkRequired === true) {
        const missing = importable.length - item.userCount;
        warnings.push(
          item.key === "password"
            ? `${plural(missing, "user")} without a password, which this instance requires: they reset it to sign in`
            : `${plural(missing, "user")} without a ${item.label.toLowerCase()}, which this instance requires`,
        );
      } else if (item.key === "password") {
        // Clerk stores a digest even with passwords off, so nothing is lost:
        // it starts working if passwords are turned on.
        warnings.push(
          `${plural(item.userCount, "user")} ${item.userCount === 1 ? "has" : "have"} a password, which this instance does not use: it is stored, and works only once passwords are turned on`,
        );
      } else {
        warnings.push(
          item.section === "social"
            ? `${plural(item.userCount, "user")} signed in with ${item.label}, which ${clerkOffersProvider(item.key) ? "is not enabled in Clerk" : "Clerk doesn't offer"}`
            : `${plural(item.userCount, "user")} ${item.userCount === 1 ? "has" : "have"} a ${item.label.toLowerCase()}, which this instance is not set up to store`,
        );
      }
    }
  }

  const dropped = importable.filter((user) => user.passwordDropped).length;
  if (dropped > 0) {
    warnings.push(
      `${plural(dropped, "password")} Clerk cannot verify will be dropped: those users reset it to sign in`,
    );
  }

  const unknown = Object.entries(input.unknownFields ?? {});
  if (unknown.length > 0) {
    warnings.push(
      `Clerk won't store: ${unknown
        .sort((a, b) => b[1] - a[1])
        .map(([field, count]) => `${field} (${plural(count, "user")})`)
        .join(", ")}`,
    );
  }

  return warnings;
}

/** Shell-quotes a JSON payload for a single-quoted argument. */
function quoteJson(payload: unknown): string {
  return `'${JSON.stringify(payload).replace(/'/g, "'\\''")}'`;
}

/**
 * One `clerk config patch` per flagged setting, built from the same rows the
 * warnings and rejects come from.
 *
 * These are offers, not corrections: an instance that requires an email is
 * configured as its owner intended, and fixing the export may be the answer.
 */
function buildFixes(input: CheckInput, users: User[]): Fix[] {
  if (!input.settings || users.length === 0) return [];

  const report = buildReadinessReport({
    analysis: analyzeFields(users),
    settings: input.settings,
    providerCounts: countSocialProviders(rowsFor(input, users)),
  });

  // An unverified email does not satisfy a required one, so a file of only
  // unverified addresses flags the requirement even when every user has one.
  const unverifiedOnly = users.some((user) => {
    const identifiers = splitIdentifiers(user);
    return !identifiers.primaryEmail && identifiers.unverifiedEmails.length > 0;
  });
  const flagged = report.blocking.slice();
  if (
    unverifiedOnly &&
    isRequired(input.settings, "email_address") &&
    isEnabled(input.settings, "email_address") &&
    !flagged.some((item) => item.key === "email_address")
  ) {
    const email = report.items.find((item) => item.key === "email_address");
    if (email)
      flagged.unshift({ ...email, clerkRequired: true, blocking: true, consequence: "rejects" });
  }

  // Always name the instance: without it, `clerk config patch` acts on the
  // linked profile's development instance, whatever key this import used. A
  // `key_` ID is a stand-in for an instance Clerk didn't name, so there is
  // nothing to pass; point at the Dashboard instead.
  const { appId, instanceId } = input.target;
  const named = instanceId.startsWith("ins_");
  const flags = `${appId ? ` --app ${appId}` : ""} --instance ${instanceId}`;
  const settings = input.settings;
  const mfa = MFA_SETTINGS.filter(
    ({ field, attribute }) =>
      !isEnabled(settings, attribute) && users.some((user) => hasValue(user[field])),
  ).map(({ label, path }) => ({ label, writes: [{ path: [...path], value: true }] }));

  return [...buildSettingChanges(flagged), ...mfa].map((change) =>
    named
      ? {
          label: change.label,
          command: `clerk config patch${flags} --json ${quoteJson(buildChangePayload([change]))}`,
        }
      : { label: change.label, url: DASHBOARD_URL },
  );
}

// --- The whole check -------------------------------------------------------

function countReasons(rejects: Reject[]): ReasonCount[] {
  const counts = new Map<string, number>();
  for (const { reason } of rejects) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => ({ reason, count }));
}

/**
 * Removes the emails, phones or usernames of an instance that has that
 * identifier off.
 *
 * The warnings already say they are dropped, but Clerk does not drop them. It
 * refuses the whole create for a phone (`phone_number is not a valid
 * parameter`), and for a username it stores it anyway, or refuses the create
 * when the username breaks the default rules.
 */
function dropDisabledIdentifiers(user: User, settings: UserSettingsJSON | null): User {
  if (!settings) return user;
  const fields = [
    ...(isEnabled(settings, "email_address")
      ? []
      : (["email", "emailAddresses", "unverifiedEmailAddresses"] as const)),
    ...(isEnabled(settings, "phone_number")
      ? []
      : (["phone", "phoneNumbers", "unverifiedPhoneNumbers"] as const)),
    ...(isEnabled(settings, "username") ? [] : (["username"] as const)),
  ];
  if (!fields.some((field) => field in user)) return user;
  const kept = { ...user };
  for (const field of fields) delete kept[field];
  return kept;
}

function refusedNameWarning(count: number): string[] {
  if (count === 0) return [];
  return [
    `${plural(count, "user")} ${count === 1 ? "has" : "have"} a name Clerk refuses (a phone number, URL or HTML), which is dropped`,
  ];
}

function legalWarning(count: number): string[] {
  if (count === 0) return [];
  return [
    `${plural(count, "user")} ${count === 1 ? "has" : "have"} no legal acceptance on record, and ${count === 1 ? "is" : "are"} created without it (--skip-legal-checks)`,
  ];
}

function placeholderWarning(count: number): string[] {
  if (count === 0) return [];
  return [
    `${plural(count, "user")} ${count === 1 ? "has" : "have"} an email Clerk refuses (malformed, or a domain such as .local or .invalid), which is dropped`,
  ];
}

export async function checkImport(input: CheckInput): Promise<ImportChecks> {
  const rejects: Reject[] = input.failures.map((failure) => ({
    sourceId: failure.userId,
    reason: `invalid: ${failure.error}`,
  }));

  const disabledProviders = findDisabledProviderRejects(input);

  // Users that pass every per-user check. Only these claim identifiers in
  // the file: a rejected record must not cost a later one its email.
  const passed: User[] = [];
  const placeholderEmails = new Set<string>();
  const refusedNames = new Set<string>();
  for (const original of input.users) {
    const named = dropRefusedNames(original);
    if (named.dropped) refusedNames.add(original.userId);
    const { user, refused } = dropRefusedEmails(named.user);
    const reason =
      original.skipReason ??
      (refused.length > 0 && !hasAnyIdentifier(user)
        ? "only has emails Clerk refuses (malformed, or a domain that can't receive mail)"
        : undefined) ??
      missingRequiredIdentifier(user, input.settings) ??
      // Stripping the identifiers the instance has off can leave nothing to
      // sign in with; Clerk would still create the user.
      (!hasAnyIdentifier(dropDisabledIdentifiers(user, input.settings))
        ? "has no identifier this instance accepts (its email, phone or username is turned off)"
        : undefined) ??
      missingRequiredName(user, input.settings) ??
      mfaProblem(user, input.settings) ??
      (!user.password && input.settings && passwordIsOnlySignIn(input.settings)
        ? "no password, and password is this instance's only way to sign in"
        : undefined) ??
      (!input.skipLegalChecks && lacksLegalAcceptance(user, input.settings)
        ? "no legal acceptance on record, which this instance requires (--skip-legal-checks imports them without it)"
        : undefined) ??
      usernameProblem(user, input.settings) ??
      (user.password && user.passwordHasher
        ? hashShapeProblem(user.password, user.passwordHasher)
        : undefined) ??
      disabledProviders.get(user.userId);
    if (reason) {
      rejects.push({ sourceId: user.userId, reason });
    } else {
      passed.push(user);
      if (refused.length > 0) placeholderEmails.add(user.userId);
    }
  }

  const { reasons: fileDuplicates, keptBy } = findFileDuplicates(passed);
  let candidates: User[] = [];
  for (const user of passed) {
    const reason = fileDuplicates.get(user);
    const kept = keptBy.get(user);
    if (reason)
      rejects.push({ sourceId: user.userId, reason, ...(kept ? { keptSourceId: kept } : {}) });
    else candidates.push(user);
  }

  const instanceDuplicates =
    candidates.length > 0
      ? await findInstanceDuplicates(candidates, input)
      : new Map<string, string>();
  const unique: User[] = [];
  for (const user of candidates) {
    const reason = instanceDuplicates.get(user.userId);
    if (reason) rejects.push({ sourceId: user.userId, reason });
    else unique.push(user);
  }
  candidates = unique;

  // The limit is a development-instance default, not a number the API serves,
  // so it is checked against the live count and the importable users alone.
  // An instance Clerk has raised sets CLERK_MIGRATE_DEV_USER_LIMIT.
  let quota: Quota | undefined;
  if (input.instanceType === "dev") {
    const limit = resolveDevUserLimit();
    const headroom = Math.max(0, limit - (input.existingUsers ?? 0));
    const over = Math.max(0, candidates.length - headroom);
    quota = { existing: input.existingUsers ?? null, limit, headroom, over };
    if (over > 0) {
      for (const user of candidates.slice(headroom)) {
        rejects.push({
          sourceId: user.userId,
          reason: `over the development instance's ${limit}-user limit (raised by Clerk? set CLERK_MIGRATE_DEV_USER_LIMIT)`,
        });
      }
      candidates = candidates.slice(0, headroom);
    }
  }

  return {
    total: input.users.length + input.failures.length,
    importable: candidates.map((user) => {
      const kept = dropDisabledIdentifiers(user, input.settings);
      return lacksLegalAcceptance(kept, input.settings) ? { ...kept, skipLegalChecks: true } : kept;
    }),
    rejects,
    rejectReasons: countReasons(rejects),
    warnings: [
      ...buildWarnings(input, candidates),
      ...placeholderWarning(candidates.filter((user) => placeholderEmails.has(user.userId)).length),
      ...refusedNameWarning(candidates.filter((user) => refusedNames.has(user.userId)).length),
      ...legalWarning(
        candidates.filter((user) => lacksLegalAcceptance(user, input.settings)).length,
      ),
      // An unknown count is checked as zero; say so rather than imply it fit.
      ...(quota && quota.existing === null
        ? [
            `Could not read how many users this development instance holds, so the ${quota.limit}-user limit was checked as if it were empty`,
          ]
        : []),
    ],
    fixes: buildFixes(input, input.users),
    ...(quota ? { quota } : {}),
    settingsUnavailable: input.settings === null,
  };
}

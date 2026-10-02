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
import { enabledSocialProviders, providerLabel, toClerkStrategy } from "./clerk-config.ts";
import { resolveDevUserLimit } from "./instance.ts";
import { buildChangePayload, buildSettingChanges } from "./modify-settings.ts";
import { buildReadinessReport } from "./readiness.ts";
import type { ApiScheduler } from "./scheduler.ts";
import {
  countSocialProviders,
  findDisabledProviders,
  findUsersWithOnlyDisabledProviders,
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
export type Fix = { label: string; command: string };

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
  /** Clerk IDs the run being continued created: finding them in the instance is expected. */
  continuedClerkIds?: Set<string>;
  spinner?: SpinnerControls;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// --- Hash shapes -----------------------------------------------------------

/**
 * Why a password digest cannot be what its hasher says it is, for the hashers
 * whose shape is cheap and certain to check.
 *
 * Every other hasher is "can't verify": its shape is not checked, and a bad
 * digest there still fails only at sign-in.
 */
export function hashShapeProblem(password: string, hasher: string): string | undefined {
  switch (hasher) {
    case "bcrypt":
      return /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(password)
        ? undefined
        : "password is not a bcrypt hash ($2a$/$2b$/$2y$, 60 characters)";
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
 * TLDs Clerk refuses for any email, from clerk_go's
 * `emailaddress.nonRoutableTLDs`. This is where placeholder addresses live
 * (`…@phone.local`, `anon-…@anonymous.invalid`). Clerk also refuses a TLD not
 * on the public suffix list; that would take the list as a dependency.
 */
const NON_ROUTABLE_TLDS = new Set(["arpa", "local", "invalid", "example", "test"]);
const EMAIL_FIELDS = ["email", "emailAddresses", "unverifiedEmailAddresses"] as const;

function isRefusedEmail(email: string): boolean {
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

const hasAnyIdentifier = (user: User) =>
  [...EMAIL_FIELDS, "phone", "phoneNumbers", "unverifiedPhoneNumbers", "username"].some((field) =>
    hasValue(user[field as keyof User]),
  );

/**
 * First user in the file to claim each email, phone and source ID.
 *
 * @returns Each duplicate's reason, and the earlier user kept in its place.
 */
function findFileDuplicates(users: User[]): {
  reasons: Map<string, string>;
  keptBy: Map<string, string>;
} {
  const reasons = new Map<string, string>();
  const keptBy = new Map<string, string>();
  const seenIds = new Set<string>();
  const emails = new Map<string, string>();
  const phones = new Map<string, string>();

  for (const user of users) {
    if (seenIds.has(user.userId)) {
      reasons.set(user.userId, "duplicate source ID in the file");
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
    const phoneOwner = ownPhones.map((phone) => phones.get(phone)).find(Boolean);
    // The first record in the file wins, whatever either holds: the source's
    // order decides, so the kept ID is named alongside the reject.
    if (emailOwner) {
      reasons.set(user.userId, "email is also used by an earlier user in the file, which is kept");
      keptBy.set(user.userId, emailOwner);
      continue;
    }
    if (phoneOwner) {
      reasons.set(
        user.userId,
        "phone number is also used by an earlier user in the file, which is kept",
      );
      keptBy.set(user.userId, phoneOwner);
      continue;
    }
    for (const email of ownEmails) emails.set(email.toLowerCase(), user.userId);
    for (const phone of ownPhones) phones.set(phone, user.userId);
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
    if (identifiers.primaryPhone) byPhone.set(identifiers.primaryPhone, user.userId);
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
    if (input.continuedClerkIds?.has(existing.id)) continue;
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
        byPhone.get(phone.phone_number ?? ""),
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
  const names = disabled.map(providerLabel).join(", ");
  for (const id of excludedIds) {
    reasons.set(
      id,
      `only signs in with ${names}, which ${disabled.length === 1 ? "is" : "are"} not enabled in Clerk`,
    );
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
            ? `${plural(item.userCount, "user")} signed in with ${item.label}, which is not enabled in Clerk`
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

  const flags = input.target.appId
    ? ` --app ${input.target.appId} --instance ${input.target.instanceId}`
    : "";
  return buildSettingChanges(flagged).map((change) => ({
    label: change.label,
    command: `clerk config patch${flags} --json ${quoteJson(buildChangePayload([change]))}`,
  }));
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

function placeholderWarning(count: number): string[] {
  if (count === 0) return [];
  return [
    `${plural(count, "user")} ${count === 1 ? "has" : "have"} an email Clerk refuses (.local, .invalid, .test, .example, .arpa), which is dropped`,
  ];
}

export async function checkImport(input: CheckInput): Promise<ImportChecks> {
  const rejects: Reject[] = input.failures.map((failure) => ({
    sourceId: failure.userId,
    reason: `invalid: ${failure.error}`,
  }));

  const { reasons: fileDuplicates, keptBy } = findFileDuplicates(input.users);
  const disabledProviders = findDisabledProviderRejects(input);

  let candidates: User[] = [];
  const placeholderEmails = new Set<string>();
  for (const original of input.users) {
    const { user, refused } = dropRefusedEmails(original);
    const reason =
      original.skipReason ??
      (refused.length > 0 && !hasAnyIdentifier(user)
        ? `only has an email Clerk refuses (${refused[0]})`
        : undefined) ??
      fileDuplicates.get(user.userId) ??
      missingRequiredIdentifier(user, input.settings) ??
      usernameProblem(user, input.settings) ??
      (user.password && user.passwordHasher
        ? hashShapeProblem(user.password, user.passwordHasher)
        : undefined) ??
      disabledProviders.get(user.userId);
    if (reason) {
      const kept = reason === fileDuplicates.get(user.userId) ? keptBy.get(user.userId) : undefined;
      rejects.push({ sourceId: user.userId, reason, ...(kept ? { keptSourceId: kept } : {}) });
    } else {
      candidates.push(user);
      if (refused.length > 0) placeholderEmails.add(user.userId);
    }
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
    importable: candidates.map((user) => dropDisabledIdentifiers(user, input.settings)),
    rejects,
    rejectReasons: countReasons(rejects),
    warnings: [
      ...buildWarnings(input, candidates),
      ...placeholderWarning(candidates.filter((user) => placeholderEmails.has(user.userId)).length),
    ],
    fixes: buildFixes(input, input.users),
    ...(quota ? { quota } : {}),
    settingsUnavailable: input.settings === null,
  };
}

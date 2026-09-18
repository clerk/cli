/**
 * Counts what an import file actually contains, per field.
 *
 * Ported from the standalone migration-tool's `src/lib/analysis.ts`. Runs on
 * transformed-but-unvalidated users so the report describes the whole file,
 * including the rows that will be skipped.
 */

import type { User } from "../types.ts";

/** Non-identifier fields the readiness report reports coverage for. */
export const ANALYZED_FIELDS = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "password", label: "Password" },
  { key: "totpSecret", label: "TOTP secret" },
] as const;

export type IdentifierCounts = {
  verifiedEmails: number;
  unverifiedEmails: number;
  verifiedPhones: number;
  unverifiedPhones: number;
  username: number;
  /** Users with at least one identifier — the rest cannot be imported at all. */
  hasAnyIdentifier: number;
};

export type FieldAnalysis = {
  identifiers: IdentifierCounts;
  totalUsers: number;
  fieldCounts: Record<string, number>;
};

/** True for anything with real content — `0` and `false` count, `""` and `[]` do not. */
export function hasValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function analyzeFields(users: (User | Record<string, unknown>)[]): FieldAnalysis {
  const identifiers: IdentifierCounts = {
    verifiedEmails: 0,
    unverifiedEmails: 0,
    verifiedPhones: 0,
    unverifiedPhones: 0,
    username: 0,
    hasAnyIdentifier: 0,
  };
  const fieldCounts: Record<string, number> = {};

  for (const entry of users) {
    const user = entry as Record<string, unknown>;

    for (const field of ANALYZED_FIELDS) {
      if (hasValue(user[field.key])) {
        fieldCounts[field.key] = (fieldCounts[field.key] ?? 0) + 1;
      }
    }

    const verifiedEmail = hasValue(user.email) || hasValue(user.emailAddresses);
    const unverifiedEmail = hasValue(user.unverifiedEmailAddresses);
    const verifiedPhone = hasValue(user.phone) || hasValue(user.phoneNumbers);
    const unverifiedPhone = hasValue(user.unverifiedPhoneNumbers);
    const username = hasValue(user.username);

    if (verifiedEmail) identifiers.verifiedEmails++;
    if (unverifiedEmail) identifiers.unverifiedEmails++;
    if (verifiedPhone) identifiers.verifiedPhones++;
    if (unverifiedPhone) identifiers.unverifiedPhones++;
    if (username) identifiers.username++;

    if (verifiedEmail || unverifiedEmail || verifiedPhone || unverifiedPhone || username) {
      identifiers.hasAnyIdentifier++;
    }
  }

  return { identifiers, totalUsers: users.length, fieldCounts };
}

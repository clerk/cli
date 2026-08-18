/**
 * `clerk migrate export clerk` — pull users out of a Clerk instance.
 *
 * Ported from the standalone migration-tool's `src/export/clerk.ts`, rewritten
 * onto `bapiRequest` instead of `@clerk/backend` so it shares the CLI's auth
 * resolution, `--verbose` request tracing and error taxonomy.
 *
 * The output feeds `clerk migrate import --transformer clerk` unedited, which is
 * what makes development → production a two-command operation.
 *
 * **Passwords do not come out of this endpoint.** Clerk never returns password
 * digests, TOTP secrets or backup codes over the API; only the `*_enabled`
 * booleans. The coverage report says how many users *have* a password so the
 * gap is visible before the import, not after.
 */

import { bapiRequest } from "../../../lib/bapi.ts";
import { log } from "../../../lib/log.ts";
import { withGutter, withSpinner, type SpinnerControls } from "../../../lib/spinner.ts";
import { exportLogger, getDateTimeStamp } from "../lib/logger.ts";
import { retryOn429 } from "../lib/retry.ts";
import { resolveClerkSource } from "./clerk-source.ts";
import { reportExport, resolveOutputPath, writeExportOutput } from "./shared.ts";

/** BAPI's maximum page size for `GET /v1/users`. */
const PAGE_SIZE = 500;

export type ExportClerkOptions = {
  output?: string;
  secretKey?: string;
  app?: string;
  instance?: string;
};

type BapiIdentifier = {
  email_address?: string;
  phone_number?: string;
  verification?: { status?: string } | null;
};

type BapiUser = {
  id: string;
  external_id?: string | null;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email_addresses?: BapiIdentifier[];
  phone_numbers?: BapiIdentifier[];
  primary_email_address_id?: string | null;
  primary_phone_number_id?: string | null;
  public_metadata?: Record<string, unknown>;
  private_metadata?: Record<string, unknown>;
  unsafe_metadata?: Record<string, unknown>;
  password_enabled?: boolean;
  totp_enabled?: boolean;
  banned?: boolean;
  create_organization_enabled?: boolean;
  create_organizations_limit?: number | null;
  delete_self_enabled?: boolean;
  created_at?: number;
  legal_accepted_at?: number | null;
};

type IdentifierWithId = BapiIdentifier & { id?: string };

/**
 * Splits identifiers into verified and unverified, primary first.
 *
 * The primary has to lead: `migrate import` puts the first entry on
 * `POST /v1/users` and attaches the rest afterwards, so a reordered list would
 * silently change which address the user signs in with.
 */
function splitIdentifiers(
  entries: IdentifierWithId[] | undefined,
  primaryId: string | null | undefined,
  read: (entry: BapiIdentifier) => string | undefined,
): { primary?: string; verified: string[]; unverified: string[] } {
  const verified: string[] = [];
  const unverified: string[] = [];
  let primary: string | undefined;

  for (const entry of entries ?? []) {
    const value = read(entry);
    if (!value) continue;

    if (entry.id && entry.id === primaryId) {
      primary = value;
      continue;
    }
    if (entry.verification?.status === "verified") verified.push(value);
    else unverified.push(value);
  }

  // No primary flagged: promote the first verified one so the export still has
  // an identifier the import can lead with.
  if (!primary && verified.length > 0) primary = verified.shift();

  return { primary, verified, unverified };
}

/** Maps a BAPI user onto the shape the `clerk` transformer reads. */
export function mapClerkUserToExport(user: BapiUser): Record<string, unknown> {
  const exported: Record<string, unknown> = { id: user.id };

  const emails = splitIdentifiers(
    user.email_addresses,
    user.primary_email_address_id,
    (entry) => entry.email_address,
  );
  if (emails.primary) exported.primary_email_address = emails.primary;
  if (emails.verified.length > 0) exported.verified_email_addresses = emails.verified;
  if (emails.unverified.length > 0) exported.unverified_email_addresses = emails.unverified;

  const phones = splitIdentifiers(
    user.phone_numbers,
    user.primary_phone_number_id,
    (entry) => entry.phone_number,
  );
  if (phones.primary) exported.primary_phone_number = phones.primary;
  if (phones.verified.length > 0) exported.verified_phone_numbers = phones.verified;
  if (phones.unverified.length > 0) exported.unverified_phone_numbers = phones.unverified;

  if (user.username) exported.username = user.username;
  if (user.first_name) exported.first_name = user.first_name;
  if (user.last_name) exported.last_name = user.last_name;

  for (const [source, target] of [
    ["public_metadata", "public_metadata"],
    ["private_metadata", "private_metadata"],
    ["unsafe_metadata", "unsafe_metadata"],
  ] as const) {
    const value = user[source];
    if (value && Object.keys(value).length > 0) exported[target] = value;
  }

  if (user.banned) exported.banned = true;
  if (user.create_organization_enabled !== undefined) {
    exported.create_organization_enabled = user.create_organization_enabled;
  }
  if (user.create_organizations_limit !== null && user.create_organizations_limit !== undefined) {
    exported.create_organizations_limit = user.create_organizations_limit;
  }
  if (user.delete_self_enabled !== undefined) {
    exported.delete_self_enabled = user.delete_self_enabled;
  }

  // BAPI reports timestamps as Unix milliseconds; the schema wants RFC3339.
  if (user.created_at) exported.created_at = new Date(user.created_at).toISOString();
  if (user.legal_accepted_at) {
    exported.legal_accepted_at = new Date(user.legal_accepted_at).toISOString();
  }

  return exported;
}

/** Pages through every user in the instance. */
export async function fetchAllClerkUsers(options: {
  secretKey: string;
  spinner?: SpinnerControls;
}): Promise<BapiUser[]> {
  const all: BapiUser[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await retryOn429(() =>
      bapiRequest({
        method: "GET",
        path: `/v1/users?limit=${PAGE_SIZE}&offset=${offset}`,
        secretKey: options.secretKey,
      }),
    );

    const page = Array.isArray(response.body) ? (response.body as BapiUser[]) : [];
    all.push(...page);
    options.spinner?.update(`Fetching users from Clerk: ${all.length} so far...`);

    // A short page means the end; anything else would loop forever on an
    // instance whose size happens to be a multiple of the page size.
    if (page.length < PAGE_SIZE) break;
  }

  return all;
}

export type ClerkExportResult = {
  users: Record<string, unknown>[];
  coverage: { label: string; count: number }[];
};

/** Maps every user and counts what the export actually contains. */
export function buildClerkExport(users: BapiUser[], dateTime: string): ClerkExportResult {
  const exported: Record<string, unknown>[] = [];
  const counts = { email: 0, username: 0, firstName: 0, lastName: 0, phone: 0, password: 0 };

  for (const user of users) {
    try {
      const mapped = mapClerkUserToExport(user);
      exported.push(mapped);

      if (mapped.primary_email_address) counts.email++;
      if (mapped.username) counts.username++;
      if (mapped.first_name) counts.firstName++;
      if (mapped.last_name) counts.lastName++;
      if (mapped.primary_phone_number) counts.phone++;
      if (user.password_enabled) counts.password++;

      exportLogger({ userId: user.id, status: "success" }, dateTime);
    } catch (error) {
      exportLogger({ userId: user.id, status: "error", error: (error as Error).message }, dateTime);
    }
  }

  return {
    users: exported,
    coverage: [
      { label: "have an email address", count: counts.email },
      { label: "have a phone number", count: counts.phone },
      { label: "have a username", count: counts.username },
      { label: "have a first name", count: counts.firstName },
      { label: "have a last name", count: counts.lastName },
      { label: "have a password (not exportable — see below)", count: counts.password },
    ],
  };
}

export async function exportClerk(options: ExportClerkOptions): Promise<void> {
  // Resolved before the gutter opens, the way `export auth0` resolves its
  // credentials: confirming the source is a question about whether to run at
  // all, not a step of the run.
  const source = await resolveClerkSource({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  const destination = await resolveOutputPath("clerk", options.output);

  await withGutter("Exporting users from Clerk", async ({ setNextSteps }) => {
    const dateTime = getDateTimeStamp();

    log.info(`Exporting from ${source.target ?? "the resolved instance"}.`);

    const users = await withSpinner("Fetching users from Clerk...", (spinner) =>
      fetchAllClerkUsers({ secretKey: source.secretKey, spinner }),
    );

    const { users: exported, coverage } = buildClerkExport(users, dateTime);
    const outputPath = writeExportOutput(exported, destination);

    setNextSteps(
      reportExport({
        platform: "clerk",
        userCount: exported.length,
        outputPath,
        coverage,
        transformerKey: "clerk",
      }),
    );

    if (exported.length > 0) {
      log.warn(
        "Clerk's API never returns password digests, TOTP secrets or backup codes, so they are not in this file. " +
          "Users will need to reset their password in the destination instance.",
      );
    }
  });
}

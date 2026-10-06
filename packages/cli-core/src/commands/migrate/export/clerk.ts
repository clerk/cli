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
import type { UserLine } from "../lib/run-store.ts";
import { retryOn429 } from "../lib/retry.ts";
import { fetchInstanceIdentity, printTarget } from "../lib/target.ts";
import { resolveClerkSource } from "./clerk-source.ts";
import { finishExport, startExportRun } from "./shared.ts";

/** BAPI's maximum page size for `GET /v1/users`. */
const PAGE_SIZE = 500;

export type ExportClerkOptions = {
  output?: string;
  secretKey?: string;
  app?: string;
  instance?: string;
  /** Where runs are kept; overrides `CLERK_MIGRATE_DIR`. */
  runsDir?: string;
  /** Print the result as JSON on stdout; never prompts. */
  json?: boolean;
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

    const isVerified = entry.verification?.status === "verified";
    // An unverified primary stays unverified: the import puts a primary on
    // POST /v1/users, which creates it verified.
    if (entry.id && entry.id === primaryId && isVerified) {
      primary = value;
      continue;
    }
    if (isVerified) verified.push(value);
    else unverified.push(value);
  }

  // No verified primary: promote the first verified one so the export still
  // has an identifier the import can lead with.
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

  // The import sets external_id to the old Clerk ID, so an app's own
  // external_id moves to private metadata rather than being lost.
  if (user.external_id) {
    exported.private_metadata = {
      ...(exported.private_metadata as Record<string, unknown> | undefined),
      clerkExternalId: user.external_id,
    };
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
  const all = new Map<string, BapiUser>();

  // Oldest first, so a sign-up during the export lands at the end instead of
  // shifting every later page by one (BAPI's default is newest first). A
  // deletion can still shift a page; the Map drops the repeat that causes.
  // ponytail: offset paging; /v1/users has no cursor to page by instead.
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await retryOn429(async () =>
      bapiRequest({
        method: "GET",
        path: `/v1/users?limit=${PAGE_SIZE}&offset=${offset}&order_by=%2Bcreated_at`,
        secretKey: options.secretKey,
      }),
    );

    const page = Array.isArray(response.body) ? (response.body as BapiUser[]) : [];
    for (const user of page) all.set(user.id, user);
    options.spinner?.update(`Fetching users from Clerk: ${all.size} so far...`);

    // A short page means the end; anything else would loop forever on an
    // instance whose size happens to be a multiple of the page size.
    if (page.length < PAGE_SIZE) break;
  }

  return [...all.values()];
}

export type ClerkExportResult = {
  users: Record<string, unknown>[];
  coverage: { label: string; count: number }[];
};

/** Maps every user and counts what the export actually contains. */
export function buildClerkExport(
  users: BapiUser[],
  record: (line: UserLine) => void = () => {},
): ClerkExportResult {
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

      record({ sourceId: user.id, status: "exported" });
    } catch (error) {
      record({ sourceId: user.id, status: "skipped", error: (error as Error).message });
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
  // Resolved before the gutter opens, the way `export supabase` resolves its
  // connection string: confirming the source is a question about whether to run at
  // all, not a step of the run.
  const source = await resolveClerkSource({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  await withGutter("Exporting users from Clerk", async () => {
    const identity = await fetchInstanceIdentity(source.secretKey);
    const target = {
      platform: "clerk",
      env: identity.env,
      instanceId: identity.instanceId,
      ...(source.target ? { keySource: source.target } : {}),
    };
    if (!options.json) printTarget(target);

    const users = await withSpinner("Fetching users from Clerk...", async (spinner) =>
      fetchAllClerkUsers({ secretKey: source.secretKey, spinner }),
    );

    const run = await startExportRun(options, target);
    const { users: exported, coverage } = buildClerkExport(users, run.append);
    finishExport({ run, options, users: exported, coverage });

    if (exported.length > 0) {
      log.warn(
        "Clerk's API never returns password digests, TOTP secrets or backup codes, so they are not in this file. " +
          "Users will need to reset their password in the destination instance.",
      );
    }
  });
}

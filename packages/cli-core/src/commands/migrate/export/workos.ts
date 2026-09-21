/**
 * `clerk migrate export workos` — pull users out of a WorkOS tenant.
 *
 * Structurally the Auth0 case, and written against the same shape: two REST
 * calls through `loggedFetch` rather than the `@workos-inc/node` SDK, so
 * everything the command sends shows up under `--verbose`. See the header of
 * `auth0.ts` and `.claude/rules/debug-logging.md`.
 *
 * **WorkOS is API-only, and no credential leaves it.** There is no
 * bring-your-own-database option — apps mirror WorkOS users into their own
 * store through webhooks, but that mirror is a derived copy holding no secrets,
 * which is why this has no `--db-url` sibling. Password hashes are accepted on
 * import and never returned; TOTP secrets come back on enrol only, never on
 * list or get. So a WorkOS migration moves identities, and every password user
 * signs in again by reset. The run says so rather than leaving it to be
 * discovered when nobody can sign in.
 */

import { CliError, ERROR_CODE, throwUsageError } from "../../../lib/errors.ts";
import { loggedFetch } from "../../../lib/fetch.ts";
import { dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { confirm, password as passwordPrompt } from "../../../lib/prompts.ts";
import { withGutter, withSpinner, type SpinnerControls } from "../../../lib/spinner.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { findMigrateEnvValue } from "../lib/env-file.ts";
import { exportLogger, startLogging } from "../lib/logger.ts";
import { isAssumeYes } from "../lib/assume-yes.ts";
import { withInputRetry } from "../lib/input-retry.ts";
import { createApiScheduler } from "../lib/scheduler.ts";
import {
  reportExport,
  resolveOutputPath,
  writeExportOutput,
  type ExportSection,
} from "./shared.ts";

const API_BASE = "https://api.workos.com/user_management";

/** WorkOS caps `limit` at 100. */
const PAGE_SIZE = 100;

/**
 * Pacing for the per-user identity fan-out.
 *
 * WorkOS allows 6,000 requests a minute, so this is nowhere near the ceiling —
 * it is here so a 50,000-user tenant does not open 50,000 sockets at once.
 */
const IDENTITY_CONCURRENCY = 10;
const IDENTITY_RATE_PER_SECOND = 20;

/**
 * How often a non-interactive run says where it has got to.
 *
 * `withSpinner` hands a no-op `update` to anything that is not a TTY, so an
 * agent exporting 50,000 users with `--with-identities` would otherwise see
 * nothing at all for the ten minutes the fan-out takes. These two print
 * through `log.info` instead, which a non-TTY does get.
 */
const IDENTITY_PROGRESS_EVERY = 500;
const USER_PROGRESS_EVERY_PAGES = 10;

const NO_PROVIDER_LABEL = "no OAuth provider";
const NOT_READABLE_LABEL = "not readable";

const DOCS_URL = "https://clerk.com/docs/guides/development/migrating/overview";

export type ExportWorkOsOptions = {
  apiKey?: string;
  /** Unset means "ask"; `--no-with-identities` sets it to false. */
  withIdentities?: boolean;
  output?: string;
};

export type WorkOsUser = Record<string, unknown> & { id?: string };

export type WorkOsIdentity = { idp_id?: string; type?: string; provider?: string };

/**
 * Resolves the API key: flag, then environment, then a prompt.
 *
 * One value rather than Auth0's three, so there is no "name everything that is
 * missing" pass — there is only ever the one thing.
 *
 * @throws CliError in agent mode when nothing supplied it.
 */
export async function resolveWorkOsApiKey(
  options: ExportWorkOsOptions,
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const resolved =
    options.apiKey ?? (await findMigrateEnvValue(["WORKOS_API_KEY"], cwd, env))?.value;

  if (resolved) return resolved.trim();

  if (isAgent() || !isHuman()) {
    throwUsageError(
      "`clerk migrate export workos` needs a WorkOS API key and cannot prompt here.\n" +
        "Missing: --api-key (or WORKOS_API_KEY).",
      DOCS_URL,
      undefined,
      [
        {
          command: "clerk migrate export workos --api-key sk_…",
          description: "Export with an explicit API key",
        },
      ],
    );
  }

  log.info(
    "WorkOS needs a secret API key, the one starting `sk_`. Find it in the WorkOS dashboard under API Keys.",
  );

  return promptWorkOsApiKey();
}

export async function promptWorkOsApiKey(): Promise<string> {
  const key = await passwordPrompt({
    message: "WorkOS secret API key (sk_…)",
    validate: (value) => (value?.trim() ? undefined : "An API key is required"),
  });
  return key.trim();
}

/**
 * Whatever WorkOS put in an error body, in one string.
 *
 * Read as text and parsed from that, rather than `response.json()` with a text
 * fallback: the failed parse disturbs the stream, so the fallback could never
 * actually run. A non-JSON body — a proxy's HTML error page — is the case worth
 * surfacing verbatim.
 */
async function describeFailure(response: Response): Promise<string> {
  const raw = (await response.text().catch(() => "")).trim();
  if (!raw) return "no detail returned";

  try {
    const body = JSON.parse(raw) as {
      message?: string;
      error_description?: string;
      error?: string;
    };
    return body.message ?? body.error_description ?? body.error ?? raw;
  } catch {
    return raw;
  }
}

export type WorkOsPage = { users: WorkOsUser[]; after?: string };

/**
 * Fetches one page of users.
 *
 * Cursor pagination, so unlike Auth0's offset endpoint there is no record
 * ceiling to warn about — `after` runs to the end of the tenant.
 */
export async function fetchWorkOsPage(apiKey: string, after?: string): Promise<WorkOsPage> {
  const url = new URL(`${API_BASE}/users`);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("order", "asc");
  if (after) url.searchParams.set("after", after);

  const response = await loggedFetch(url, {
    tag: "workos",
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });

  if (!response.ok) {
    throw new CliError(
      `WorkOS returned ${response.status} listing users: ${await describeFailure(response)}\n` +
        "Check that the key is a secret key (`sk_…`) for the right environment, and that it has not been revoked.",
      { code: ERROR_CODE.USAGE_ERROR, docsUrl: DOCS_URL },
    );
  }

  const body = (await response.json()) as {
    data?: WorkOsUser[];
    list_metadata?: { after?: string | null };
  };

  return { users: body.data ?? [], after: body.list_metadata?.after ?? undefined };
}

/**
 * Pages through the tenant's users.
 *
 * @param firstPage - A page already fetched, so the request that proved the API
 *   key is not sent twice.
 */
export async function fetchAllWorkOsUsers(options: {
  apiKey: string;
  firstPage?: WorkOsPage;
  spinner?: SpinnerControls;
}): Promise<WorkOsUser[]> {
  let page = options.firstPage ?? (await fetchWorkOsPage(options.apiKey));
  const all = [...page.users];
  options.spinner?.update(`Fetching users from WorkOS: ${all.length} so far...`);

  // Counted in pages rather than users: a short page would knock a
  // `users % N` check off its multiple and silence every later one.
  for (let pages = 1; page.after; pages++) {
    page = await fetchWorkOsPage(options.apiKey, page.after);
    all.push(...page.users);
    options.spinner?.update(`Fetching users from WorkOS: ${all.length} so far...`);
    if (!isHuman() && pages % USER_PROGRESS_EVERY_PAGES === 0) {
      log.info(`Fetched ${all.length} users from WorkOS so far...`);
    }
  }

  return all;
}

/**
 * Whether to spend one request per user on OAuth providers.
 *
 * Off unless asked for, both times. WorkOS has no bulk identities endpoint, so
 * this is the difference between ten requests and one per user — and nothing it
 * returns can be imported, because `POST /v1/users` has no external-accounts
 * field. It is a line in the coverage report, and a record kept in the file.
 *
 * Agent mode gets the flag's answer and no question: there is nobody to ask.
 * `-y` answers the question the way a `yes` would, so `--no-with-identities`
 * is the way to say no without being asked.
 */
export async function resolveWithIdentities(
  options: ExportWorkOsOptions,
  userCount: number,
): Promise<boolean> {
  if (options.withIdentities !== undefined) return options.withIdentities;
  if (userCount === 0) return false;
  if (isAssumeYes()) return true;
  if (isAgent() || !isHuman()) return false;

  return confirm({
    message: `Also fetch each user's OAuth providers? That is ${userCount} extra request${userCount === 1 ? "" : "s"}, and the result is report-only — Clerk's import cannot take external accounts.`,
    default: false,
  });
}

/** Fetches one user's OAuth identities. */
export async function fetchWorkOsIdentities(
  apiKey: string,
  userId: string,
): Promise<WorkOsIdentity[]> {
  const response = await loggedFetch(new URL(`${API_BASE}/users/${userId}/identities`), {
    tag: "workos",
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });

  if (!response.ok) {
    throw new CliError(
      `WorkOS returned ${response.status} listing identities for ${userId}: ${await describeFailure(response)}`,
      { code: ERROR_CODE.USAGE_ERROR, docsUrl: DOCS_URL },
    );
  }

  // The endpoint returns a bare array; the envelope is handled too so a future
  // move to WorkOS's usual `{ data }` shape does not read as "no providers".
  const body = (await response.json()) as WorkOsIdentity[] | { data?: WorkOsIdentity[] };
  return Array.isArray(body) ? body : (body.data ?? []);
}

/**
 * Fetches identities for every user.
 *
 * A user missing from the returned map is one whose lookup **failed**, which is
 * not the same as one with no providers — so failures are counted and returned
 * separately rather than flattened into an empty list.
 */
export async function fetchAllWorkOsIdentities(options: {
  apiKey: string;
  users: WorkOsUser[];
  spinner?: SpinnerControls;
}): Promise<{ identities: Map<string, WorkOsIdentity[]>; failed: number }> {
  const schedule = createApiScheduler(IDENTITY_CONCURRENCY, IDENTITY_RATE_PER_SECOND);
  const total = options.users.length;
  const identities = new Map<string, WorkOsIdentity[]>();
  let failed = 0;
  let done = 0;

  await Promise.all(
    options.users.map(async (user) =>
      schedule(async () => {
        const userId = String(user.id ?? "");
        try {
          if (userId) identities.set(userId, await fetchWorkOsIdentities(options.apiKey, userId));
        } catch {
          failed++;
        }
        done++;
        options.spinner?.update(`Fetching OAuth providers: ${done}/${total}...`);
        if (!isHuman() && done % IDENTITY_PROGRESS_EVERY === 0) {
          log.info(`Fetched OAuth providers for ${done}/${total} users...`);
        }
      }),
    ),
  );

  return { identities, failed };
}

/**
 * The OAuth provider breakdown, as its own block under the coverage table.
 *
 * Kept out of coverage on purpose: a coverage row means "N of the M users have
 * this field", and these rows do not. One user can hold two providers, so the
 * counts can sum past the user count, and "not readable" is not a property of
 * the user at all. Two kinds of row under one heading would make both harder
 * to read.
 */
export function buildIdentityReport(
  users: WorkOsUser[],
  identities: Map<string, WorkOsIdentity[]>,
  failed: number,
): ExportSection {
  const byProvider = new Map<string, number>();
  let none = 0;

  for (const user of users) {
    const found = identities.get(String(user.id ?? ""));
    // Absent means the lookup failed; `failed` already counts it.
    if (!found) continue;
    if (found.length === 0) {
      none++;
      continue;
    }
    for (const identity of found) {
      const provider = identity.provider ?? "unknown";
      byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1);
    }
  }

  // Busiest provider first; alphabetical within a tie so two runs of the same
  // tenant print the same order.
  const entries = [...byProvider].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const labels = [
    ...entries.map(([provider]) => provider),
    NO_PROVIDER_LABEL,
    ...(failed > 0 ? [NOT_READABLE_LABEL] : []),
  ];
  const width = Math.max(...labels.map((label) => label.length));
  const row = (label: string, count: number) =>
    `  ${label.padEnd(width)}  ${dim(`${count} user${count === 1 ? "" : "s"}`)}`;

  const rows = [
    ...entries.map(([provider, count]) => row(provider, count)),
    row(NO_PROVIDER_LABEL, none),
  ];

  if (failed > 0) {
    rows.push(row(NOT_READABLE_LABEL, failed));
    rows.push(
      dim("  Those users have no `identities` field in the export, rather than an empty one."),
    );
  }

  return { title: "OAuth providers", rows };
}

/**
 * Keeps the fields the `workos` transformer maps from, plus `identities` when
 * they were fetched.
 *
 * A copy rather than the raw record: WorkOS also returns `locale`,
 * `profile_picture_url`, `last_sign_in_at` and `updated_at`, none of which
 * `POST /v1/users` accepts. `identities` has no target field either and is
 * dropped at validation, so it rides along purely as a record for whoever runs
 * the migration.
 */
export function mapWorkOsUserToExport(
  user: WorkOsUser,
  identities?: WorkOsIdentity[],
): Record<string, unknown> {
  const exported: Record<string, unknown> = {};

  for (const field of ["id", "email", "first_name", "last_name", "created_at"] as const) {
    if (user[field]) exported[field] = user[field];
  }

  // Meaningful when false: dropping it would import an address WorkOS never
  // confirmed as a verified one.
  if (user.email_verified !== undefined) exported.email_verified = user.email_verified;

  const metadata = user.metadata;
  if (metadata && typeof metadata === "object" && Object.keys(metadata).length > 0) {
    exported.metadata = metadata;
  }

  if (identities && identities.length > 0) exported.identities = identities;

  return exported;
}

export type WorkOsExportResult = {
  users: Record<string, unknown>[];
  coverage: { label: string; count: number }[];
};

export function buildWorkOsExport(
  users: WorkOsUser[],
  dateTime: string,
  identities?: Map<string, WorkOsIdentity[]>,
): WorkOsExportResult {
  const exported: Record<string, unknown>[] = [];
  const counts = { email: 0, firstName: 0, lastName: 0, metadata: 0 };

  for (const user of users) {
    const userId = String(user.id ?? "");
    try {
      const mapped = mapWorkOsUserToExport(user, identities?.get(userId));
      exported.push(mapped);

      if (mapped.email) counts.email++;
      if (mapped.first_name) counts.firstName++;
      if (mapped.last_name) counts.lastName++;
      if (mapped.metadata) counts.metadata++;

      exportLogger({ userId, status: "success" }, dateTime);
    } catch (error) {
      exportLogger({ userId, status: "error", error: (error as Error).message }, dateTime);
    }
  }

  return {
    users: exported,
    coverage: [
      { label: "have an email address", count: counts.email },
      { label: "have a first name", count: counts.firstName },
      { label: "have a last name", count: counts.lastName },
      { label: "have metadata", count: counts.metadata },
      // Always present, always zero. WorkOS returns no digest for anyone, and
      // seeing that before the import is the whole reason the row is here.
      { label: "have a password (WorkOS returns none)", count: 0 },
    ],
  };
}

export async function exportWorkOs(options: ExportWorkOsOptions): Promise<void> {
  const resolved = await resolveWorkOsApiKey(options);

  const destination = await resolveOutputPath("workos", options.output);

  await withGutter("Exporting users from WorkOS", async ({ setNextSteps }) => {
    const dateTime = await startLogging();

    // Only WorkOS can say whether the key is live, for the right environment,
    // and not revoked — so a rejected key is asked for again here. The page it
    // fetches is kept and reused, so proving the key costs no extra request.
    const { value: firstPage, input: apiKey } = await withInputRetry(
      resolved,
      async () => promptWorkOsApiKey(),
      async (candidate) =>
        withSpinner("Authenticating with WorkOS...", async () => fetchWorkOsPage(candidate)),
    );

    const users = await withSpinner("Fetching users from WorkOS...", async (spinner) =>
      fetchAllWorkOsUsers({ apiKey, firstPage, spinner }),
    );

    const providers = (await resolveWithIdentities(options, users.length))
      ? await withSpinner("Fetching OAuth providers...", async (spinner) =>
          fetchAllWorkOsIdentities({ apiKey, users, spinner }),
        )
      : undefined;

    const { users: exported, coverage } = buildWorkOsExport(users, dateTime, providers?.identities);
    const outputPath = writeExportOutput(exported, destination);

    setNextSteps(
      reportExport({
        platform: "workos",
        userCount: exported.length,
        outputPath,
        coverage,
        sections: providers
          ? [buildIdentityReport(users, providers.identities, providers.failed)]
          : [],
        transformerKey: "workos",
      }),
    );

    if (exported.length > 0) {
      log.warn(
        "WorkOS does not return password hashes or TOTP secrets, and there is no export that does. Imported users who signed in with a password must reset it on their first Clerk sign-in, and anyone using an authenticator app has to re-enrol. Users on SSO or social sign-in are unaffected.",
      );
      log.info(dim(`See ${DOCS_URL}`));
    }
  });
}

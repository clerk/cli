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

import { ApiError, CliError, EXIT_CODE, throwUsageError } from "../../../lib/errors.ts";
import { loggedFetch } from "../../../lib/fetch.ts";
import { dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { isCancelled } from "../../../lib/signals.ts";
import { confirm, password as passwordPrompt } from "../../../lib/prompts.ts";
import { withGutter, withSpinner, type SpinnerControls } from "../../../lib/spinner.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import type { UserLine } from "../lib/run-store.ts";
import { printTarget } from "../lib/target.ts";
import { isAssumeYes } from "../lib/assume-yes.ts";
import { throwApiFailure, withInputRetry } from "../lib/input-retry.ts";
import { RateLimitExceededError, retryOn429 } from "../lib/retry.ts";
import { createApiScheduler } from "../lib/scheduler.ts";
import { finishExport, startExportRun, type ExportSection } from "./shared.ts";

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
 * nothing at all while the fan-out runs, at 20 users a second. These two print
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
  /** Where runs are kept; overrides `CLERK_MIGRATE_DIR`. */
  runsDir?: string;
  /** Print the result as JSON on stdout; never prompts. */
  json?: boolean;
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
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  // Trimmed before the fallback: a blank flag must not hide a set variable.
  const resolved = options.apiKey?.trim() || env.WORKOS_API_KEY?.trim();

  if (resolved) return resolved;

  if (options.json || isAssumeYes() || isAgent() || !isHuman()) {
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
 * One WorkOS read, backing off on a 429 as the Auth0 and Clerk exports do.
 * WorkOS allows 1,000 reads per 10 seconds per environment, shared with the
 * live app, so a busy tenant can push an export over it.
 */
async function getFromWorkOs(apiKey: string, url: URL): Promise<Response> {
  return retryOn429(async () => {
    const response = await loggedFetch(url, {
      tag: "workos",
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    // Thrown as an ApiError so `retryOn429` backs off, honouring Retry-After.
    if (response.status === 429) {
      throw new ApiError(429, await response.text(), response.headers);
    }
    return response;
  });
}

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

  let response: Response;
  try {
    response = await getFromWorkOs(apiKey, url);
  } catch (error) {
    if (!(error instanceof RateLimitExceededError)) throw error;
    throw new CliError(
      `WorkOS kept rate-limiting the API (429, ${error.attempts} retries). Nothing was exported. ` +
        "Try again shortly; the limit is shared with the live app.",
      { docsUrl: DOCS_URL },
    );
  }

  if (!response.ok) {
    throwApiFailure(
      response.status,
      `WorkOS returned ${response.status} listing users: ${await describeFailure(response)}\n` +
        "Check that the key is a secret key (`sk_…`) for the right environment, and that it has not been revoked.",
      DOCS_URL,
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
    const cursor = page.after;
    page = await fetchWorkOsPage(options.apiKey, cursor);
    // A cursor that does not move would refetch the same page forever.
    if (page.after === cursor) {
      throw new CliError(`WorkOS returned the same pagination cursor twice (${cursor}).`);
    }
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
 * Agent mode, `--json` and `-y` get the flag's answer and no question: there
 * is nobody to ask, and `-y` takes the prompt's default, no, rather than
 * committing to one request per user unasked.
 */
export async function resolveWithIdentities(
  options: ExportWorkOsOptions,
  userCount: number,
): Promise<boolean> {
  if (options.withIdentities !== undefined) return options.withIdentities;
  if (userCount === 0) return false;
  if (isAssumeYes()) return false;
  if (options.json || isAgent() || !isHuman()) return false;

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
  // Retries run out as a RateLimitExceededError, which the fan-out counts as
  // one user not readable, like any other failed lookup.
  const response = await getFromWorkOs(
    apiKey,
    new URL(`${API_BASE}/users/${encodeURIComponent(userId)}/identities`),
  );

  if (!response.ok) {
    throwApiFailure(
      response.status,
      `WorkOS returned ${response.status} listing identities for ${userId}: ${await describeFailure(response)}`,
      DOCS_URL,
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
 *
 * A Ctrl-C, or a key WorkOS stops accepting partway, is not a failed lookup:
 * every later one would fail the same way. It stops the fan-out and is thrown.
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
  let fatal: unknown;
  // Aborted with `fatal`: each user still queued then runs at once and
  // returns, rather than spending a paced slot first. A Ctrl-C reaches here as
  // a cancelled request, and sets `fatal` like a rejected key.
  const halt = new AbortController();

  await Promise.all(
    options.users.map(async (user) =>
      schedule(
        async () => {
          if (fatal) return;
          const userId = String(user.id ?? "");
          try {
            // Counted, so the report's totals still add up.
            if (!userId) failed++;
            else identities.set(userId, await fetchWorkOsIdentities(options.apiKey, userId));
          } catch (error) {
            const stops =
              isCancelled(error) ||
              (error instanceof CliError && error.exitCode === EXIT_CODE.USAGE);
            if (stops) {
              fatal ??= error;
              halt.abort();
              return;
            }
            failed++;
          }
          done++;
          options.spinner?.update(`Fetching OAuth providers: ${done}/${total}...`);
          if (!isHuman() && done % IDENTITY_PROGRESS_EVERY === 0) {
            log.info(`Fetched OAuth providers for ${done}/${total} users...`);
          }
        },
        { stop: halt.signal },
      ),
    ),
  );

  if (fatal) throw fatal;
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

  const items = [
    ...entries.map(([label, count]) => ({ label, count })),
    { label: NO_PROVIDER_LABEL, count: none },
    ...(failed > 0 ? [{ label: NOT_READABLE_LABEL, count: failed }] : []),
  ];

  return {
    title: "OAuth providers",
    items,
    ...(failed > 0
      ? { note: "Those users have no `identities` field in the export, rather than an empty one." }
      : {}),
  };
}

/**
 * Keeps the fields the `workos` transformer maps from, plus `identities` when
 * they were fetched.
 *
 * A copy rather than the raw record: WorkOS also returns `locale`,
 * `profile_picture_url`, `last_sign_in_at` and `updated_at`, which the import
 * does not carry. `identities` has no target field either and is
 * dropped at validation, so it rides along purely as a record for whoever runs
 * the migration.
 */
export function mapWorkOsUserToExport(
  user: WorkOsUser,
  identities?: WorkOsIdentity[],
): Record<string, unknown> {
  const exported: Record<string, unknown> = {};

  for (const field of [
    "id",
    "email",
    "first_name",
    "last_name",
    "external_id",
    "created_at",
  ] as const) {
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
  record: (line: UserLine) => void = () => {},
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

      record({ sourceId: userId, status: "exported" });
    } catch (error) {
      record({ sourceId: userId, status: "skipped", error: (error as Error).message });
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

  await withGutter("Exporting users from WorkOS", async () => {
    if (!options.json) printTarget({ platform: "workos" });
    // Only WorkOS can say whether the key is live, for the right environment,
    // and not revoked — so a rejected key is asked for again here. The page it
    // fetches is kept and reused, so proving the key costs no extra request.
    const { value: firstPage, input: apiKey } = await withInputRetry(
      resolved,
      async () => promptWorkOsApiKey(),
      async (candidate) =>
        withSpinner("Authenticating with WorkOS...", async () => fetchWorkOsPage(candidate)),
      options,
    );

    const users = await withSpinner("Fetching users from WorkOS...", async (spinner) =>
      fetchAllWorkOsUsers({ apiKey, firstPage, spinner }),
    );

    const providers = (await resolveWithIdentities(options, users.length))
      ? await withSpinner("Fetching OAuth providers...", async (spinner) =>
          fetchAllWorkOsIdentities({ apiKey, users, spinner }),
        )
      : undefined;

    const run = await startExportRun(options, { platform: "workos" });
    const { users: exported, coverage } = buildWorkOsExport(
      users,
      run.append,
      providers?.identities,
    );
    finishExport({
      run,
      options,
      users: exported,
      coverage,
      sections: providers
        ? [buildIdentityReport(users, providers.identities, providers.failed)]
        : [],
    });

    if (exported.length > 0) {
      log.warn(
        "WorkOS's API does not return password hashes or TOTP secrets. Imported users who signed in with a password must reset it on their first Clerk sign-in, and anyone using an authenticator app has to re-enrol. SSO and social users don't need a reset, but set up those providers in Clerk first: social accounts link by verified email, and SSO needs an enterprise connection.",
      );
      log.info(dim(`See ${DOCS_URL}`));
    }
  });
}

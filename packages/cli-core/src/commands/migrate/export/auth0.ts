/**
 * `clerk migrate export auth0` — pull users out of an Auth0 tenant.
 *
 * Ported from the standalone migration-tool's `src/export/auth0.ts`, but
 * **without the `auth0` SDK**. The SDK is 28 MB across five transitive
 * dependencies — including a bundled legacy copy of itself — to make two REST
 * calls, and it does its own HTTP, so nothing it sends would appear under
 * `--verbose`. `.claude/rules/debug-logging.md` requires library HTTP to go
 * through `loggedFetch`; two direct calls satisfy that and ship nothing extra
 * inside the compiled binary.
 *
 * **Passwords do not come out of the Management API.** Auth0 exports password
 * hashes only via a support request. The coverage report says so rather than
 * leaving it to be discovered when nobody can sign in.
 */

import { throwUsageError } from "../../../lib/errors.ts";
import { loggedFetch } from "../../../lib/fetch.ts";
import { dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { password as passwordPrompt, text } from "../../../lib/prompts.ts";
import { withGutter, withSpinner, type SpinnerControls } from "../../../lib/spinner.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { isAssumeYes } from "../lib/assume-yes.ts";
import type { UserLine } from "../lib/run-store.ts";
import { printTarget } from "../lib/target.ts";
import { isCredentialStatus, throwApiFailure, withInputRetry } from "../lib/input-retry.ts";
import { finishExport, startExportRun } from "./shared.ts";

const PAGE_SIZE = 100;

/**
 * Auth0 caps offset pagination on `GET /api/v2/users` at 1000 records.
 * Past that the tenant needs a bulk export job, so the run says so instead of
 * quietly returning the first thousand as though that were everyone.
 */
const AUTH0_PAGINATION_CEILING = 1000;

const DOCS_URL = "https://clerk.com/docs/guides/development/migrating/auth0";

export type ExportAuth0Options = {
  domain?: string;
  clientId?: string;
  clientSecret?: string;
  output?: string;
  /** Where runs are kept; overrides `CLERK_MIGRATE_DIR`. */
  runsDir?: string;
  /** Print the result as JSON on stdout; never prompts. */
  json?: boolean;
};

export type Auth0Credentials = {
  domain: string;
  clientId: string;
  clientSecret: string;
};

/** Strips a scheme and trailing slash, so both forms of `--domain` work. */
export function normalizeAuth0Domain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

/**
 * True for a bare host name. The client secret goes to this host, so userinfo
 * (`tenant.auth0.com@elsewhere`), a port, a path or a query is refused rather
 * than letting URL parsing pick a different host.
 */
export function isAuth0Domain(domain: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(normalizeAuth0Domain(domain));
}

const DOMAIN_HINT = "Pass just the tenant's host name, e.g. my-tenant.us.auth0.com.";

/**
 * Resolves the tenant credentials: flags, then environment, then a prompt.
 *
 * @throws CliError in agent mode when anything is still missing, naming each
 *   absent flag rather than failing on the first one.
 */
export async function resolveAuth0Credentials(
  options: ExportAuth0Options,
  env: Record<string, string | undefined> = process.env,
): Promise<Auth0Credentials> {
  const resolved = {
    domain: options.domain ?? env.AUTH0_DOMAIN,
    clientId: options.clientId ?? env.AUTH0_CLIENT_ID,
    clientSecret: options.clientSecret ?? env.AUTH0_CLIENT_SECRET,
  };

  if (resolved.domain && !isAuth0Domain(resolved.domain)) {
    throwUsageError(`"${resolved.domain}" is not an Auth0 domain. ${DOMAIN_HINT}`, DOCS_URL);
  }

  const missing = (
    [
      ["domain", "--domain", "AUTH0_DOMAIN"],
      ["clientId", "--client-id", "AUTH0_CLIENT_ID"],
      ["clientSecret", "--client-secret", "AUTH0_CLIENT_SECRET"],
    ] as const
  ).filter(([key]) => !resolved[key]);

  if (missing.length === 0) {
    return {
      domain: normalizeAuth0Domain(resolved.domain as string),
      clientId: resolved.clientId as string,
      clientSecret: resolved.clientSecret as string,
    };
  }

  // `-y` is "do not prompt", as for the other exports.
  if (options.json || isAssumeYes() || isAgent() || !isHuman()) {
    throwUsageError(
      `\`clerk migrate export auth0\` needs credentials for a machine-to-machine application and cannot prompt here.\n` +
        `Missing: ${missing.map(([, flag, variable]) => `${flag} (or ${variable})`).join(", ")}.`,
      DOCS_URL,
      undefined,
      [
        {
          command:
            "clerk migrate export auth0 --domain my-tenant.us.auth0.com --client-id … --client-secret …",
          description: "Export with explicit credentials",
        },
      ],
    );
  }

  log.info(
    "Auth0 needs a machine-to-machine application with the `read:users` scope. Create one under Applications → APIs → Auth0 Management API → Machine to Machine Applications.",
  );

  return promptAuth0Credentials(resolved);
}

/**
 * Asks for whichever of the three are still missing.
 *
 * Called with nothing known after Auth0 has rejected a set: its error names no
 * field, and the operator may have mistyped any of them — so all three are
 * asked again rather than guessing which one to keep.
 */
export async function promptAuth0Credentials(
  known: Partial<Auth0Credentials> = {},
): Promise<Auth0Credentials> {
  const domain =
    known.domain ??
    (await text({
      message: "Auth0 tenant domain (e.g. my-tenant.us.auth0.com)",
      validate: (value) => {
        if (!value?.trim()) return "A domain is required";
        return isAuth0Domain(value) ? undefined : DOMAIN_HINT;
      },
    }));
  const clientId =
    known.clientId ??
    (await text({
      message: "Machine-to-machine client ID",
      validate: (value) => (value?.trim() ? undefined : "A client ID is required"),
    }));
  const clientSecret =
    known.clientSecret ??
    (await passwordPrompt({
      message: "Machine-to-machine client secret",
      validate: (value) => (value?.trim() ? undefined : "A client secret is required"),
    }));

  return {
    domain: normalizeAuth0Domain(domain),
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
  };
}

/** Exchanges the client credentials for a Management API access token. */
export async function fetchAuth0Token(credentials: Auth0Credentials): Promise<string> {
  const url = new URL(`https://${credentials.domain}/oauth/token`);

  const response = await loggedFetch(url, {
    tag: "auth0",
    method: "POST",
    // A followed 307/308 would resend the client secret to wherever it points.
    // Unfollowed, a 3xx is just a failed response.
    redirect: "manual",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      audience: `https://${credentials.domain}/api/v2/`,
    }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
    error?: string;
  };

  const detail = body.error_description ?? body.error ?? "no access token returned";
  if (!response.ok && !isCredentialStatus(response.status)) {
    throwApiFailure(
      response.status,
      `Auth0 did not issue a token (${response.status}): ${detail}. Try again shortly.`,
      DOCS_URL,
    );
  }
  if (!body.access_token) {
    throwUsageError(
      `Auth0 rejected the credentials (${response.status}): ${detail}\n` +
        "Check the domain, client ID and secret, and that the application is authorized for the Management API with the `read:users` scope.",
      DOCS_URL,
    );
  }

  return body.access_token;
}

type Auth0User = Record<string, unknown> & { user_id?: string };

/** Fetches one page of users from the Management API. */
async function fetchAuth0Page(
  credentials: Auth0Credentials,
  token: string,
  page: number,
): Promise<{ users: Auth0User[]; total: number }> {
  const url = new URL(`https://${credentials.domain}/api/v2/users`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(PAGE_SIZE));
  url.searchParams.set("include_totals", "true");

  const response = await loggedFetch(url, {
    tag: "auth0",
    method: "GET",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text();
    throwApiFailure(
      response.status,
      `Auth0 returned ${response.status} listing users: ${body}`,
      DOCS_URL,
    );
  }

  const body = (await response.json()) as { users?: Auth0User[]; total?: number };
  return { users: body.users ?? [], total: body.total ?? 0 };
}

/**
 * Pages through the tenant's users.
 *
 * Stops at Auth0's 1000-record ceiling with a warning naming the bulk export
 * job — silently truncating would read as "that is everyone".
 */
export async function fetchAllAuth0Users(options: {
  credentials: Auth0Credentials;
  token: string;
  spinner?: SpinnerControls;
}): Promise<{ users: Auth0User[]; truncated: boolean }> {
  const all: Auth0User[] = [];

  for (let page = 0; ; page++) {
    const { users, total } = await fetchAuth0Page(options.credentials, options.token, page);
    all.push(...users);
    options.spinner?.update(`Fetching users from Auth0: ${all.length} so far...`);

    // An empty page ends it whatever `total` says, so an overstated total
    // cannot page forever.
    if (users.length === 0) break;

    if (all.length >= AUTH0_PAGINATION_CEILING) {
      // Auth0 reports a larger tenant's total as 1000 too, so reaching the
      // ceiling never proves the export is complete.
      log.warn(
        `Auth0 only pages through the first ${AUTH0_PAGINATION_CEILING} users on this endpoint` +
          (total > AUTH0_PAGINATION_CEILING
            ? `, and this tenant reports ${total}`
            : `, and counts no higher, so there may be more`) +
          ". Exported what is reachable; use Auth0's bulk user export job for the rest.",
      );
      return { users: all, truncated: true };
    }

    // Auth0 can send a short page before the last one, so `total` decides
    // when it is known; a short page ends it only when Auth0 sent no total.
    if (total > 0 ? all.length >= total : users.length < PAGE_SIZE) break;
  }

  return { users: all, truncated: false };
}

/**
 * Keeps the fields the `auth0` transformer maps from.
 *
 * Deliberately a copy rather than the raw record: an Auth0 user carries
 * identities, session counts and tenant internals that would bloat the export
 * and mean nothing to the import.
 */
export function mapAuth0UserToExport(user: Auth0User): Record<string, unknown> {
  const exported: Record<string, unknown> = {};

  for (const field of [
    "user_id",
    "email",
    "username",
    "name",
    "given_name",
    "family_name",
    "phone_number",
    "created_at",
  ] as const) {
    if (user[field]) exported[field] = user[field];
  }

  // Verification flags are meaningful when false, so they are copied on
  // presence rather than on truthiness.
  for (const field of ["email_verified", "phone_verified"] as const) {
    if (user[field] !== undefined) exported[field] = user[field];
  }

  // Only when true: every unblocked user would otherwise carry a `false`.
  if (user.blocked === true) exported.blocked = true;

  for (const field of ["user_metadata", "app_metadata"] as const) {
    const value = user[field];
    if (value && typeof value === "object" && Object.keys(value).length > 0) {
      exported[field] = value;
    }
  }

  return exported;
}

export type Auth0ExportResult = {
  users: Record<string, unknown>[];
  coverage: { label: string; count: number }[];
};

export function buildAuth0Export(
  users: Auth0User[],
  record: (line: UserLine) => void = () => {},
): Auth0ExportResult {
  const exported: Record<string, unknown>[] = [];
  const counts = { email: 0, username: 0, firstName: 0, lastName: 0, phone: 0 };

  for (const user of users) {
    const userId = String(user.user_id ?? "");
    try {
      const mapped = mapAuth0UserToExport(user);
      exported.push(mapped);

      if (mapped.email) counts.email++;
      if (mapped.username) counts.username++;
      if (mapped.given_name) counts.firstName++;
      if (mapped.family_name) counts.lastName++;
      if (mapped.phone_number) counts.phone++;

      record({ sourceId: userId, status: "exported" });
    } catch (error) {
      record({ sourceId: userId, status: "skipped", error: (error as Error).message });
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
    ],
  };
}

export async function exportAuth0(options: ExportAuth0Options): Promise<void> {
  const resolved = await resolveAuth0Credentials(options);

  await withGutter("Exporting users from Auth0", async () => {
    if (!options.json) printTarget({ platform: "auth0" });
    // Only Auth0 can say whether these three go together, and whether the
    // application carries the `read:users` scope, so a rejected set is asked
    // for again here.
    const { value: token, input: credentials } = await withInputRetry(
      resolved,
      async () => promptAuth0Credentials(),
      async (candidate) => {
        log.info(`Exporting from ${candidate.domain}.`);
        return withSpinner("Authenticating with Auth0...", async () => fetchAuth0Token(candidate));
      },
      options,
    );

    const { users, truncated } = await withSpinner(
      "Fetching users from Auth0...",
      async (spinner) => fetchAllAuth0Users({ credentials, token, spinner }),
    );

    const run = await startExportRun(options, { platform: "auth0" });
    const { users: exported, coverage } = buildAuth0Export(users, run.append);
    finishExport({ run, options, users: exported, coverage, truncated });

    if (exported.length > 0) {
      log.warn(
        "Auth0's Management API does not return password hashes. Request a password hash export from Auth0 support and add a `passwordHash` field to each user before importing, or migrate without passwords.",
      );
      log.info(dim(`See ${DOCS_URL}`));
    }
  });
}

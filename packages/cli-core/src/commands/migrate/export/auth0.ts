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

import { CliError, ERROR_CODE, throwUsageError } from "../../../lib/errors.ts";
import { loggedFetch } from "../../../lib/fetch.ts";
import { dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { password as passwordPrompt, text } from "../../../lib/prompts.ts";
import { withGutter, withSpinner, type SpinnerControls } from "../../../lib/spinner.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { findMigrateEnvValue } from "../lib/env-file.ts";
import { exportLogger, getDateTimeStamp } from "../lib/logger.ts";
import { defaultOutputPath, reportExport, writeExportOutput } from "./shared.ts";

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
 * Resolves the tenant credentials: flags, then environment, then a prompt.
 *
 * @throws CliError in agent mode when anything is still missing, naming each
 *   absent flag rather than failing on the first one.
 */
export async function resolveAuth0Credentials(
  options: ExportAuth0Options,
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<Auth0Credentials> {
  const fromEnv = async (name: string): Promise<string | undefined> =>
    (await findMigrateEnvValue([name], cwd, env))?.value;

  const resolved = {
    domain: options.domain ?? (await fromEnv("AUTH0_DOMAIN")),
    clientId: options.clientId ?? (await fromEnv("AUTH0_CLIENT_ID")),
    clientSecret: options.clientSecret ?? (await fromEnv("AUTH0_CLIENT_SECRET")),
  };

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

  if (isAgent() || !isHuman()) {
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

  const domain =
    resolved.domain ??
    (await text({
      message: "Auth0 tenant domain (e.g. my-tenant.us.auth0.com)",
      validate: (value) => (value?.trim() ? undefined : "A domain is required"),
    }));
  const clientId =
    resolved.clientId ??
    (await text({
      message: "Machine-to-machine client ID",
      validate: (value) => (value?.trim() ? undefined : "A client ID is required"),
    }));
  const clientSecret =
    resolved.clientSecret ??
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

  if (!response.ok || !body.access_token) {
    throw new CliError(
      `Auth0 rejected the credentials (${response.status}): ${body.error_description ?? body.error ?? "no access token returned"}\n` +
        "Check the domain, client ID and secret, and that the application is authorized for the Management API with the `read:users` scope.",
      { code: ERROR_CODE.USAGE_ERROR, docsUrl: DOCS_URL },
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
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new CliError(`Auth0 returned ${response.status} listing users: ${body}`, {
      code: ERROR_CODE.USAGE_ERROR,
      docsUrl: DOCS_URL,
    });
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
}): Promise<Auth0User[]> {
  const all: Auth0User[] = [];

  for (let page = 0; ; page++) {
    const { users, total } = await fetchAuth0Page(options.credentials, options.token, page);
    all.push(...users);
    options.spinner?.update(`Fetching users from Auth0: ${all.length} so far...`);

    if (users.length < PAGE_SIZE) break;

    if (all.length >= AUTH0_PAGINATION_CEILING) {
      log.warn(
        `Auth0 only pages through the first ${AUTH0_PAGINATION_CEILING} users on this endpoint` +
          (total > AUTH0_PAGINATION_CEILING ? `, and this tenant reports ${total}` : "") +
          ". Exported what is reachable; use Auth0's bulk user export job for the rest.",
      );
      break;
    }
  }

  return all;
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

export function buildAuth0Export(users: Auth0User[], dateTime: string): Auth0ExportResult {
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

      exportLogger({ userId, status: "success" }, dateTime);
    } catch (error) {
      exportLogger({ userId, status: "error", error: (error as Error).message }, dateTime);
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
  const credentials = await resolveAuth0Credentials(options);

  await withGutter("Exporting users from Auth0", async ({ setNextSteps }) => {
    const dateTime = getDateTimeStamp();
    log.info(`Exporting from ${credentials.domain}.`);

    const token = await withSpinner("Authenticating with Auth0...", () =>
      fetchAuth0Token(credentials),
    );

    const users = await withSpinner("Fetching users from Auth0...", (spinner) =>
      fetchAllAuth0Users({ credentials, token, spinner }),
    );

    const { users: exported, coverage } = buildAuth0Export(users, dateTime);
    const outputPath = writeExportOutput(exported, options.output ?? defaultOutputPath("auth0"));

    setNextSteps(
      reportExport({
        platform: "auth0",
        userCount: exported.length,
        outputPath,
        coverage,
        transformerKey: "auth0",
      }),
    );

    if (exported.length > 0) {
      log.warn(
        "Auth0's Management API does not return password hashes. Request a password hash export from Auth0 support and add a `passwordHash` field to each user before importing, or migrate without passwords.",
      );
      log.info(dim(`See ${DOCS_URL}`));
    }
  });
}

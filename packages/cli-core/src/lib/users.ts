import { bapiRequest } from "./bapi.ts";
import { ERROR_CODE, throwUsageError } from "./errors.ts";

const USERS_INVALID_JSON_MESSAGE = "User payload must be a JSON object.";
const REDACTED = "[REDACTED]";
const DIRECT_REDACT_KEYS = new Set(["password", "code"]);
const OBJECT_REDACT_KEYS = new Set(["private_metadata", "unsafe_metadata"]);

/** A user record as returned by the BAPI `GET /users` search endpoint. */
export type BapiUserSummary = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  email_addresses?: Array<{ email_address?: string }> | null;
};

/**
 * How to filter the user search: an exact email match or a fuzzy query. An
 * empty `query` returns the unfiltered first page (used by the interactive
 * picker before the user types).
 */
export type UserSearchFilter = { email: string } | { query: string };

/**
 * Search users via BAPI `GET /users`, returning at most `limit` records.
 *
 * Centralizes the `/users` request so commands don't each hand-roll the query
 * string, limit handling, and `Array.isArray` body guard.
 */
export async function searchUsers(
  secretKey: string,
  filter: UserSearchFilter,
  limit: number,
): Promise<BapiUserSummary[]> {
  const params = new URLSearchParams();
  if ("email" in filter) {
    params.set("email_address", filter.email);
  } else if (filter.query) {
    params.set("query", filter.query);
  }
  params.set("limit", String(limit));

  const response = await bapiRequest({
    method: "GET",
    path: `/users?${params}`,
    secretKey,
  });

  return Array.isArray(response.body) ? (response.body as BapiUserSummary[]) : [];
}

export function buildCreateUserPayload(options: {
  email?: string;
  phone?: string;
  username?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
}) {
  const payload: Record<string, unknown> = {};

  if (options.email) payload.email_address = [options.email];
  if (options.phone) payload.phone_number = [options.phone];
  if (options.username) payload.username = options.username;
  if (options.password) payload.password = options.password;
  if (options.firstName) payload.first_name = options.firstName;
  if (options.lastName) payload.last_name = options.lastName;
  if (options.externalId) payload.external_id = options.externalId;

  return payload;
}

export function buildUpdateUserPayload(options: {
  firstName?: string;
  lastName?: string;
  username?: string;
  password?: string;
  externalId?: string;
}) {
  const payload: Record<string, unknown> = {};

  if (options.firstName) payload.first_name = options.firstName;
  if (options.lastName) payload.last_name = options.lastName;
  if (options.username) payload.username = options.username;
  if (options.password) payload.password = options.password;
  if (options.externalId) payload.external_id = options.externalId;

  return payload;
}

export function mergeUsersPayload(
  basePayload: Record<string, unknown>,
  flagPayload: Record<string, unknown>,
): Record<string, unknown> {
  return { ...basePayload, ...flagPayload };
}

export function parseUsersPayload(rawInput: string): Record<string, unknown> {
  let payload: unknown;

  try {
    payload = JSON.parse(rawInput);
  } catch {
    throwUsageError(
      "Invalid JSON input. Please provide valid JSON.",
      undefined,
      ERROR_CODE.INVALID_JSON,
    );
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throwUsageError(USERS_INVALID_JSON_MESSAGE, undefined, ERROR_CODE.INVALID_JSON);
  }

  return payload as Record<string, unknown>;
}

export async function readUsersPayloadInput(options: {
  file?: string;
  data?: string;
}): Promise<string> {
  if (options.data) {
    return options.data;
  }

  if (options.file) {
    const file = Bun.file(options.file);
    if (!(await file.exists())) {
      throwUsageError(`File not found: ${options.file}`, undefined, ERROR_CODE.FILE_NOT_FOUND);
    }
    return file.text();
  }

  throwUsageError(
    "No input provided. Use -d <json> or --file <path>.\n" +
      '  Example: clerk users create -d \'{"email_address":["alice@example.com"]}\'\n' +
      "  Example: clerk users create --file user.json",
  );
}

export function redactUsersDisplayPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactUsersDisplayPayload(entry));
  }

  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (DIRECT_REDACT_KEYS.has(key)) {
        redacted[key] = REDACTED;
        continue;
      }

      if (OBJECT_REDACT_KEYS.has(key) && entry != null) {
        redacted[key] = REDACTED;
        continue;
      }

      redacted[key] = redactUsersDisplayPayload(entry);
    }

    return redacted;
  }

  return value;
}

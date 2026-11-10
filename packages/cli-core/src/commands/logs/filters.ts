/**
 * The `clerk logs list` event filters. Each flag maps to a `GET /v1/logs`
 * query parameter; the checks here mirror the Backend API's own
 * (`parseReadAllParams` in clerk_go) so a bad combination fails as a usage
 * error before a key is resolved or a request is made. Whether a payload path
 * exists for the type is left to the API, which lists the allowed paths.
 */

import { throwUsageError } from "../../lib/errors.ts";

/** The API's per-request cap on payload paths, for `payload_filter` and `payload_fields` each. */
export const MAX_PAYLOAD_PATHS = 10;
/** Dot segments in a payload path; deeper fields aren't addressable. */
export const MAX_PAYLOAD_PATH_DEPTH = 4;
export const MAX_PAYLOAD_FILTER_VALUE_LENGTH = 256;

export const FILTER_MATCH_CHOICES = ["all", "any"] as const;
export type FilterMatch = (typeof FILTER_MATCH_CHOICES)[number];

export type LogFilterOptions = {
  type?: string;
  user?: string;
  identifier?: string;
  actor?: string;
  subject?: string;
  session?: string;
  client?: string;
  ip?: string;
  trace?: string;
  impersonator?: string;
  payloadFilter?: string[];
  fields?: string;
  match?: FilterMatch;
  endUserOnly?: boolean;
};

/** Query parameters, in order, ready to append to every request. */
export type LogFilters = Array<[name: string, value: string]>;

/** Plain string filters: flag, option key, API parameter. */
const STRING_FILTERS = [
  ["--type", "type", "type"],
  ["--user", "user", "user_id"],
  ["--identifier", "identifier", "identifier"],
  ["--actor", "actor", "actor"],
  ["--subject", "subject", "subject"],
  ["--session", "session", "session_id"],
  ["--client", "client", "client_id"],
  ["--ip", "ip", "ip_address"],
  ["--trace", "trace", "trace_id"],
  ["--impersonator", "impersonator", "impersonator_user_id"],
] as const;

/** The API's `user_` ID check: the prefix and at least one character after it. */
function isUserId(value: string): boolean {
  return value.startsWith("user_") && value.length > "user_".length;
}

type PayloadFilter = { path: string; value: string };

function parsePayloadFilter(raw: string): PayloadFilter {
  const separator = raw.indexOf("=");
  if (separator === -1) {
    throwUsageError(
      `Invalid --payload-filter "${raw}". Use <path>=<value>, like --payload-filter user_id=user_123.`,
    );
  }
  const path = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1);
  if (!path) {
    throwUsageError(`Invalid --payload-filter "${raw}". The path before "=" can't be empty.`);
  }
  checkPayloadPath(path, "--payload-filter");
  if (!value) {
    throwUsageError(`Invalid --payload-filter "${raw}". The value after "=" can't be empty.`);
  }
  if (value.length > MAX_PAYLOAD_FILTER_VALUE_LENGTH) {
    throwUsageError(
      `Invalid --payload-filter for "${path}". The value can be at most ${MAX_PAYLOAD_FILTER_VALUE_LENGTH} characters.`,
    );
  }
  return { path, value };
}

function checkPayloadPath(path: string, flag: string): void {
  if (path.split(".").some((segment) => segment === "")) {
    throwUsageError(`Invalid ${flag} path "${path}". Use dot-separated field names, like a.b.`);
  }
  if (path.split(".").length > MAX_PAYLOAD_PATH_DEPTH) {
    throwUsageError(
      `Invalid ${flag} path "${path}". Paths can be at most ${MAX_PAYLOAD_PATH_DEPTH} levels deep.`,
    );
  }
}

function checkPayloadPathCount(paths: string[], flag: string): void {
  if (paths.length > MAX_PAYLOAD_PATHS) {
    throwUsageError(`Pass at most ${MAX_PAYLOAD_PATHS} ${flag} paths.`);
  }
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) throwUsageError(`${flag} names "${path}" more than once.`);
    seen.add(path);
  }
}

/**
 * The query parameters for the filter flags, or a usage error for a
 * combination the API would reject.
 */
export function resolveFilters(options: LogFilterOptions): LogFilters {
  const { type, user, identifier, actor, subject } = options;

  if (user) {
    for (const [flag, value] of [
      ["--identifier", identifier],
      ["--actor", actor],
      ["--subject", subject],
    ] as const) {
      if (value) throwUsageError(`--user can't be combined with ${flag}.`);
    }
    if (!isUserId(user)) {
      throwUsageError(`Invalid --user value "${user}". Use a user ID, like user_123.`);
    }
  }
  if (identifier) {
    if (actor) throwUsageError("--identifier can't be combined with --actor.");
    if (subject) throwUsageError("--identifier can't be combined with --subject.");
    if (isUserId(identifier)) {
      throwUsageError(
        `--identifier takes an email address, phone number, username or web3 wallet. Use --user ${identifier} to filter by user ID.`,
      );
    }
  }
  if (type?.includes("*") && type.indexOf("*") !== type.length - 1) {
    throwUsageError(
      `Invalid --type value "${type}". A wildcard (*) is only allowed at the end, like sign_in.*.`,
    );
  }

  const payloadFilters = (options.payloadFilter ?? []).map(parsePayloadFilter);
  const fields = options.fields
    ?.split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  if (options.fields !== undefined && !fields?.length) {
    throwUsageError("--fields needs at least one payload path, like --fields user_id,username.");
  }

  if (payloadFilters.length > 0 && !type) {
    throwUsageError("--payload-filter requires --type.");
  }
  if (fields && !type) {
    throwUsageError("--fields requires --type.");
  }
  checkPayloadPathCount(
    payloadFilters.map((filter) => filter.path),
    "--payload-filter",
  );
  if (fields) {
    for (const field of fields) checkPayloadPath(field, "--fields");
    checkPayloadPathCount(fields, "--fields");
  }
  if (fields && options.match === "any") {
    throwUsageError(
      "--fields can't be combined with --match any, since logs of other types could match.",
    );
  }

  const params: LogFilters = [];
  for (const [, key, param] of STRING_FILTERS) {
    const value = options[key];
    if (value) params.push([param, value]);
  }
  for (const filter of payloadFilters) {
    params.push([`payload_filter[${filter.path}]`, filter.value]);
  }
  if (fields) params.push(["payload_fields", fields.join(",")]);
  // "all" is the API's default, so it is left out.
  if (options.match === "any") params.push(["filter_match", "any"]);
  if (options.endUserOnly) params.push(["end_user_facing_only", "true"]);
  return params;
}

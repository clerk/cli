/**
 * The `clerk logs list` event filters. Each flag maps to a `GET /v1/logs`
 * query parameter. The checks here cover syntax and flag combinations, which
 * mirror the Backend API's own (`parseReadAllParams` in clerk_go) so the error
 * names the CLI flag instead of the API parameter and fails before a key is
 * resolved or a request is made. The API's numeric limits on payload paths
 * (count, depth, value length) and whether a path exists for the type are left
 * to the API, whose 422 lists the allowed paths and tracks its own limits.
 */

import { throwUsageError } from "../../lib/errors.ts";
import type { Example } from "../../lib/help.ts";

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

/**
 * `--payload-filter` and `--fields` name payload paths, which only mean
 * something for an event type, so their "requires --type" errors point at
 * where the types and their paths are listed.
 */
const FIND_TYPE_HINT =
  "Run `clerk logs schema` to list the event types, and `clerk logs schema <event-type>` for the payload paths of one.";

const TYPE_EXAMPLES: Example[] = [
  { command: "clerk logs schema --json", description: "Every event type with its payload fields" },
  {
    command: "clerk logs list --type user.created --payload-filter user_id=user_123",
    description: "Logs of one type whose payload field matches",
  },
];

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
  return { path, value };
}

function checkPayloadPath(path: string, flag: string): void {
  if (path.split(".").some((segment) => segment === "")) {
    throwUsageError(`Invalid ${flag} path "${path}". Use dot-separated field names, like a.b.`);
  }
}

/**
 * The query parameters for the filter flags, or a usage error for a
 * combination the API would reject.
 */
export function resolveFilters(options: LogFilterOptions): LogFilters {
  // The API treats an empty value like a missing one, so `--user "$UNSET"`
  // would list every log instead of failing.
  for (const [flag, key] of STRING_FILTERS) {
    if (options[key]?.trim() === "") {
      throwUsageError(`${flag} needs a value; it was given an empty string.`);
    }
  }

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
    throwUsageError(
      `--payload-filter requires --type. ${FIND_TYPE_HINT}`,
      undefined,
      undefined,
      TYPE_EXAMPLES,
    );
  }
  if (fields && !type) {
    throwUsageError(
      `--fields requires --type. ${FIND_TYPE_HINT}`,
      undefined,
      undefined,
      TYPE_EXAMPLES,
    );
  }
  if (fields) {
    for (const field of fields) checkPayloadPath(field, "--fields");
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

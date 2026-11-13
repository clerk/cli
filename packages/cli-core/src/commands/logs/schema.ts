/**
 * `clerk logs schema [event-type]` — the log event types an instance can read,
 * or the payload fields of one.
 *
 * Without an argument it lists every event type, from `GET /v1/logs/types`,
 * each with its payload schema: the one call an agent needs to learn what it
 * can query. With one it reads `GET /v1/logs/schemas?type=...`. The type can
 * be concrete (`sign_in.completed`), a trailing-`*` wildcard (`sign_in.*`) or
 * a bare family name (`sign_in`); it is passed through as-is. For a wildcard
 * or family the API returns only the fields every matched type shares, plus
 * `matched_event_types`.
 */

import { resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { bold, cyan, dim } from "../../lib/color.ts";
import { BapiError, CliError, throwUsageError, withApiContext } from "../../lib/errors.ts";
import type { ApiResponse } from "../../lib/fetch.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import { closeStatusForError } from "../../lib/signals.ts";
import { intro, outro, pausedOutro, withSpinner } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { logsRequest, pad, type LogsTargetingOptions } from "./shared.ts";

export type LogsSchemaOptions = LogsTargetingOptions;

export type LogSchemaField = {
  path: string;
  type: "string" | "boolean" | "integer" | "number";
  optional: boolean;
  enum?: string[];
};

/** A `log_schema` object, as `GET /v1/logs/schemas` returns it. */
export type LogSchema = {
  object: "log_schema";
  event_type: string;
  description?: string;
  severity?: string;
  docs_group?: string;
  matched_event_types?: string[];
  fields: LogSchemaField[];
};

/** `GET /v1/logs/types`: every event type the instance can read, sorted by `event_type`. */
export type LogSchemaList = {
  object: "list";
  data: LogSchema[];
  total_count: number;
};

const UNEXPECTED_RESPONSE = "The Logs API returned an unexpected response.";

const EVENT_TYPE_EXAMPLES = [
  { command: "clerk logs schema", description: "Every event type" },
  { command: "clerk logs schema sign_in.completed", description: "Fields of one event type" },
  { command: "clerk logs schema 'sign_in.*'", description: "Fields every sign_in event shares" },
];

function assertEventType(eventType: string): string {
  const value = eventType.trim();
  // An empty argument is most likely an unset shell variable, not a request
  // for the whole catalog, so it isn't read as "no argument".
  if (!value) {
    throwUsageError(
      "The event type is empty. Pass one, like `clerk logs schema sign_in.completed`, or run `clerk logs schema` alone to list every event type.",
      undefined,
      undefined,
      EVENT_TYPE_EXAMPLES,
    );
  }
  // The API rejects a bare `*`: it would match every event type.
  if (value === "*") {
    throwUsageError(
      "A wildcard needs an event type prefix, like `sign_in.*`. Run `clerk logs schema` alone to list every event type.",
      undefined,
      undefined,
      EVENT_TYPE_EXAMPLES,
    );
  }
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRenderableField(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const field = value as Record<string, unknown>;
  return (
    typeof field.path === "string" &&
    typeof field.type === "string" &&
    typeof field.optional === "boolean" &&
    (field.enum == null || isStringArray(field.enum))
  );
}

/**
 * Whether a response has the shape the human output reads. The JSON output
 * passes the body through untouched, so only the table needs this.
 */
function isRenderableSchema(body: Record<string, unknown>): boolean {
  const { event_type, description, severity, matched_event_types, fields } = body;
  return (
    typeof event_type === "string" &&
    (description == null || typeof description === "string") &&
    (severity == null || typeof severity === "string") &&
    (matched_event_types == null || isStringArray(matched_event_types)) &&
    (fields == null || (Array.isArray(fields) && fields.every(isRenderableField)))
  );
}

/** Quotes a value for the shell when it holds characters a shell would expand. */
function shellArg(value: string): string {
  return /^[\w.\-=]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function printHuman(schema: LogSchema): void {
  log.blank();
  log.info(bold(schema.event_type));
  if (schema.description) log.info(schema.description);
  if (schema.severity) log.info(dim(`Severity: ${schema.severity}`));
  if (schema.matched_event_types?.length) {
    log.info(dim(`Matches: ${schema.matched_event_types.join(", ")}`));
  }
  log.blank();

  if (schema.fields.length === 0) {
    log.warn(
      schema.matched_event_types?.length
        ? "The matched event types share no payload fields."
        : "This event type has no payload fields.",
    );
    return;
  }

  const rows = [
    ["PATH", "TYPE", "OPTIONAL", "ENUM"].map((header) => bold(header)),
    ...schema.fields.map((field) => [
      cyan(field.path),
      field.type,
      field.optional ? "yes" : "no",
      field.enum?.length ? field.enum.join(", ") : dim("-"),
    ]),
  ];
  for (const line of pad(rows)) log.info(line);

  const first = schema.fields[0]!.path;
  log.info(
    dim(
      `\n→ Filter on a field: clerk logs list --type ${shellArg(schema.event_type)} --payload-filter ${shellArg(`${first}=<value>`)}`,
    ),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a catalog entry has the fields the table reads. */
function isRenderableListEntry(entry: Record<string, unknown>): boolean {
  const { event_type, description, docs_group } = entry;
  return (
    typeof event_type === "string" &&
    (description == null || typeof description === "string") &&
    (docs_group == null || typeof docs_group === "string")
  );
}

/**
 * By docs group, then event type, so a family's types sit together. The API
 * sorts by event type alone. A type without a group goes last.
 */
export function compareByGroup(a: LogSchema, b: LogSchema): number {
  const groupA = a.docs_group ?? "";
  const groupB = b.docs_group ?? "";
  if (groupA !== groupB) {
    if (!groupA) return 1;
    if (!groupB) return -1;
    return groupA < groupB ? -1 : 1;
  }
  if (a.event_type === b.event_type) return 0;
  return a.event_type < b.event_type ? -1 : 1;
}

function printList(types: LogSchema[]): void {
  log.blank();
  if (types.length === 0) {
    log.warn("The instance has no event types to list.");
    return;
  }

  const rows = [
    ["TYPE", "GROUP", "DESCRIPTION"].map((header) => bold(header)),
    ...types
      .toSorted(compareByGroup)
      .map((type) => [cyan(type.event_type), type.docs_group || dim("-"), type.description || ""]),
  ];
  for (const line of pad(rows)) log.info(line);

  log.info(dim(`\n${types.length} ${types.length === 1 ? "event type" : "event types"}`));
  log.info(dim("→ See a type's fields: clerk logs schema <event-type>"));
}

/**
 * Before `GET /v1/logs/types` is deployed, or against a Backend API that
 * predates it, the route answers 404. It has no other 404 (no path
 * parameter, nothing to look up), so a 404 always means the route is missing.
 */
function typesRouteMissing(): CliError {
  return new CliError(
    "This Backend API can't list event types yet (GET /v1/logs/types returned 404). " +
      "Pass an event type to see its fields, like `clerk logs schema sign_in.completed`.",
    { examples: EVENT_TYPE_EXAMPLES.slice(1) },
  );
}

async function fetchTypes(secretKey: string): Promise<LogSchemaList> {
  let response: ApiResponse;
  try {
    response = await withSpinner("Fetching event types...", async () =>
      withApiContext(logsRequest("/logs/types", secretKey), "Failed to list the log event types"),
    );
  } catch (error) {
    if (error instanceof BapiError && error.status === 404) throw typesRouteMissing();
    throw error;
  }
  const body = response.body;
  if (!isObject(body) || !Array.isArray(body.data) || !body.data.every(isObject)) {
    throw new CliError(UNEXPECTED_RESPONSE);
  }
  return body as LogSchemaList;
}

async function fetchSchema(secretKey: string, type: string): Promise<LogSchema> {
  const response = await withSpinner("Fetching schema...", async () =>
    withApiContext(
      logsRequest(`/logs/schemas?${new URLSearchParams({ type })}`, secretKey),
      "Failed to read the log schema",
    ),
  );
  const body = response.body;
  if (!isObject(body)) throw new CliError(UNEXPECTED_RESPONSE);
  return body as LogSchema;
}

export async function schema(
  eventType: string | undefined,
  options: LogsSchemaOptions = {},
): Promise<void> {
  const json = Boolean(options.json) || isAgent();
  const shouldWrap = !isInsideGutter() && !json;
  const listing = eventType === undefined;
  if (shouldWrap) intro(listing ? "Listing log event types" : "Reading log schema");
  let closeStatus: "success" | "failed" | "paused" | undefined;

  try {
    const type = listing ? undefined : assertEventType(eventType);
    const secretKey = await resolveBapiSecretKey({
      secretKey: options.secretKey,
      app: options.app,
      instance: options.instance,
    });

    if (type === undefined) {
      const result = await fetchTypes(secretKey);
      if (json) {
        log.data(JSON.stringify(result, null, 2));
      } else {
        if (!result.data.every((entry) => isRenderableListEntry(entry))) {
          throw new CliError(UNEXPECTED_RESPONSE);
        }
        printList(result.data);
      }
    } else {
      const result = await fetchSchema(secretKey, type);
      if (json) {
        log.data(JSON.stringify(result, null, 2));
      } else {
        if (!isRenderableSchema(result)) throw new CliError(UNEXPECTED_RESPONSE);
        printHuman({ ...result, fields: result.fields ?? [] });
      }
    }
    closeStatus = "success";
  } catch (error) {
    closeStatus = closeStatusForError(error);
    throw error;
  } finally {
    if (shouldWrap) {
      if (closeStatus === "paused") {
        pausedOutro();
      } else if (closeStatus === "failed") {
        await outro("Failed");
      } else if (closeStatus === "success") {
        await outro();
      }
    }
  }
}

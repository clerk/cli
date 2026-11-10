/**
 * `clerk logs schema <event-type>` — the payload fields of a log event type,
 * from `GET /v1/logs/schemas?type=...`.
 *
 * The type can be concrete (`sign_in.completed`), a trailing-`*` wildcard
 * (`sign_in.*`) or a bare family name (`sign_in`); it is passed through as-is.
 * For a wildcard or family the API returns only the fields every matched type
 * shares, plus `matched_event_types`.
 */

import { resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { bold, cyan, dim } from "../../lib/color.ts";
import { CliError, throwUsageError, withApiContext } from "../../lib/errors.ts";
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

const EVENT_TYPE_EXAMPLES = [
  { command: "clerk logs schema sign_in.completed", description: "Fields of one event type" },
  { command: "clerk logs schema 'sign_in.*'", description: "Fields every sign_in event shares" },
];

function assertEventType(eventType: string | undefined): string {
  const value = eventType?.trim();
  if (!value) {
    throwUsageError(
      "Pass an event type, like `clerk logs schema sign_in.completed`.",
      undefined,
      undefined,
      EVENT_TYPE_EXAMPLES,
    );
  }
  // The API rejects a bare `*`: it would match every event type.
  if (value === "*") {
    throwUsageError(
      "A wildcard needs an event type prefix, like `sign_in.*`.",
      undefined,
      undefined,
      EVENT_TYPE_EXAMPLES,
    );
  }
  return value;
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
      `\n→ Filter on a field: clerk logs --type ${shellArg(schema.event_type)} --payload-filter ${shellArg(`${first}=<value>`)}`,
    ),
  );
}

export async function schema(
  eventType: string | undefined,
  options: LogsSchemaOptions = {},
): Promise<void> {
  const json = Boolean(options.json) || isAgent();
  const shouldWrap = !isInsideGutter() && !json;
  if (shouldWrap) intro("Reading log schema");
  let closeStatus: "success" | "failed" | "paused" | undefined;

  try {
    const type = assertEventType(eventType);
    const secretKey = await resolveBapiSecretKey({
      secretKey: options.secretKey,
      app: options.app,
      instance: options.instance,
    });
    const response = await withSpinner("Fetching schema...", async () =>
      withApiContext(
        logsRequest(`/logs/schemas?${new URLSearchParams({ type })}`, secretKey),
        "Failed to read the log schema",
      ),
    );
    const body = response.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new CliError("The Logs API returned an unexpected response.");
    }
    const result = body as LogSchema;

    if (json) {
      log.data(JSON.stringify(result, null, 2));
    } else {
      printHuman({ ...result, fields: result.fields ?? [] });
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

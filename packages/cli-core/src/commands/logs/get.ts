/**
 * `clerk logs get <id>` — the logs of one log group (a sign-in or a sign-up
 * flow), oldest first, from `GET /v1/logs/groups/{group_id}/events`.
 *
 * The request sends no `started_at`: the Backend API looks the group's start up
 * from its ID, and answers 404 for a group it can't find or one entirely past
 * the plan's log retention. Unlike `GET /v1/logs`, the endpoint doesn't scan
 * time windows, so a page is always full and one request covers `--limit`.
 *
 * A single log's ID (a UUID) is recognized but refused for now, because
 * `GET /v1/logs/{id}` doesn't take a bare log ID yet (CORE-4354).
 */

import { describeBapiTarget, resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { bold, dim } from "../../lib/color.ts";
import {
  BapiError,
  CliError,
  ERROR_CODE,
  throwUsageError,
  withApiContext,
} from "../../lib/errors.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import { closeStatusForError } from "../../lib/signals.ts";
import { intro, outro, pausedOutro, withSpinner } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { resolveFilters, type LogFilterOptions, type LogFilters } from "./filters.ts";
import { printTable, readLogsPage } from "./list.ts";
import { formatLogTime, logsRequest, type Log, type LogsTargetingOptions } from "./shared.ts";

export type LogsGetOptions = LogsTargetingOptions &
  LogFilterOptions & {
    limit?: number;
    cursor?: string;
  };

/** What `--json` prints: the group's logs and where to continue from. */
export type LogsGetResult = {
  data: Log[];
  cursor: {
    /** Pass to `--cursor` for the group's next logs. Null when there are no more. */
    next: string | null;
  };
};

export const DEFAULT_LIMIT = 50;
/** The endpoint's per-request maximum (`pagination.MaxLimit` in clerk_go). */
export const MAX_LIMIT = 500;

/** Log group types, keyed by the prefix of the group's ID (the flow's own ID). */
const GROUP_ID_PREFIXES = {
  sia_: "sign_in",
  sua_: "sign_up",
} as const;

export type LogGroupType = (typeof GROUP_ID_PREFIXES)[keyof typeof GROUP_ID_PREFIXES];

/**
 * What an ID passed to `clerk logs get` names. Only `group` is served today;
 * `log` is recognized so the usage error can say why it isn't, and so the
 * single-log lookup can be added here once the API accepts a bare log ID.
 */
export type LogLookup =
  | { kind: "group"; id: string; groupType: LogGroupType }
  | { kind: "log"; id: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A KSUID-style Clerk ID body: base62, at least one character. */
const ID_BODY_PATTERN = /^[0-9A-Za-z]+$/;

const GET_EXAMPLES = [
  { command: "clerk logs get sia_123", description: "The logs of a sign-in" },
  { command: "clerk logs get sua_123", description: "The logs of a sign-up" },
];

const ACCEPTED_FORMS = "a sign-in ID (sia_…) or a sign-up ID (sua_…)";

/** Classifies an ID, or throws a usage error when it is neither form. */
export function parseLogLookup(raw: string | undefined): LogLookup {
  const id = raw?.trim();
  if (!id) {
    throwUsageError(
      `Pass the ID of a log group: ${ACCEPTED_FORMS}.`,
      undefined,
      undefined,
      GET_EXAMPLES,
    );
  }
  for (const [prefix, groupType] of Object.entries(GROUP_ID_PREFIXES)) {
    if (id.startsWith(prefix) && ID_BODY_PATTERN.test(id.slice(prefix.length))) {
      return { kind: "group", id, groupType };
    }
  }
  if (UUID_PATTERN.test(id)) return { kind: "log", id: id.toLowerCase() };
  throwUsageError(
    `Invalid ID "${id}". Pass the ID of a log group: ${ACCEPTED_FORMS}.`,
    undefined,
    undefined,
    GET_EXAMPLES,
  );
}

export function buildGroupEventsPath(
  groupId: string,
  limit: number,
  startingAfter: string | undefined,
  filters: LogFilters,
): string {
  const params = new URLSearchParams({ limit: String(limit) });
  for (const [name, value] of filters) params.append(name, value);
  if (startingAfter) params.set("starting_after", startingAfter);
  return `/logs/groups/${encodeURIComponent(groupId)}/events?${params}`;
}

/**
 * Where the request went, for the not-found message. A secret key from
 * `--secret-key` or `CLERK_SECRET_KEY` (without `--app`) wins in
 * {@link resolveBapiSecretKey}, so there is no app or instance to name then.
 */
async function describeTarget(options: LogsGetOptions): Promise<string> {
  const keyOnly = "the instance of this secret key";
  if (options.secretKey || (!options.app && process.env.CLERK_SECRET_KEY)) return keyOnly;
  try {
    return (await describeBapiTarget(options)) ?? keyOnly;
  } catch {
    return keyOnly;
  }
}

async function groupNotFound(groupId: string, options: LogsGetOptions): Promise<CliError> {
  const target = await describeTarget(options);
  return new CliError(
    `Log group not found: no log group ${groupId} in ${target}. ` +
      "Check the ID and the targeted instance (--app, --instance); a group older than your plan's log retention isn't found either.",
    { code: ERROR_CODE.LOG_GROUP_NOT_FOUND },
  );
}

async function fetchGroupLogs(
  secretKey: string,
  groupId: string,
  limit: number,
  cursor: string | undefined,
  filters: LogFilters,
): Promise<LogsGetResult> {
  const response = await withApiContext(
    logsRequest(buildGroupEventsPath(groupId, limit, cursor, filters), secretKey),
    "Failed to read the log group",
  );
  const page = readLogsPage(response);
  const next =
    page.cursor?.next_page_status === "false" ? null : (page.cursor?.starting_after ?? null);
  return { data: page.data, cursor: { next } };
}

type GroupFields = { group_type?: string | null; group_started_at?: number | null };

/**
 * Who the flow is about: the latest user any of its logs is about, or the
 * first log's subject (usually the instance) when it never identified one.
 * The same rule the grouped list's `subject` follows, over the logs fetched.
 */
export function groupSubject(logs: Log[]): string | undefined {
  const user = logs.findLast((entry) => entry.subject?.startsWith("user_"))?.subject;
  return user || logs[0]?.subject || undefined;
}

function printHuman(
  lookup: Extract<LogLookup, { kind: "group" }>,
  result: LogsGetResult,
  showPayload: boolean,
): void {
  const fields = result.data[0] as (Log & GroupFields) | undefined;
  const groupType = fields?.group_type || lookup.groupType;
  const details: string[] = [];
  if (typeof fields?.group_started_at === "number") {
    details.push(`Started ${formatLogTime(fields.group_started_at)}`);
  }
  const subject = groupSubject(result.data);
  if (subject) details.push(`Subject ${subject}`);

  log.blank();
  log.info(`${bold(groupType)} ${lookup.id}`);
  if (details.length) log.info(dim(details.join(" · ")));
  log.blank();

  if (result.data.length === 0) {
    log.warn("No logs found.");
  } else {
    printTable(result.data, showPayload);
  }
  const count = `${result.data.length} ${result.data.length === 1 ? "log" : "logs"}`;
  const parts = [count];
  if (result.cursor.next) parts.push(`more: re-run with \`--cursor ${result.cursor.next}\``);
  log.info(dim(`\n${parts.join(" · ")}`));
}

export async function get(id: string | undefined, options: LogsGetOptions = {}): Promise<void> {
  const json = Boolean(options.json) || isAgent();
  const shouldWrap = !isInsideGutter() && !json;
  if (shouldWrap) intro("Reading log group");
  let closeStatus: "success" | "failed" | "paused" | undefined;

  try {
    const lookup = parseLogLookup(id);
    if (lookup.kind === "log") {
      throwUsageError(
        `Looking up a single log by its ID isn't supported yet. Pass the ID of a log group instead: ${ACCEPTED_FORMS}.`,
        undefined,
        undefined,
        GET_EXAMPLES,
      );
    }
    const filters = resolveFilters(options);
    const secretKey = await resolveBapiSecretKey({
      secretKey: options.secretKey,
      app: options.app,
      instance: options.instance,
    });

    let result: LogsGetResult;
    try {
      result = await withSpinner("Fetching logs...", async () =>
        fetchGroupLogs(
          secretKey,
          lookup.id,
          options.limit ?? DEFAULT_LIMIT,
          options.cursor,
          filters,
        ),
      );
    } catch (error) {
      if (error instanceof BapiError && error.status === 404) {
        throw await groupNotFound(lookup.id, options);
      }
      throw error;
    }

    if (json) {
      log.data(JSON.stringify(result, null, 2));
    } else {
      printHuman(lookup, result, options.fields !== undefined);
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

/**
 * `clerk logs list` (also `clerk logs`) — the instance's Application Logs,
 * newest first, from `GET /v1/logs`.
 *
 * The API scans one time window per request, sized from the instance's event
 * rate, so a page can come back short or empty with `next_page_status:
 * "unknown"` while older events remain. The command keeps paging until it has
 * `--limit` logs or the API says there are no more, so an empty window never
 * reads as "no logs".
 */

import { resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import type { ApiResponse } from "../../lib/fetch.ts";
import { bold, dim } from "../../lib/color.ts";
import { CliError, throwUsageError, withApiContext } from "../../lib/errors.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import { closeStatusForError } from "../../lib/signals.ts";
import { intro, outro, pausedOutro, withSpinner } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import {
  formatLogTime,
  logColumnHeaders,
  logRowCells,
  logsRequest,
  pad,
  type Log,
  type LogListCursor,
  type LogListItem,
  type LogListPage,
  type LogsTargetingOptions,
} from "./shared.ts";
import { resolveFilters, type LogFilterOptions, type LogFilters } from "./filters.ts";
import {
  GROUPED_MAX_LIMIT,
  groupedCount,
  printGroupedTable,
  resolveListView,
  type GroupedOptions,
} from "./grouped.ts";
import { resolveTimeRange, type TimeRangeOptions } from "./time.ts";

export type LogsListOptions = LogsTargetingOptions &
  TimeRangeOptions &
  LogFilterOptions &
  GroupedOptions & {
    limit?: number;
    cursor?: string;
    /** Only valid with `--follow`, which `follow.ts` handles; rejected here. */
    interval?: number;
  };

/** `event_time_after` / `event_time_before`, inclusive Unix milliseconds. */
export type TimeRange = { after?: number; before?: number };

/**
 * What `--json` prints: the logs (with `--grouped`, groups and the logs
 * outside any group) and where to continue from.
 */
export type LogsListResult<T extends LogListItem = Log> = {
  data: T[];
  cursor: {
    /** Pass to `--cursor` for the next page. Null when there are no older logs. */
    next: string | null;
    retention_limit_reached: boolean;
    retention_days: number | null;
    searched_from: number | null;
    searched_to: number | null;
  };
};

export const DEFAULT_LIMIT = 50;
/** The API's per-request maximum. */
export const MAX_PAGE_SIZE = 500;
/**
 * Requests one run makes before returning what it has. Each request scans up
 * to two days, so this covers the longest retention without letting a sparse
 * instance turn one command into an unbounded walk; `next` picks up from there.
 */
export const MAX_REQUESTS = 50;

/**
 * What every request of a run filters on: the time range, the event filters
 * and, with `--grouped`, the view (`flat` when left out) and its group filters.
 */
export type ListQuery = {
  range: TimeRange;
  filters: LogFilters;
  view?: "flat" | "grouped";
  groupFilters?: LogFilters;
};

export function buildListPath(
  limit: number,
  startingAfter: string | undefined,
  { range, filters, view = "flat", groupFilters = [] }: ListQuery,
): string {
  const params = new URLSearchParams({ view, limit: String(limit) });
  if (range.after !== undefined) params.set("event_time_after", String(range.after));
  if (range.before !== undefined) params.set("event_time_before", String(range.before));
  for (const [name, value] of filters) params.append(name, value);
  for (const [name, value] of groupFilters) params.append(name, value);
  if (startingAfter) params.set("starting_after", startingAfter);
  return `/logs?${params}`;
}

/**
 * What {@link fetchLogs} hands back. `error` is set when a request failed after
 * some logs were already in hand: `result` keeps them, with `cursor.next`
 * pointing at the page that failed so `--cursor` retries it.
 */
export type FetchLogsOutcome<T extends LogListItem = Log> = {
  result: LogsListResult<T>;
  error?: unknown;
};

/** Sends one `GET /v1/logs` request for a path built by {@link buildListPath}. */
export type LogsPageRequest = (path: string) => Promise<ApiResponse>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The page of a `GET /v1/logs` response, or a {@link CliError} when the body
 * isn't a JSON object with a `data` array of objects. `bapiRequest` hands back
 * the raw text when the body isn't JSON, and null for a literal `null`. A body
 * without `data` would otherwise read as an empty page: the end of a list, or a
 * quiet poll that moves `--follow` past logs it never printed. An item that
 * isn't an object would fail later with a `TypeError` instead.
 */
export function readLogsPage<T extends LogListItem = Log>(response: ApiResponse): LogListPage<T> {
  const body = response.body;
  if (!isObject(body) || !Array.isArray(body.data) || !body.data.every(isObject)) {
    throw new CliError("The Logs API returned an unexpected response.");
  }
  return body as LogListPage<T>;
}

/**
 * Pages through `GET /v1/logs` until `limit` logs are in hand or the API runs
 * out. `sendRequest` sends each page; `clerk logs --follow` passes one that retries.
 * The grouped view pages the same way, with groups and ungrouped logs as items.
 */
export async function fetchLogs<T extends LogListItem = Log>(
  secretKey: string,
  limit: number,
  cursor: string | undefined,
  query: ListQuery,
  sendRequest: LogsPageRequest = async (path) => logsRequest(path, secretKey),
): Promise<FetchLogsOutcome<T>> {
  const maxPageSize = query.view === "grouped" ? GROUPED_MAX_LIMIT : MAX_PAGE_SIZE;
  const data: T[] = [];
  let startingAfter = cursor;
  let first: LogListCursor | undefined;
  let last: LogListCursor | undefined;

  for (let request = 0; request < MAX_REQUESTS && data.length < limit; request++) {
    const pageSize = Math.min(limit - data.length, maxPageSize);
    let page: LogListPage<T>;
    try {
      const response = await withApiContext(
        sendRequest(buildListPath(pageSize, startingAfter, query)),
        "Failed to list logs",
      );
      // A body that isn't a JSON object counts as a failed request, so the
      // logs already in hand are kept instead of crashing or reading as "no
      // more logs".
      page = readLogsPage<T>(response);
    } catch (error) {
      if (data.length === 0) throw error;
      return { result: toResult(data, first, last, startingAfter ?? null), error };
    }
    data.push(...page.data);
    last = page.cursor ?? {};
    first ??= last;

    const next = last.starting_after ?? undefined;
    if (last.next_page_status === "false" || !next) break;
    // A cursor that doesn't move would repeat the same request until the
    // budget runs out and hand back a `next` that goes nowhere.
    if (next === startingAfter) {
      throw new CliError("The Logs API returned the same cursor twice, so paging can't continue.");
    }
    startingAfter = next;
  }

  const exhausted = !last || last.next_page_status === "false" || !last.starting_after;
  return { result: toResult(data, first, last, exhausted ? null : last!.starting_after!) };
}

function toResult<T extends LogListItem>(
  data: T[],
  first: LogListCursor | undefined,
  last: LogListCursor | undefined,
  next: string | null,
): LogsListResult<T> {
  return {
    data,
    cursor: {
      next,
      retention_limit_reached: Boolean(last?.retention_limit_reached),
      retention_days: last?.retention_days ?? null,
      // Newest bound from the first page, oldest from the last.
      searched_from: last?.searched_from ?? null,
      searched_to: first?.searched_to ?? null,
    },
  };
}

/** The `list` table: one row per log, columns sized to the widest cell. */
export function printTable(logs: Log[], showPayload: boolean): void {
  const now = new Date();
  const headers = logColumnHeaders(showPayload);
  const rows = [
    headers.map((header) => bold(header)),
    ...logs.map((entry) => logRowCells(entry, showPayload, now)),
  ];
  for (const line of pad(rows)) log.info(line);
}

function summary(result: LogsListResult<LogListItem>, count: string): string {
  const parts = [count];
  const { searched_from: from, searched_to: to, next } = result.cursor;
  if (from !== null && to !== null) {
    const now = new Date();
    parts.push(`searched ${formatLogTime(from, now)} – ${formatLogTime(to, now)}`);
  }
  if (next) parts.push(`more: re-run with \`--cursor ${next}\``);
  return parts.join(" · ");
}

function printHuman(
  result: LogsListResult<LogListItem>,
  showPayload: boolean,
  grouped: boolean,
): void {
  log.blank();
  if (result.data.length === 0) {
    log.warn("No logs found.");
  } else if (grouped) {
    printGroupedTable(result.data, showPayload);
  } else {
    printTable(result.data as Log[], showPayload);
  }
  const count = grouped
    ? groupedCount(result.data)
    : `${result.data.length} ${result.data.length === 1 ? "log" : "logs"}`;
  log.info(dim(`\n${summary(result, count)}`));
  if (result.cursor.retention_limit_reached) {
    const days = result.cursor.retention_days;
    log.warn(
      days
        ? `Results only go back ${days} days, your plan's log retention.`
        : "Results only go back as far as your plan's log retention.",
    );
  }
}

export async function list(options: LogsListOptions = {}): Promise<void> {
  if (options.interval !== undefined) throwUsageError("--interval requires --follow.");
  const json = Boolean(options.json) || isAgent();
  const shouldWrap = !isInsideGutter() && !json;
  if (shouldWrap) intro("Listing logs");
  let closeStatus: "success" | "failed" | "paused" | undefined;

  try {
    const { view, groupFilters } = resolveListView(options);
    const range = resolveTimeRange(options);
    const filters = resolveFilters(options);
    const secretKey = await resolveBapiSecretKey({
      secretKey: options.secretKey,
      app: options.app,
      instance: options.instance,
    });
    const { result, error } = await withSpinner("Fetching logs...", async () =>
      fetchLogs<LogListItem>(secretKey, options.limit ?? DEFAULT_LIMIT, options.cursor, {
        range,
        filters,
        view,
        groupFilters,
      }),
    );

    if (json) {
      log.data(JSON.stringify(result, null, 2));
    } else {
      printHuman(result, options.fields !== undefined, view === "grouped");
    }

    if (error) {
      log.warn(
        `Listing stopped early because a request failed. Re-run with \`--cursor ${result.cursor.next}\` to continue from the page that failed.`,
      );
      throw error;
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

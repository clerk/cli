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
import { bold, cyan, dim } from "../../lib/color.ts";
import { CliError, withApiContext } from "../../lib/errors.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import { closeStatusForError } from "../../lib/signals.ts";
import { intro, outro, pausedOutro, withSpinner } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import {
  formatLogLocation,
  formatLogTime,
  logsRequest,
  pad,
  type Log,
  type LogListCursor,
  type LogListPage,
  type LogsTargetingOptions,
} from "./shared.ts";
import { resolveFilters, type LogFilterOptions, type LogFilters } from "./filters.ts";
import { resolveTimeRange, type TimeRangeOptions } from "./time.ts";

export type LogsListOptions = LogsTargetingOptions &
  TimeRangeOptions &
  LogFilterOptions & {
    limit?: number;
    cursor?: string;
  };

/** `event_time_after` / `event_time_before`, inclusive Unix milliseconds. */
type TimeRange = { after?: number; before?: number };

/** What `--json` prints: the logs and where to continue from. */
export type LogsListResult = {
  data: Log[];
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
const MAX_PAGE_SIZE = 500;
/**
 * Requests one run makes before returning what it has. Each request scans up
 * to two days, so this covers the longest retention without letting a sparse
 * instance turn one command into an unbounded walk; `next` picks up from there.
 */
export const MAX_REQUESTS = 50;

/** What every request of a run filters on: the time range and the event filters. */
type ListQuery = { range: TimeRange; filters: LogFilters };

function buildListPath(
  limit: number,
  startingAfter: string | undefined,
  { range, filters }: ListQuery,
): string {
  const params = new URLSearchParams({ view: "flat", limit: String(limit) });
  if (range.after !== undefined) params.set("event_time_after", String(range.after));
  if (range.before !== undefined) params.set("event_time_before", String(range.before));
  for (const [name, value] of filters) params.append(name, value);
  if (startingAfter) params.set("starting_after", startingAfter);
  return `/logs?${params}`;
}

/**
 * What {@link fetchLogs} hands back. `error` is set when a request failed after
 * some logs were already in hand: `result` keeps them, with `cursor.next`
 * pointing at the page that failed so `--cursor` retries it.
 */
type FetchLogsOutcome = { result: LogsListResult; error?: unknown };

/** Pages through `GET /v1/logs` until `limit` logs are in hand or the API runs out. */
async function fetchLogs(
  secretKey: string,
  limit: number,
  cursor: string | undefined,
  query: ListQuery,
): Promise<FetchLogsOutcome> {
  const data: Log[] = [];
  let startingAfter = cursor;
  let first: LogListCursor | undefined;
  let last: LogListCursor | undefined;

  for (let request = 0; request < MAX_REQUESTS && data.length < limit; request++) {
    const pageSize = Math.min(limit - data.length, MAX_PAGE_SIZE);
    let page: LogListPage;
    try {
      const response = await withApiContext(
        logsRequest(buildListPath(pageSize, startingAfter, query), secretKey),
        "Failed to list logs",
      );
      // `bapiRequest` hands back the raw text when the body isn't JSON, and
      // null for a literal `null`. Treat either as a failed request so the
      // logs already in hand are kept instead of crashing or reading as "no
      // more logs".
      const body = response.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new CliError("The Logs API returned an unexpected response.");
      }
      page = body as LogListPage;
    } catch (error) {
      if (data.length === 0) throw error;
      return { result: toResult(data, first, last, startingAfter ?? null), error };
    }
    data.push(...(page.data ?? []));
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

function toResult(
  data: Log[],
  first: LogListCursor | undefined,
  last: LogListCursor | undefined,
  next: string | null,
): LogsListResult {
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

/** Leaves of a (possibly nested) payload as `path=value`, space-separated. */
export function formatPayload(payload: Record<string, unknown> | undefined): string {
  const pairs: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
      return;
    }
    pairs.push(`${path}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  };
  walk(payload ?? {}, "");
  return pairs.join(" ");
}

function printTable(logs: Log[], showPayload: boolean): void {
  const now = new Date();
  const headers = ["TIME", "TYPE", "ACTOR", "SUBJECT", "LOCATION"];
  if (showPayload) headers.push("PAYLOAD");
  headers.push("LOG ID");
  const rows = [
    headers.map((header) => bold(header)),
    ...logs.map((entry) => [
      formatLogTime(entry.event_time, now),
      cyan(entry.type),
      entry.actor || dim("-"),
      entry.subject || dim("-"),
      formatLogLocation(entry) || dim("-"),
      ...(showPayload ? [formatPayload(entry.payload) || dim("-")] : []),
      dim(entry.id),
    ]),
  ];
  for (const line of pad(rows)) log.info(line);
}

function summary(result: LogsListResult): string {
  const count = `${result.data.length} ${result.data.length === 1 ? "log" : "logs"}`;
  const parts = [count];
  const { searched_from: from, searched_to: to, next } = result.cursor;
  if (from !== null && to !== null) {
    const now = new Date();
    parts.push(`searched ${formatLogTime(from, now)} – ${formatLogTime(to, now)}`);
  }
  if (next) parts.push(`more: re-run with \`--cursor ${next}\``);
  return parts.join(" · ");
}

function printHuman(result: LogsListResult, showPayload: boolean): void {
  log.blank();
  if (result.data.length === 0) {
    log.warn("No logs found.");
  } else {
    printTable(result.data, showPayload);
  }
  log.info(dim(`\n${summary(result)}`));
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
  const json = Boolean(options.json) || isAgent();
  const shouldWrap = !isInsideGutter() && !json;
  if (shouldWrap) intro("Listing logs");
  let closeStatus: "success" | "failed" | "paused" | undefined;

  try {
    const range = resolveTimeRange(options);
    const filters = resolveFilters(options);
    const secretKey = await resolveBapiSecretKey({
      secretKey: options.secretKey,
      app: options.app,
      instance: options.instance,
    });
    const { result, error } = await withSpinner("Fetching logs...", async () =>
      fetchLogs(secretKey, options.limit ?? DEFAULT_LIMIT, options.cursor, { range, filters }),
    );

    if (json) {
      log.data(JSON.stringify(result, null, 2));
    } else {
      printHuman(result, options.fields !== undefined);
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

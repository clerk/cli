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
import { withApiContext } from "../../lib/errors.ts";
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

export type LogsListOptions = LogsTargetingOptions & {
  limit?: number;
  cursor?: string;
};

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

function buildListPath(limit: number, startingAfter: string | undefined): string {
  const params = new URLSearchParams({ view: "flat", limit: String(limit) });
  if (startingAfter) params.set("starting_after", startingAfter);
  return `/logs?${params}`;
}

/** Pages through `GET /v1/logs` until `limit` logs are in hand or the API runs out. */
async function fetchLogs(
  secretKey: string,
  limit: number,
  cursor: string | undefined,
): Promise<LogsListResult> {
  const data: Log[] = [];
  let startingAfter = cursor;
  let first: LogListCursor | undefined;
  let last: LogListCursor | undefined;

  for (let request = 0; request < MAX_REQUESTS && data.length < limit; request++) {
    const pageSize = Math.min(limit - data.length, MAX_PAGE_SIZE);
    const response = await logsRequest(buildListPath(pageSize, startingAfter), secretKey);
    const page = response.body as LogListPage;
    data.push(...(page.data ?? []));
    last = page.cursor ?? {};
    first ??= last;

    startingAfter = last.starting_after ?? undefined;
    if (last.next_page_status === "false" || !startingAfter) break;
  }

  const exhausted = !last || last.next_page_status === "false" || !last.starting_after;
  return {
    data,
    cursor: {
      next: exhausted ? null : last!.starting_after!,
      retention_limit_reached: Boolean(last?.retention_limit_reached),
      retention_days: last?.retention_days ?? null,
      // Newest bound from the first page, oldest from the last.
      searched_from: last?.searched_from ?? null,
      searched_to: first?.searched_to ?? null,
    },
  };
}

function printTable(logs: Log[]): void {
  const now = new Date();
  const rows = [
    ["TIME", "TYPE", "ACTOR", "SUBJECT", "LOCATION", "LOG ID"].map((header) => bold(header)),
    ...logs.map((entry) => [
      formatLogTime(entry.event_time, now),
      cyan(entry.type),
      entry.actor || dim("-"),
      entry.subject || dim("-"),
      formatLogLocation(entry) || dim("-"),
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

export async function list(options: LogsListOptions = {}): Promise<void> {
  const json = Boolean(options.json) || isAgent();
  const shouldWrap = !isInsideGutter() && !json;
  if (shouldWrap) intro("Listing logs");
  let closeStatus: "success" | "failed" | "paused" | undefined;

  try {
    const secretKey = await resolveBapiSecretKey({
      secretKey: options.secretKey,
      app: options.app,
      instance: options.instance,
    });
    const result = await withSpinner("Fetching logs...", async () =>
      withApiContext(
        fetchLogs(secretKey, options.limit ?? DEFAULT_LIMIT, options.cursor),
        "Failed to list logs",
      ),
    );

    if (json) {
      log.data(JSON.stringify(result, null, 2));
      return;
    }

    log.blank();
    if (result.data.length === 0) {
      log.warn("No logs found.");
    } else {
      printTable(result.data);
    }
    log.info(dim(`\n${summary(result)}`));
    if (result.cursor.retention_limit_reached) {
      const days = result.cursor.retention_days;
      const retention = days ? `${days}-day log retention` : "log retention";
      log.warn(`Results stop at your plan's ${retention}. Older logs can't be listed.`);
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

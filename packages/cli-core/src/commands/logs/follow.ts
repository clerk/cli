/**
 * `clerk logs --follow` — print the normal backfill, then keep polling
 * `GET /v1/logs` for new logs, oldest first, until Ctrl-C.
 *
 * Logs reach the API through a pipeline, so one can show up after a newer one
 * was already printed. Each poll therefore looks back {@link LOOKBACK_MS}
 * before the newest `event_time` printed, and skips the logs it already
 * printed by ID. Only the IDs inside that window are kept, so memory is bounded
 * by how many logs the window holds, however long the command runs.
 */

import { setTimeout as delay } from "node:timers/promises";

import { resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { bold, cyan, dim } from "../../lib/color.ts";
import {
  ApiError,
  CliError,
  errorMessage,
  throwUsageError,
  withApiContext,
} from "../../lib/errors.ts";
import type { ApiResponse } from "../../lib/fetch.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import { interruptSignal } from "../../lib/signals.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { resolveFilters } from "./filters.ts";
import {
  buildListPath,
  DEFAULT_LIMIT,
  fetchLogs,
  formatPayload,
  logColumnHeaders,
  MAX_PAGE_SIZE,
  MAX_REQUESTS,
  readLogsPage,
  type ListQuery,
  type LogsListOptions,
  type LogsPageRequest,
} from "./list.ts";
import { formatLogLocation, formatLogTime, logsRequest, type Log } from "./shared.ts";
import { resolveTimeRange } from "./time.ts";

export type LogsFollowOptions = LogsListOptions & { follow?: boolean };

export const DEFAULT_FOLLOW_INTERVAL_MS = 2_000;
export const MIN_FOLLOW_INTERVAL_MS = 1_000;
/** First backoff after a transient failure; it doubles per attempt up to {@link MAX_RETRY_DELAY_MS}. */
export const BASE_RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_DELAY_MS = 30_000;
/** How long transient failures may go on, with no successful request between them, before the follow gives up. */
export const RETRY_GIVE_UP_MS = 5 * 60_000;
/**
 * How long one request may take before it is abandoned and retried like a
 * network error. Without it, a connection that stops answering would hang the
 * follow forever, with no error and no new logs.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
/**
 * How far before the newest log printed each poll looks, so a log the pipeline
 * delivers late still gets printed (out of order, after newer ones).
 */
export const LOOKBACK_MS = 10_000;

/** The clock, the timer and the stop signal, injectable so tests don't wait in real time. */
export type FollowDeps = {
  now: () => number;
  /** Waits `ms`, settling early (resolve or reject) once `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * Ends the follow. Defaults to the CLI's {@link interruptSignal}: Ctrl-C is
   * handled by the CLI's own handler, which aborts it and exits 130.
   */
  signal?: AbortSignal;
};

const defaultDeps: FollowDeps = {
  now: () => Date.now(),
  sleep: async (ms, signal) => delay(ms, undefined, { signal }).catch(() => {}),
};

/**
 * The poll interval, or a usage error for a flag `--follow` can't honor.
 * Raised before a key is resolved or a request is made.
 */
export function resolveFollowOptions(options: LogsFollowOptions): number {
  // A follow has no end, so an upper bound would stop it from ever printing
  // anything new.
  if (options.to !== undefined) {
    throwUsageError("--follow can't be combined with --to, since new logs are always later.");
  }
  // The backfill always starts at the newest logs, which is where following
  // picks up; a cursor points somewhere older.
  if (options.cursor !== undefined) {
    throwUsageError("--follow can't be combined with --cursor.");
  }
  // When `--grouped` lands, reject it here too: grouped output summarizes a
  // finished window and has no meaning for a stream.

  const interval = options.interval ?? DEFAULT_FOLLOW_INTERVAL_MS;
  if (interval < MIN_FOLLOW_INTERVAL_MS) {
    throwUsageError("--interval must be at least 1s.");
  }
  return interval;
}

/**
 * Which logs have been printed, as far as the next poll can return them: the
 * newest `event_time` printed, and the ID and `event_time` of every log printed
 * within {@link LOOKBACK_MS} of it.
 */
export class FollowWindow {
  private readonly seen = new Map<string, number>();
  private newest: number | undefined;

  /**
   * @param anchor Where the window ends until a log is printed: the API's
   *   clock when the backfill ran.
   * @param floor The oldest `event_time` the follow may print. Older logs
   *   belong to the backfill, even when it left them out.
   */
  constructor(
    private readonly anchor: number,
    private readonly floor?: number,
  ) {}

  /** The `event_time_after` for the next poll. */
  get after(): number {
    const after = (this.newest ?? this.anchor) - LOOKBACK_MS;
    return this.floor === undefined ? after : Math.max(after, this.floor);
  }

  /** Whether `entry`, returned by a poll from `from`, hasn't been printed yet. */
  isNew(entry: Log, from: number = this.after): boolean {
    // An older log can only be one printed before its ID was let go.
    return entry.event_time >= from && !this.seen.has(entry.id);
  }

  /** Record `entry` as printed. */
  mark(entry: Log): void {
    this.seen.set(entry.id, entry.event_time);
    if (this.newest === undefined || entry.event_time > this.newest) this.newest = entry.event_time;
  }

  /**
   * Forget the IDs no poll can return again: those older than the window, or
   * than `keepFrom` while a poll from there is still being finished.
   */
  evict(keepFrom?: number): void {
    const cutoff = keepFrom === undefined ? this.after : Math.min(this.after, keepFrom);
    for (const [id, time] of this.seen) {
      if (time < cutoff) this.seen.delete(id);
    }
  }

  /** IDs remembered. For tests: it never holds more than the window's logs. */
  get size(): number {
    return this.seen.size;
  }
}

/** When the API sent `response`, from its `Date` header (whole seconds, rounded down). */
function responseTime(response: ApiResponse): number | undefined {
  const date = Date.parse(response.headers.get("date") ?? "");
  return Number.isNaN(date) ? undefined : date;
}

/** API pages come newest first; a stream reads oldest first. */
function chronological(logs: Log[]): Log[] {
  return logs.toReversed().sort((a, b) => a.event_time - b.event_time);
}

/** Whether a failed request is worth retrying: network trouble, a 5xx or a 429. */
export function isTransientError(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 429 || error.status >= 500;
  // The CLI's own checks (an unexpected body, a repeated cursor) won't change
  // on a retry, and an abort is a stop, not a failure.
  if (error instanceof CliError) return false;
  if (error instanceof Error && error.name === "AbortError") return false;
  // What's left is the request never getting an answer: a refused or reset
  // connection, DNS, a dropped network, or a request that hit
  // {@link REQUEST_TIMEOUT_MS} (a `TimeoutError`).
  return error instanceof Error;
}

/** Seconds from a 429's `Retry-After` header, if it has a usable one. */
function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof ApiError) || error.status !== 429) return undefined;
  const seconds = Number(error.headers?.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
}

/** Backoff before retry `attempt` (1-based): doubling from 1s, capped at 30s, or the 429's `Retry-After`. */
export function retryDelayMs(error: unknown, attempt: number): number {
  const backoff = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
  const requested = retryAfterMs(error);
  return requested === undefined ? backoff : Math.min(requested, MAX_RETRY_DELAY_MS);
}

function describeFailure(error: unknown): string {
  if (error instanceof ApiError) return `${error.status}: ${error.message}`;
  return errorMessage(error);
}

/**
 * A page request that retries transient failures, warning before each wait,
 * until it succeeds, fails for good, or `signal` aborts. Each attempt is
 * abandoned after {@link REQUEST_TIMEOUT_MS} and retried. A follow is meant to
 * outlast a short outage, so it gives up only after {@link RETRY_GIVE_UP_MS}
 * of failures with no successful request in between, with the last error.
 */
function retryingRequest(
  secretKey: string,
  deps: FollowDeps,
  signal: AbortSignal,
): LogsPageRequest {
  // When the current run of failures started. Shared by every request, so a
  // failure that alternates between pages still counts as one outage.
  let failingSince: number | undefined;
  return async (path) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await logsRequest(
          path,
          secretKey,
          AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        );
        failingSince = undefined;
        return response;
      } catch (error) {
        if (signal.aborted || !isTransientError(error)) throw error;
        failingSince ??= deps.now();
        if (deps.now() - failingSince >= RETRY_GIVE_UP_MS) {
          log.warn(`Fetching logs has failed for ${RETRY_GIVE_UP_MS / 60_000} minutes. Giving up.`);
          throw error;
        }
        const wait = retryDelayMs(error, attempt);
        log.warn(
          `Fetching logs failed (${describeFailure(error)}). Retrying in ${Math.ceil(wait / 1_000)}s (attempt ${attempt}).`,
        );
        await deps.sleep(wait, signal);
        if (signal.aborted) throw error;
      }
    }
  };
}

/** Where a poll that hit {@link MAX_REQUESTS} stopped, so the next one picks up there. */
export type PollResume = { after: number; startingAfter: string };

type PollResult = {
  /** The logs fetched, newest first. */
  logs: Log[];
  /** Set when the poll stopped at the request cap with older pages left. */
  resume?: PollResume;
};

/**
 * Every log at or after `after`, newest first, paging while the API says
 * there may be more. Each poll's window is only as old as the lookback, so this
 * is normally one request. A poll that hits {@link MAX_REQUESTS} hands back
 * where it stopped instead of dropping the rest. A stop mid-poll keeps the
 * pages already fetched, so they still get printed.
 */
async function poll(
  request: LogsPageRequest,
  after: number,
  base: ListQuery,
  signal: AbortSignal,
  startingAfter?: string,
): Promise<PollResult> {
  const query: ListQuery = { range: { after }, filters: base.filters };
  const logs: Log[] = [];
  let cursor = startingAfter;

  for (let requests = 0; requests < MAX_REQUESTS; requests++) {
    let page: ReturnType<typeof readLogsPage>;
    try {
      const response = await withApiContext(
        request(buildListPath(MAX_PAGE_SIZE, cursor, query)),
        "Failed to follow logs",
      );
      page = readLogsPage(response);
    } catch (error) {
      if (signal.aborted) return { logs };
      throw error;
    }
    logs.push(...page.data);

    const next = page.cursor?.starting_after ?? undefined;
    if (page.cursor?.next_page_status === "false" || !next) return { logs };
    if (next === cursor) {
      throw new CliError("The Logs API returned the same cursor twice, so paging can't continue.");
    }
    cursor = next;
  }
  log.warn(
    `A poll reached ${MAX_REQUESTS} requests. Catching up on the older logs next, so they print after newer ones.`,
  );
  return { logs, resume: { after, startingAfter: cursor! } };
}

/** Minimum column widths of a streamed line; a longer value pushes the rest of its line right. */
const LINE_WIDTHS = {
  time: 8,
  type: 28,
  /** A Clerk ID: a 4-5 character prefix and 27 characters. */
  id: 32,
  location: 20,
} as const;

function cell(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)));
}

/**
 * The table's columns as fixed-width cells, since a stream can't size its
 * columns from rows it hasn't seen. `PAYLOAD` goes last (after `LOG ID`, unlike
 * the table) because it is the one column with no natural width.
 */
function streamLine(cells: {
  time: string;
  type: string;
  actor: string;
  subject: string;
  location: string;
  id: string;
  payload?: string;
}): string {
  const fixed = [
    cell(cells.time, LINE_WIDTHS.time),
    cell(cells.type, LINE_WIDTHS.type),
    cell(cells.actor, LINE_WIDTHS.id),
    cell(cells.subject, LINE_WIDTHS.id),
    cell(cells.location, LINE_WIDTHS.location),
  ];
  const tail =
    cells.payload === undefined ? [cells.id] : [cell(cells.id, LINE_WIDTHS.id), cells.payload];
  return [...fixed, ...tail].join("  ").trimEnd();
}

export function formatFollowHeader(showPayload: boolean): string {
  const [time, type, actor, subject, location] = logColumnHeaders(false).map((header) =>
    bold(header),
  );
  return streamLine({
    time: time!,
    type: type!,
    actor: actor!,
    subject: subject!,
    location: location!,
    id: bold("LOG ID"),
    payload: showPayload ? bold("PAYLOAD") : undefined,
  });
}

export function formatFollowLine(entry: Log, showPayload: boolean, now: Date): string {
  return streamLine({
    time: formatLogTime(entry.event_time, now),
    type: cyan(entry.type),
    actor: entry.actor || dim("-"),
    subject: entry.subject || dim("-"),
    location: formatLogLocation(entry) || dim("-"),
    id: dim(entry.id),
    payload: showPayload ? formatPayload(entry.payload) || dim("-") : undefined,
  });
}

export async function follow(
  options: LogsFollowOptions = {},
  overrides: Partial<FollowDeps> = {},
): Promise<void> {
  const deps: FollowDeps = { ...defaultDeps, ...overrides };
  const json = Boolean(options.json) || isAgent();
  const showPayload = options.fields !== undefined;
  const interval = resolveFollowOptions(options);
  const range = resolveTimeRange(options, deps.now());
  const filters = resolveFilters(options);
  const secretKey = await resolveBapiSecretKey({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  // Ctrl-C is the CLI's interrupt handler's to handle: it aborts this signal,
  // which cancels the sleep or the request in flight, and exits 130.
  const signal = overrides.signal ?? interruptSignal();
  const shouldWrap = !isInsideGutter() && !json;
  if (shouldWrap) intro("Following logs");
  let failed = false;

  const print = json
    ? (entry: Log) => log.data(JSON.stringify(entry))
    : (entry: Log) => log.info(formatFollowLine(entry, showPayload, new Date(deps.now())));

  try {
    if (!json) {
      log.info(dim("Printing new logs as they arrive. Press Ctrl-C to stop."));
      log.info(formatFollowHeader(showPayload));
    }

    const request = retryingRequest(secretKey, deps, signal);
    const query: ListQuery = { range, filters };

    // The API's clock when the backfill started, from its first response's
    // `Date` header (or the local clock, read before the request, without one).
    let serverNow: number | undefined;
    const startedAt = deps.now();
    const backfillRequest: LogsPageRequest = async (path) => {
      const response = await request(path);
      serverNow ??= responseTime(response);
      return response;
    };

    let outcome: Awaited<ReturnType<typeof fetchLogs>>;
    try {
      outcome = await fetchLogs(
        secretKey,
        options.limit ?? DEFAULT_LIMIT,
        undefined,
        query,
        backfillRequest,
      );
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    const backfill = chronological(outcome.result.data);
    for (const entry of backfill) print(entry);
    if (outcome.error) {
      if (signal.aborted) return;
      throw outcome.error;
    }

    // With nothing printed yet, the window ends at the API's clock when the
    // backfill ran, so local clock skew can't open a gap or replay old logs.
    // Not at `searched_to`: a first page searches up to 5 minutes past the
    // API's clock, and anchoring there would skip the logs of those minutes.
    // When `--limit` cut the backfill short, the logs older than the oldest one
    // it printed were left out on purpose, so the follow doesn't print them
    // either.
    const truncated = outcome.result.cursor.next !== null;
    const printed = new FollowWindow(
      Math.min(outcome.result.cursor.searched_to ?? Infinity, serverNow ?? startedAt),
      truncated && backfill.length > 0 ? backfill[0]!.event_time + 1 : range.after,
    );
    for (const entry of backfill) printed.mark(entry);

    let resume: PollResume | undefined;
    while (!signal.aborted) {
      // A poll cut short at the request cap carries on at once.
      if (!resume) await deps.sleep(interval, signal);
      if (signal.aborted) break;

      const from = resume?.after ?? printed.after;
      let result: PollResult;
      try {
        result = await poll(request, from, query, signal, resume?.startingAfter);
      } catch (error) {
        if (signal.aborted) break;
        throw error;
      }

      for (const entry of chronological(result.logs)) {
        if (!printed.isNew(entry, from)) continue;
        print(entry);
        printed.mark(entry);
      }
      resume = result.resume;
      printed.evict(resume?.after);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (shouldWrap) await outro(failed ? "Failed" : "Stopped following");
  }
}

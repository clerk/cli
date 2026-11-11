/**
 * `clerk logs --follow` — print the normal backfill, then keep polling
 * `GET /v1/logs` for logs newer than the newest one printed, oldest first,
 * until Ctrl-C.
 *
 * Each poll asks for `event_time_after = <newest event_time seen>`. The bound
 * is inclusive, so the logs that share that millisecond come back again; they
 * are told apart by ID. Only the IDs at the boundary millisecond are kept, so
 * memory stays flat however long the command runs.
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
import { isInsideGutter, log } from "../../lib/log.ts";
import { CLI_SIGINT_HANDLER } from "../../lib/signals.ts";
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

/** The clock, the timer and the stop signal, injectable so tests don't wait in real time. */
export type FollowDeps = {
  now: () => number;
  /** Waits `ms`, settling early (resolve or reject) once `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Ends the follow cleanly. Without one, the first Ctrl-C does. */
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
 * newest `event_time` printed and the IDs printed at that millisecond.
 */
export class FollowBoundary {
  private ids = new Set<string>();

  constructor(private time?: number) {}

  /** The `event_time_after` for the next poll. */
  get after(): number | undefined {
    return this.time;
  }

  /** Whether `entry` hasn't been printed yet. */
  isNew(entry: Log): boolean {
    if (this.time === undefined || entry.event_time > this.time) return true;
    // Older than the boundary can only be a log printed before the bound moved.
    return entry.event_time === this.time && !this.ids.has(entry.id);
  }

  /** Record `entry` as printed. Call in chronological order. */
  mark(entry: Log): void {
    if (this.time === undefined || entry.event_time > this.time) {
      this.time = entry.event_time;
      this.ids = new Set([entry.id]);
    } else if (entry.event_time === this.time) {
      this.ids.add(entry.id);
    }
  }

  /** IDs remembered at the boundary millisecond. For tests: it never holds more. */
  get size(): number {
    return this.ids.size;
  }
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
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return false;
  }
  // What's left is the request never getting an answer: a refused or reset
  // connection, DNS, a dropped network.
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
 * until it succeeds, fails for good, or `signal` aborts. Retries don't give
 * up: a follow is meant to outlast an outage.
 */
function retryingRequest(
  secretKey: string,
  deps: FollowDeps,
  signal: AbortSignal,
): LogsPageRequest {
  return async (path) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await logsRequest(path, secretKey, signal);
      } catch (error) {
        if (signal.aborted || !isTransientError(error)) throw error;
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

/**
 * Every log newer than (or at) `after`, newest first, paging while the API
 * says there may be more. Each poll's window is only as old as the last log,
 * so this is normally one request.
 */
async function poll(request: LogsPageRequest, after: number, base: ListQuery): Promise<Log[]> {
  const query: ListQuery = { range: { after }, filters: base.filters };
  const logs: Log[] = [];
  let startingAfter: string | undefined;

  for (let requests = 0; requests < MAX_REQUESTS; requests++) {
    const response = await withApiContext(
      request(buildListPath(MAX_PAGE_SIZE, startingAfter, query)),
      "Failed to follow logs",
    );
    const page = readLogsPage(response);
    logs.push(...(page.data ?? []));

    const next = page.cursor?.starting_after ?? undefined;
    if (page.cursor?.next_page_status === "false" || !next) return logs;
    if (next === startingAfter) {
      throw new CliError("The Logs API returned the same cursor twice, so paging can't continue.");
    }
    startingAfter = next;
  }
  log.warn(
    `A poll stopped after ${MAX_REQUESTS} requests, so some logs since the last one printed may be missing.`,
  );
  return logs;
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

/**
 * Ends the follow on the first Ctrl-C instead of the CLI's interrupt handler,
 * so stopping a follow exits 0: it is how a follow is meant to end, and every
 * log fetched has already been printed. A second Ctrl-C goes back to the CLI's
 * handler and exits by signal, for a stop that hangs.
 */
function stopOnCtrlC(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const hadCliHandler = process.listeners("SIGINT").includes(CLI_SIGINT_HANDLER);
  const restore = () => {
    process.removeListener("SIGINT", onSigint);
    if (hadCliHandler && !process.listeners("SIGINT").includes(CLI_SIGINT_HANDLER)) {
      process.on("SIGINT", CLI_SIGINT_HANDLER);
    }
  };
  const onSigint = () => {
    restore();
    controller.abort();
  };
  if (hadCliHandler) process.removeListener("SIGINT", CLI_SIGINT_HANDLER);
  process.on("SIGINT", onSigint);
  return { signal: controller.signal, dispose: restore };
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

  const ctrlC = overrides.signal ? undefined : stopOnCtrlC();
  const signal = overrides.signal ?? ctrlC!.signal;
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

    let outcome: Awaited<ReturnType<typeof fetchLogs>>;
    try {
      outcome = await fetchLogs(
        secretKey,
        options.limit ?? DEFAULT_LIMIT,
        undefined,
        query,
        request,
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

    // With nothing to start from, follow from the end of the window the
    // backfill searched: the API's own clock, so local clock skew can't open a
    // gap or replay old logs.
    const boundary = new FollowBoundary(
      backfill.length > 0 ? undefined : (outcome.result.cursor.searched_to ?? deps.now()),
    );
    for (const entry of backfill) boundary.mark(entry);

    while (!signal.aborted) {
      await deps.sleep(interval, signal);
      if (signal.aborted) break;

      let fetched: Log[];
      try {
        fetched = await poll(request, boundary.after!, query);
      } catch (error) {
        if (signal.aborted) break;
        throw error;
      }

      const seen = new Set<string>();
      for (const entry of chronological(fetched)) {
        if (seen.has(entry.id) || !boundary.isNew(entry)) continue;
        seen.add(entry.id);
        print(entry);
        boundary.mark(entry);
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    ctrlC?.dispose();
    if (shouldWrap) await outro(failed ? "Failed" : "Stopped following");
  }
}

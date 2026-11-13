/**
 * Pieces every `clerk logs` subcommand shares: the targeting options, the
 * Backend API version the logs endpoints are pinned to, the response types,
 * and the table helpers.
 */

import { bapiRequest } from "../../lib/bapi.ts";
import { cyan, dim } from "../../lib/color.ts";
import type { ApiResponse } from "../../lib/fetch.ts";

/** The BAPI version whose `/v1/logs` response shape the CLI is written against. */
export const LOGS_API_VERSION = "2026-08-20";

export type LogsTargetingOptions = {
  json?: boolean;
  secretKey?: string;
  app?: string;
  instance?: string;
};

type LogLocation = { city?: string; country?: string; country_code?: string };

/** The fields of a `log` object the CLI reads. The JSON output passes the rest through. */
export type Log = {
  object: "log";
  id: string;
  event_time: number;
  type: string;
  actor?: string;
  subject?: string;
  event_context?: {
    device?: { ip_address?: string; location?: LogLocation };
  };
  /** Only with `payload_fields`: the requested leaves, keyed by dot-path. */
  payload?: Record<string, unknown>;
};

/** The `cursor` of a `GET /v1/logs` page. */
export type LogListCursor = {
  starting_after?: string | null;
  next_page_status?: "true" | "false" | "unknown";
  retention_limit_reached?: boolean;
  retention_days?: number;
  searched_from?: number;
  searched_to?: number;
};

/**
 * One event group of the grouped view (`view=grouped`): a sign-in or sign-up
 * flow, with its first events. The fields the CLI reads; JSON output passes
 * the rest through.
 */
export type LogGroup = {
  object: "log_group";
  /** The flow's ID: a sign-in (`sia_`) or sign-up (`sua_`) attempt. */
  group_id: string;
  group_type: string;
  /** When the flow started, Unix milliseconds. Groups sort by it. */
  started_at: number;
  event_count: number;
  /** Present only when event filters were applied. */
  matched_event_count?: number;
  /** `completed` or `failed`; null while the flow hasn't concluded. */
  status: string | null;
  status_label: string | null;
  subject: string;
  first_event: Log | null;
  /** The group's first events, oldest first (only matching ones under event filters). */
  events: Log[];
  has_more_events: boolean;
  events_cursor: string | null;
};

/** An item of a grouped page: a group, or a log outside any group. */
export type LogListItem = Log | LogGroup;

export type LogListPage<T extends LogListItem = Log> = { data: T[]; cursor?: LogListCursor };

export async function logsRequest(
  path: string,
  secretKey: string,
  signal?: AbortSignal,
): Promise<ApiResponse> {
  return bapiRequest({
    method: "GET",
    path,
    secretKey,
    apiVersion: LOGS_API_VERSION,
    ...(signal ? { signal } : {}),
  });
}

/** Pads every column but the last to its widest cell, two spaces apart. */
export function pad(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => Bun.stringWidth(row[column] ?? ""))),
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1
          ? cell
          : cell + " ".repeat(widths[column]! - Bun.stringWidth(cell)),
      )
      .join("  ")
      .trimEnd(),
  );
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A log time in local time: `HH:MM:SS` when it is today, with the date in
 * front otherwise.
 */
export function formatLogTime(ms: number, now: Date = new Date()): string {
  const date = new Date(ms);
  const time = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
  if (date.toDateString() === now.toDateString()) return time;
  const day = `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
  return `${day} ${time}`;
}

/** Leaves of a (possibly nested) payload as `path=value`, space-separated. */
export function formatPayload(payload: Record<string, unknown> | undefined): string {
  const pairs: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
      return;
    }
    // Payload strings are end-user input (usernames, email addresses), so
    // control characters, C1 included, are escaped before reaching the terminal.
    const text =
      typeof value === "string"
        ? value.replace(
            /\p{Cc}/gu,
            (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
          )
        : JSON.stringify(value);
    pairs.push(`${path}=${text}`);
  };
  walk(payload ?? {}, "");
  return pairs.join(" ");
}

/** A log's table cells, in {@link logColumnHeaders} order. */
export function logRowCells(entry: Log, showPayload: boolean, now: Date): string[] {
  return [
    formatLogTime(entry.event_time, now),
    cyan(entry.type),
    entry.actor || dim("-"),
    entry.subject || dim("-"),
    formatLogLocation(entry) || dim("-"),
    ...(showPayload ? [formatPayload(entry.payload) || dim("-")] : []),
    dim(entry.id),
  ];
}

/** The log table's column headers, `PAYLOAD` only with `--fields`. */
export function logColumnHeaders(showPayload: boolean): string[] {
  const headers = ["TIME", "TYPE", "ACTOR", "SUBJECT", "LOCATION"];
  if (showPayload) headers.push("PAYLOAD");
  headers.push("LOG ID");
  return headers;
}

/** City and country when the log has them, the IP address otherwise. */
export function formatLogLocation(log: Log): string {
  const device = log.event_context?.device;
  const location = device?.location;
  const country = location?.country_code || location?.country;
  const place = [location?.city, country].filter(Boolean).join(", ");
  return place || device?.ip_address || "";
}

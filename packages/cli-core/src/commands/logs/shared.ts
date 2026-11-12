/**
 * Pieces every `clerk logs` subcommand shares: the targeting options, the
 * Backend API version the logs endpoints are pinned to, the response types,
 * and the table helpers.
 */

import { bapiRequest } from "../../lib/bapi.ts";
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

export type LogListPage = { data: Log[]; cursor?: LogListCursor };

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

/** City and country when the log has them, the IP address otherwise. */
export function formatLogLocation(log: Log): string {
  const device = log.event_context?.device;
  const location = device?.location;
  const country = location?.country_code || location?.country;
  const place = [location?.city, country].filter(Boolean).join(", ");
  return place || device?.ip_address || "";
}

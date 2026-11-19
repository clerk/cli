/**
 * Parsers for the `clerk logs` time flags. The API takes inclusive Unix
 * milliseconds (`event_time_after` / `event_time_before`); these turn what a
 * person types into that.
 */

import { throwUsageError } from "../../lib/errors.ts";

const DURATION_UNITS_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

const DURATION_PATTERN = /^(\d+[smhdw])+$/;
const DURATION_PART = /(\d+)([smhdw])/g;
const DURATION_FORMATS = "a number followed by s, m, h, d or w, like 30m, 2h, 7d or 1h30m";

const UNIX_MS_PATTERN = /^\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/i;
const TIMESTAMP_FORMATS =
  "an ISO 8601 date-time (2026-11-09T15:30:00Z; UTC when it has no offset), a date (2026-11-09) or Unix milliseconds";
/**
 * Bare numbers earlier than this (2020-01-01T00:00:00Z in milliseconds) are
 * rejected: they're most likely Unix seconds, like `date +%s`, or a typo, and
 * reading them as milliseconds would silently mean a time no log is from.
 */
const MIN_UNIX_MS = Date.UTC(2020, 0, 1);

/**
 * A duration like `30m`, `2h`, `7d` or `1h30m`, in milliseconds. Throws a
 * usage error naming `flag` for anything else, including a zero duration.
 */
export function parseDuration(value: string, flag: string): number {
  const trimmed = value.trim().toLowerCase();
  if (!DURATION_PATTERN.test(trimmed)) {
    throwUsageError(`Invalid ${flag} value "${value}". Use ${DURATION_FORMATS}.`);
  }

  let total = 0;
  for (const [, amount, unit] of trimmed.matchAll(DURATION_PART)) {
    total += Number(amount) * DURATION_UNITS_MS[unit as keyof typeof DURATION_UNITS_MS];
  }
  if (total <= 0) {
    throwUsageError(`Invalid ${flag} value "${value}". The duration must be longer than zero.`);
  }
  return total;
}

/**
 * A point in time, in Unix milliseconds: an ISO 8601 date-time (read as UTC
 * when it has no offset, so a command means the same on any machine), a bare
 * `YYYY-MM-DD` (midnight UTC) or Unix milliseconds. Throws a usage error naming
 * `flag` for anything else, including a bare number earlier than {@link MIN_UNIX_MS},
 * which is most likely Unix seconds or a typo.
 */
export function parseTimestamp(value: string, flag: string): number {
  const trimmed = value.trim();
  let ms = Number.NaN;

  if (UNIX_MS_PATTERN.test(trimmed)) {
    ms = Number(trimmed);
    if (ms < MIN_UNIX_MS) throwTooEarlyNumber(value, flag);
  } else if (DATE_PATTERN.test(trimmed)) {
    ms = Date.parse(`${trimmed}T00:00:00Z`);
  } else if (DATE_TIME_PATTERN.test(trimmed)) {
    const iso = trimmed.replace(" ", "T");
    ms = Date.parse(/(Z|[+-]\d{2}:\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  }
  // The runtime rolls an impossible day like 2026-02-30 over into March, so
  // check the calendar date itself before trusting the parsed time.
  if (!UNIX_MS_PATTERN.test(trimmed) && !isCalendarDate(trimmed.slice(0, 10))) {
    ms = Number.NaN;
  }

  if (!Number.isFinite(ms)) {
    throwUsageError(`Invalid ${flag} value "${value}". Use ${TIMESTAMP_FORMATS}.`);
  }
  return ms;
}

/** A usage error for a bare number earlier than {@link MIN_UNIX_MS}. */
function throwTooEarlyNumber(value: string, flag: string): never {
  throwUsageError(
    `Invalid ${flag} value "${value}". ${flag} takes Unix milliseconds or an ISO 8601 date-time, like 1762702200000 or 2026-11-09T15:30:00Z.`,
  );
}

/** Whether `YYYY-MM-DD` names a day that exists, so 2026-02-30 doesn't. */
function isCalendarDate(date: string): boolean {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === date;
}

export type TimeRangeOptions = {
  since?: number;
  from?: number;
  to?: number;
};

/** The API's time bounds, or a usage error for a range that can't match anything. */
export function resolveTimeRange(
  options: TimeRangeOptions,
  now: number = Date.now(),
): { after?: number; before?: number } {
  if (options.since !== undefined && options.from !== undefined) {
    throwUsageError("Pass either --since or --from, not both.");
  }

  const after = options.since !== undefined ? now - options.since : options.from;
  const before = options.to;
  if (after !== undefined && before !== undefined && after > before) {
    const start = options.since !== undefined ? "--since" : "--from";
    throwUsageError(`${start} must start before --to.`);
  }
  return { after, before };
}

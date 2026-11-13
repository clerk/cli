/**
 * `clerk logs list --grouped` — the grouped view of `GET /v1/logs`
 * (`view=grouped`), where each sign-in and sign-up flow is one `log_group`
 * item, next to the logs outside any flow. It pages like the flat list
 * (`next_page_status`, `starting_after`), but only forward, and the API caps a
 * page at {@link GROUPED_MAX_LIMIT} items since every group carries its events.
 *
 * The checks here mirror the Backend API's (`ReadAllGrouped` and
 * `parseGroupFilters` in clerk_go), so a bad combination names the CLI flag
 * and fails before a key is resolved or a request is made.
 */

import { bold, dim, green, red } from "../../lib/color.ts";
import { throwUsageError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import type { LogFilters } from "./filters.ts";
import {
  formatLogTime,
  logRowCells,
  pad,
  type Log,
  type LogGroup,
  type LogListItem,
} from "./shared.ts";

export const GROUP_TYPE_CHOICES = ["sign_in", "sign_up"] as const;
export const GROUP_STATUS_CHOICES = ["completed", "failed"] as const;

/** The API's per-request maximum in the grouped view. */
export const GROUPED_MAX_LIMIT = 100;

export type GroupedOptions = {
  grouped?: boolean;
  groupType?: string[];
  status?: string[];
  limit?: number;
};

/** What `view` to request, and the group filters that go with it. */
export type ListView = { view: "flat" | "grouped"; groupFilters: LogFilters };

/**
 * Commander reducer for a repeatable option with a fixed set of values. Commander's
 * own `.choices()` validation is replaced by `.argParser()`, so this checks the
 * value itself; `.choices()` still feeds help and shell completion.
 */
export function collectChoice(
  flag: string,
  choices: readonly string[],
): (value: string, previous?: string[]) => string[] {
  return (value, previous = []) => {
    if (!choices.includes(value)) {
      throwUsageError(`Invalid ${flag} value "${value}". Use ${choices.join(" or ")}.`);
    }
    return [...previous, value];
  };
}

/**
 * The view and group filters for `--grouped`, `--group-type` and `--status`,
 * or a usage error for a combination the API would reject.
 */
export function resolveListView(options: GroupedOptions): ListView {
  if (!options.grouped) {
    // The flat list rejects the group filters rather than ignoring them.
    if (options.groupType?.length) throwUsageError("--group-type requires --grouped.");
    if (options.status?.length) throwUsageError("--status requires --grouped.");
    return { view: "flat", groupFilters: [] };
  }
  if (options.limit !== undefined && options.limit > GROUPED_MAX_LIMIT) {
    throwUsageError(
      `--limit can be at most ${GROUPED_MAX_LIMIT} with --grouped, since every group brings its events along.`,
    );
  }
  const groupFilters: LogFilters = [];
  for (const groupType of new Set(options.groupType)) groupFilters.push(["group_type", groupType]);
  for (const status of new Set(options.status)) groupFilters.push(["status", status]);
  return { view: "grouped", groupFilters };
}

export function isLogGroup(item: LogListItem): item is LogGroup {
  return item.object === "log_group";
}

export const GROUP_COLUMN_HEADERS = ["STARTED", "TYPE", "GROUP", "STATUS", "SUBJECT", "EVENTS"];

function formatStatus(status: string | null): string {
  if (status === "completed") return green(status);
  if (status === "failed") return red(status);
  return status ?? "";
}

/** `event_count`, or `<matched> of <total>` when event filters narrowed the group. */
function formatEventCount(group: LogGroup): string {
  if (group.matched_event_count === undefined) return String(group.event_count);
  return `${group.matched_event_count} of ${group.event_count}`;
}

/**
 * The note under a group whose page left events out. The count is only exact
 * when event filters were applied: without them `event_count` can include
 * events the instance can't read (feature-gated types), which the page never
 * lists.
 */
export function moreEventsNote(group: LogGroup): string {
  // Names `clerk logs get`, so the rest of the group's events are one
  // copy-paste away.
  const read = `read them with \`clerk logs get ${group.group_id}\``;
  if (group.matched_event_count !== undefined) {
    const hidden = group.matched_event_count - group.events.length;
    if (hidden > 0) {
      return `${hidden} more matching ${hidden === 1 ? "event" : "events"} not shown; ${read}`;
    }
  }
  return `more events not shown; ${read}`;
}

/**
 * One row per group (a log outside any group gets a row of its own with no
 * group type or ID), each followed by its events indented two spaces. The group rows
 * align with each other, and so do all the event rows.
 */
export function formatGroupedTable(
  items: LogListItem[],
  showPayload: boolean,
  now: Date,
): string[] {
  const groupRows: string[][] = [GROUP_COLUMN_HEADERS.map((header) => bold(header))];
  const eventRows: string[][] = [];
  // Per item: its event rows, and the note when the page left events out.
  const children: Array<{ events: number; note?: string }> = [];

  for (const item of items) {
    const events: Log[] = isLogGroup(item) ? item.events : [item];
    if (isLogGroup(item)) {
      groupRows.push([
        formatLogTime(item.started_at, now),
        item.group_type,
        item.group_id,
        formatStatus(item.status),
        item.subject || dim("-"),
        formatEventCount(item),
      ]);
    } else {
      groupRows.push([
        formatLogTime(item.event_time, now),
        dim("-"),
        dim("-"),
        "",
        item.subject || dim("-"),
        "1",
      ]);
    }
    for (const entry of events) eventRows.push(logRowCells(entry, showPayload, now));
    children.push({
      events: events.length,
      note: isLogGroup(item) && item.has_more_events ? moreEventsNote(item) : undefined,
    });
  }

  const [header, ...groupLines] = pad(groupRows);
  const eventLines = eventRows.length > 0 ? pad(eventRows) : [];
  const lines = [header!];
  let next = 0;
  children.forEach((child, index) => {
    lines.push(groupLines[index]!);
    for (const line of eventLines.slice(next, next + child.events)) lines.push(`  ${line}`);
    next += child.events;
    if (child.note) lines.push(`  ${dim(child.note)}`);
  });
  return lines;
}

export function printGroupedTable(items: LogListItem[], showPayload: boolean): void {
  for (const line of formatGroupedTable(items, showPayload, new Date())) log.info(line);
}

/** `2 groups, 1 log outside a group`, leaving out a part that is zero. */
export function groupedCount(items: LogListItem[]): string {
  const groups = items.filter(isLogGroup).length;
  const logs = items.length - groups;
  const parts: string[] = [];
  if (groups > 0 || logs === 0) parts.push(`${groups} ${groups === 1 ? "group" : "groups"}`);
  if (logs > 0) parts.push(`${logs} ${logs === 1 ? "log" : "logs"} outside a group`);
  return parts.join(", ");
}

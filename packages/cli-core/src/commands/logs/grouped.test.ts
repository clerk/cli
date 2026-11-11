import { test, expect, describe } from "bun:test";
import { CliError, EXIT_CODE } from "../../lib/errors.ts";
import {
  collectChoice,
  GROUP_TYPE_CHOICES,
  groupedCount,
  moreEventsNote,
  resolveListView,
  type GroupedOptions,
} from "./grouped.ts";
import type { LogGroup, LogListItem } from "./shared.ts";

function group(overrides: Partial<LogGroup> = {}): LogGroup {
  return {
    object: "log_group",
    group_id: "sia_1",
    group_type: "sign_in",
    started_at: 0,
    event_count: 1,
    status: null,
    status_label: null,
    subject: "user_1",
    first_event: null,
    events: [],
    has_more_events: false,
    events_cursor: null,
    ...overrides,
  };
}

const ungrouped: LogListItem = { object: "log", id: "log_1", event_time: 0, type: "user.updated" };

describe("resolveListView", () => {
  test("is the flat view with no group filters by default", () => {
    expect(resolveListView({})).toEqual({ view: "flat", groupFilters: [] });
  });

  test("maps --group-type and --status to group_type and status in order", () => {
    expect(
      resolveListView({
        grouped: true,
        groupType: ["sign_up", "sign_in"],
        status: ["completed", "failed"],
        limit: 100,
      }),
    ).toEqual({
      view: "grouped",
      groupFilters: [
        ["group_type", "sign_up"],
        ["group_type", "sign_in"],
        ["status", "completed"],
        ["status", "failed"],
      ],
    });
  });

  const invalid: Array<{ label: string; options: GroupedOptions; message: string }> = [
    { label: "--group-type alone", options: { groupType: ["sign_in"] }, message: "--group-type" },
    { label: "--status alone", options: { status: ["failed"] }, message: "--status" },
    { label: "--limit 101", options: { grouped: true, limit: 101 }, message: "--limit" },
  ];

  test.each(invalid)("rejects $label as a usage error", ({ options, message }) => {
    let error: unknown;
    try {
      resolveListView(options);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
    expect((error as Error).message).toContain(message);
  });
});

describe("collectChoice", () => {
  const parse = collectChoice("--group-type", GROUP_TYPE_CHOICES);

  test("collects repeated values", () => {
    expect(parse("sign_up", parse("sign_in"))).toEqual(["sign_in", "sign_up"]);
  });

  test("rejects a value outside the choices as a usage error", () => {
    expect(() => parse("sign_out")).toThrow(
      'Invalid --group-type value "sign_out". Use sign_in or sign_up.',
    );
  });
});

describe("moreEventsNote", () => {
  test.each([
    {
      label: "matched count",
      overrides: { matched_event_count: 52 },
      note: "2 more matching events not shown",
    },
    {
      label: "one left",
      overrides: { matched_event_count: 51 },
      note: "1 more matching event not shown",
    },
    { label: "no matched count", overrides: { event_count: 90 }, note: "more events not shown" },
  ])("with $label", ({ overrides, note }) => {
    const events = Array.from({ length: 50 }, (_, i) => ({
      object: "log" as const,
      id: `log_${i}`,
      event_time: i,
      type: "sign_in.created",
    }));
    expect(moreEventsNote(group({ events, has_more_events: true, ...overrides }))).toBe(note);
  });
});

describe("groupedCount", () => {
  const counts: Array<{ label: string; items: LogListItem[]; text: string }> = [
    { label: "nothing", items: [], text: "0 groups" },
    { label: "one group", items: [group()], text: "1 group" },
    { label: "only ungrouped logs", items: [ungrouped, ungrouped], text: "2 logs outside a group" },
    {
      label: "both",
      items: [group(), group(), ungrouped],
      text: "2 groups, 1 log outside a group",
    },
  ];

  test.each(counts)("counts $label", ({ items, text }) => {
    expect(groupedCount(items)).toBe(text);
  });
});

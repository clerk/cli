import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { BapiError, CliError } from "../../lib/errors.ts";
import { _resetInterruptState, abortInFlight, interruptSignal } from "../../lib/signals.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockBapiRequest = mock();
mock.module("../../lib/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));

const mockResolveBapiSecretKey = mock();
mock.module("../../lib/bapi-command.ts", () => ({
  resolveBapiSecretKey: (...args: unknown[]) => mockResolveBapiSecretKey(...args),
}));

mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  pausedOutro: () => {},
  bar: () => {},
  withSpinner: (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

const {
  follow,
  FollowWindow,
  DEFAULT_FOLLOW_INTERVAL_MS,
  LOOKBACK_MS,
  MAX_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  RETRY_GIVE_UP_MS,
  isTransientError,
  retryDelayMs,
} = await import("./follow.ts");
const { list } = await import("./list.ts");

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");
const NOW = Date.UTC(2026, 10, 9, 15, 30, 0);
/** A minute before {@link NOW}: event times in the tests are offsets from it. */
const T = NOW - 60_000;

function makeLog(id: string, eventTime: number, overrides: Record<string, unknown> = {}) {
  return {
    object: "log",
    id,
    event_time: eventTime,
    type: "user.created",
    actor: "user_123",
    subject: "user_123",
    event_context: {
      device: { ip_address: "203.0.113.7", location: { city: "Lima", country_code: "PE" } },
    },
    ...overrides,
  };
}

function page(
  data: readonly unknown[],
  cursor: Record<string, unknown> = { next_page_status: "false" },
) {
  return { status: 200, headers: new Headers(), body: { data, cursor }, rawBody: "" };
}

function apiError(status: number, headers: Record<string, string> = {}) {
  return new BapiError(
    status,
    JSON.stringify({ errors: [{ message: `status ${status}`, code: "error" }] }),
    new Headers(headers),
  );
}

function requestedUrl(call: number): URL {
  const request = mockBapiRequest.mock.calls[call]?.[0] as { path: string };
  return new URL(request.path, "https://api.clerk.test");
}

function printedIds(out: string): string[] {
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { id: string }).id);
}

/**
 * Runs `follow` with a fake clock and a sleep that returns at once, stopping
 * (as Ctrl-C would) when the poll interval is slept for the `polls + 1`th time.
 */
async function runFollow(options: Parameters<typeof follow>[0], polls: number) {
  const controller = new AbortController();
  const sleeps: number[] = [];
  let intervals = 0;
  const sleep = mock(async (ms: number) => {
    sleeps.push(ms);
    if (ms === (options?.interval ?? DEFAULT_FOLLOW_INTERVAL_MS) && ++intervals > polls) {
      controller.abort();
    }
  });
  await follow(options, { now: () => NOW, sleep, signal: controller.signal });
  return { sleeps, controller };
}

describe("logs --follow", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveBapiSecretKey.mockResolvedValue("sk_test_123");
    mockBapiRequest.mockResolvedValue(page([]));
  });

  afterEach(() => {
    _resetInterruptState();
    mockBapiRequest.mockReset();
    mockResolveBapiSecretKey.mockReset();
    mockIsAgent.mockReset();
  });

  test("prints the backfill oldest first, then polls from the lookback before the newest event_time", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(page([makeLog("log_2", T + 2_000), makeLog("log_1", T + 1_000)]))
      .mockResolvedValueOnce(page([makeLog("log_3", T + 3_000), makeLog("log_2", T + 2_000)]))
      .mockResolvedValueOnce(page([makeLog("log_3", T + 3_000)]));

    await runFollow({ json: true }, 2);

    expect(printedIds(captured.out)).toEqual(["log_1", "log_2", "log_3"]);
    expect(requestedUrl(0).searchParams.has("event_time_after")).toBe(false);
    expect(requestedUrl(1).searchParams.get("event_time_after")).toBe(
      String(T + 2_000 - LOOKBACK_MS),
    );
    expect(requestedUrl(2).searchParams.get("event_time_after")).toBe(
      String(T + 3_000 - LOOKBACK_MS),
    );
    expect(requestedUrl(1).searchParams.get("limit")).toBe("500");
    expect(requestedUrl(1).searchParams.get("view")).toBe("flat");
  });

  test("waits the interval between polls, 2s by default", async () => {
    const { sleeps } = await runFollow({ json: true }, 2);
    expect(sleeps).toEqual([2_000, 2_000, 2_000]);
  });

  test("honors --interval", async () => {
    const { sleeps } = await runFollow({ json: true, interval: 5_000 }, 1);
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  test("bounds only the backfill with --limit", async () => {
    mockBapiRequest.mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]));

    await runFollow({ json: true, limit: 7 }, 1);

    expect(requestedUrl(0).searchParams.get("limit")).toBe("7");
    expect(requestedUrl(1).searchParams.get("limit")).toBe("500");
  });

  test("dedupes the logs a poll returns again by ID", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(page([makeLog("log_b", T + 5_000), makeLog("log_a", T + 5_000)]))
      // Same millisecond: log_a and log_b again, log_c new.
      .mockResolvedValueOnce(
        page([
          makeLog("log_c", T + 5_000),
          makeLog("log_b", T + 5_000),
          makeLog("log_a", T + 5_000),
        ]),
      )
      .mockResolvedValueOnce(page([makeLog("log_d", T + 6_000), makeLog("log_c", T + 5_000)]));

    await runFollow({ json: true }, 2);

    expect(printedIds(captured.out)).toEqual(["log_a", "log_b", "log_c", "log_d"]);
    expect(requestedUrl(2).searchParams.get("event_time_after")).toBe(
      String(T + 5_000 - LOOKBACK_MS),
    );
  });

  test("prints every log of a poll in chronological order", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]))
      .mockResolvedValueOnce(
        page([
          makeLog("log_4", T + 4_000),
          makeLog("log_3", T + 3_000),
          makeLog("log_2", T + 2_000),
        ]),
      );

    await runFollow({ json: true }, 1);

    expect(printedIds(captured.out)).toEqual(["log_1", "log_2", "log_3", "log_4"]);
  });

  test("keeps paging a poll while next_page_status is unknown", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]))
      .mockResolvedValueOnce(page([], { next_page_status: "unknown", starting_after: "cur_1" }))
      .mockResolvedValueOnce(
        page([makeLog("log_3", T + 3_000)], {
          next_page_status: "unknown",
          starting_after: "cur_2",
        }),
      )
      .mockResolvedValueOnce(page([makeLog("log_2", T + 2_000)], { next_page_status: "false" }));

    await runFollow({ json: true }, 1);

    expect(mockBapiRequest).toHaveBeenCalledTimes(4);
    expect(requestedUrl(2).searchParams.get("starting_after")).toBe("cur_1");
    expect(requestedUrl(3).searchParams.get("starting_after")).toBe("cur_2");
    expect(requestedUrl(3).searchParams.get("event_time_after")).toBe(
      String(T + 1_000 - LOOKBACK_MS),
    );
    expect(printedIds(captured.out)).toEqual(["log_1", "log_2", "log_3"]);
  });

  test("follows from the end of the searched window when the backfill is empty", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(page([], { next_page_status: "false", searched_to: T + 9_000 }))
      .mockResolvedValueOnce(page([makeLog("log_1", T + 9_000)]));

    await runFollow({ json: true }, 1);

    expect(requestedUrl(1).searchParams.get("event_time_after")).toBe(
      String(T + 9_000 - LOOKBACK_MS),
    );
    expect(printedIds(captured.out)).toEqual(["log_1"]);
  });

  test("anchors an empty backfill at the API's Date, not at searched_to, which runs 5 minutes ahead", async () => {
    // A first page searches up to 5 minutes past the API's clock.
    const serverNow = NOW - 30_000;
    mockBapiRequest
      .mockResolvedValueOnce({
        ...page([], { next_page_status: "false", searched_to: serverNow + 5 * 60_000 }),
        headers: new Headers({ date: new Date(serverNow).toUTCString() }),
      })
      .mockResolvedValueOnce(page([makeLog("log_1", serverNow + 1_000)]));

    await runFollow({ json: true }, 1);

    expect(requestedUrl(1).searchParams.get("event_time_after")).toBe(
      String(serverNow - LOOKBACK_MS),
    );
    expect(printedIds(captured.out)).toEqual(["log_1"]);
  });

  test("anchors an empty backfill at the local clock when the response has no Date", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(page([], { next_page_status: "false", searched_to: NOW + 5 * 60_000 }))
      .mockResolvedValueOnce(page([]));

    await runFollow({ json: true }, 1);

    expect(requestedUrl(1).searchParams.get("event_time_after")).toBe(String(NOW - LOOKBACK_MS));
  });

  test("sends the time range and filters on the backfill and the event filters on every poll", async () => {
    mockBapiRequest.mockResolvedValueOnce(page([makeLog("log_1", NOW - 1_000)]));

    await runFollow({ json: true, since: 3_600_000, type: "user.created", user: "user_123" }, 1);

    expect(requestedUrl(0).searchParams.get("event_time_after")).toBe(String(NOW - 3_600_000));
    const poll = requestedUrl(1).searchParams;
    expect(poll.get("event_time_after")).toBe(String(NOW - 1_000 - LOOKBACK_MS));
    expect(poll.get("type")).toBe("user.created");
    expect(poll.get("user_id")).toBe("user_123");
  });

  test("prints a log that arrives late, inside the lookback window, once", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(page([makeLog("log_new", T + 20_000)]))
      // log_late happened 6s before log_new but only reached the API now.
      .mockResolvedValueOnce(
        page([makeLog("log_new", T + 20_000), makeLog("log_late", T + 14_000)]),
      )
      .mockResolvedValueOnce(
        page([makeLog("log_new", T + 20_000), makeLog("log_late", T + 14_000)]),
      );

    await runFollow({ json: true }, 2);

    // Out of chronological order: it is printed when it arrives.
    expect(printedIds(captured.out)).toEqual(["log_new", "log_late"]);
    expect(requestedUrl(1).searchParams.get("event_time_after")).toBe(String(T + 10_000));
  });

  test("doesn't refetch or reprint a log older than the lookback window", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(page([makeLog("log_2", T + 30_000), makeLog("log_1", T + 1_000)]))
      // An API that ignores the bound: log_1 is outside the window, so it stays printed.
      .mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]));

    await runFollow({ json: true }, 1);

    expect(requestedUrl(1).searchParams.get("event_time_after")).toBe(String(T + 20_000));
    expect(printedIds(captured.out)).toEqual(["log_1", "log_2"]);
  });

  /** A page whose `Date` header says the API's clock reads `apiNow`. */
  function pageAt(apiNow: number, data: unknown[]) {
    return { ...page(data), headers: new Headers({ date: new Date(apiNow).toUTCString() }) };
  }

  test("looks back no more than 5 minutes before the API's Date after a quiet stretch", async () => {
    const lastLog = NOW - 60 * 60_000;
    mockBapiRequest
      .mockResolvedValueOnce(pageAt(NOW, [makeLog("log_old", lastLog)]))
      .mockResolvedValueOnce(pageAt(NOW + 2_000, []))
      .mockResolvedValueOnce(pageAt(NOW + 4_000, []));

    await runFollow({ json: true, since: 2 * 60 * 60_000 }, 2);

    // Not lastLog - 10s: that would rescan the whole hour on every poll.
    expect(requestedUrl(1).searchParams.get("event_time_after")).toBe(String(NOW - MAX_DELAY_MS));
    expect(requestedUrl(2).searchParams.get("event_time_after")).toBe(
      String(NOW + 2_000 - MAX_DELAY_MS),
    );
    expect(printedIds(captured.out)).toEqual(["log_old"]);
  });

  test("keeps the 5-minute floor moving with the local clock when responses have no Date", async () => {
    const interval = 60_000;
    const controller = new AbortController();
    let now = NOW;
    let polls = 0;
    const sleep = mock(async (ms: number) => {
      now += ms;
      if (++polls > 10) controller.abort();
    });
    mockBapiRequest.mockResolvedValueOnce(page([makeLog("log_1", NOW - 1_000)]));

    await follow({ json: true, interval }, { now: () => now, sleep, signal: controller.signal });

    // Each poll's floor is the previous request's local send time minus 5
    // minutes, so the window never grows past 5 minutes plus one interval.
    for (let call = 1; call < mockBapiRequest.mock.calls.length; call++) {
      const after = Number(requestedUrl(call).searchParams.get("event_time_after"));
      const sentAt = NOW + call * interval;
      expect(sentAt - after).toBeLessThanOrEqual(MAX_DELAY_MS + interval);
    }
    expect(Number(requestedUrl(10).searchParams.get("event_time_after"))).toBe(
      NOW + 9 * interval - MAX_DELAY_MS,
    );
  });

  test("still prints a log that arrives late after a quiet stretch, once", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(pageAt(NOW, [makeLog("log_old", NOW - 60 * 60_000)]))
      // log_late happened 2 minutes ago but only reached the API now.
      .mockResolvedValueOnce(pageAt(NOW, [makeLog("log_late", NOW - 2 * 60_000)]))
      .mockResolvedValueOnce(pageAt(NOW, [makeLog("log_late", NOW - 2 * 60_000)]));

    await runFollow({ json: true, since: 2 * 60 * 60_000 }, 2);

    expect(printedIds(captured.out)).toEqual(["log_old", "log_late"]);
    expect(requestedUrl(2).searchParams.get("event_time_after")).toBe(
      String(NOW - 2 * 60_000 - LOOKBACK_MS),
    );
  });

  test("looks back from the newest log while it is within 5 minutes of the API's Date", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(pageAt(NOW, [makeLog("log_1", NOW - 4 * 60_000)]))
      .mockResolvedValueOnce(pageAt(NOW, []));

    await runFollow({ json: true }, 1);

    expect(requestedUrl(1).searchParams.get("event_time_after")).toBe(
      String(NOW - 4 * 60_000 - LOOKBACK_MS),
    );
  });

  test("doesn't look back past the oldest log of a backfill --limit cut short", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(
        page([makeLog("log_3", T + 5_000), makeLog("log_2", T + 4_000)], {
          next_page_status: "unknown",
          starting_after: "cur_1",
        }),
      )
      .mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]));

    await runFollow({ json: true, limit: 2 }, 1);

    expect(requestedUrl(1).searchParams.get("event_time_after")).toBe(String(T + 4_001));
    expect(printedIds(captured.out)).toEqual(["log_2", "log_3"]);
  });

  test("doesn't look back past --since", async () => {
    mockBapiRequest.mockResolvedValueOnce(page([makeLog("log_1", NOW - 1_000)]));

    await runFollow({ json: true, since: 5_000 }, 1);

    expect(requestedUrl(1).searchParams.get("event_time_after")).toBe(String(NOW - 5_000));
  });

  test("finishes a poll that hit the request cap before moving on", async () => {
    let calls = 0;
    mockBapiRequest.mockImplementation(async () => {
      calls++;
      if (calls === 1) return page([makeLog("log_0", T)]);
      // The first poll: MAX_REQUESTS pages, each with more to come.
      if (calls <= 51) {
        return page([makeLog(`log_${calls}`, T + 60_000 - calls)], {
          next_page_status: "unknown",
          starting_after: `cur_${calls}`,
        });
      }
      if (calls === 52) return page([makeLog("log_older", T + 1_000)]);
      return page([]);
    });

    const { sleeps } = await runFollow({ json: true }, 2);

    const firstPoll = requestedUrl(1).searchParams.get("event_time_after");
    const resumed = requestedUrl(51).searchParams;
    expect(resumed.get("starting_after")).toBe("cur_51");
    expect(resumed.get("event_time_after")).toBe(firstPoll);
    // The resumed request goes out without waiting the interval.
    expect(sleeps).toEqual([2_000, 2_000, 2_000]);
    const ids = printedIds(captured.out);
    expect(ids).toContain("log_older");
    expect(ids.indexOf("log_older")).toBeGreaterThan(ids.indexOf("log_51"));
    expect(captured.err).toContain("A poll reached 50 requests");
  });

  test("prints the pages a poll fetched before a stop aborted it", async () => {
    const controller = new AbortController();
    mockBapiRequest
      .mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]))
      .mockResolvedValueOnce(
        page([makeLog("log_2", T + 2_000)], { next_page_status: "unknown", starting_after: "c" }),
      )
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      });

    await follow(
      { json: true },
      { now: () => NOW, sleep: async () => {}, signal: controller.signal },
    );

    expect(printedIds(captured.out)).toEqual(["log_1", "log_2"]);
  });

  /** A follow whose clock moves forward by every sleep, at an interval no backoff matches. */
  function runWithClock(polls: number) {
    const interval = 5_000;
    const controller = new AbortController();
    let now = NOW;
    let intervals = 0;
    const sleep = mock(async (ms: number) => {
      now += ms;
      if (ms === interval && ++intervals > polls) controller.abort();
    });
    return follow({ json: true, interval }, { now: () => now, sleep, signal: controller.signal });
  }

  test("gives up with the last error after 5 minutes of transient failures", async () => {
    mockBapiRequest.mockResolvedValueOnce(page([])).mockRejectedValue(apiError(503));

    await expect(runWithClock(5)).rejects.toMatchObject({ status: 503 });

    expect(captured.err).toContain("Fetching logs has failed for 5 minutes. Giving up.");
    // Backoff 1+2+4+8+16 = 31s, then 30s waits: the first failure at or past
    // 5 minutes is the 15th.
    const failures = mockBapiRequest.mock.calls.length - 1;
    expect(failures).toBe(15);
    expect(RETRY_GIVE_UP_MS).toBe(300_000);
  });

  test("restarts the 5 minutes after a successful request", async () => {
    const failFor = (count: number) => {
      for (let i = 0; i < count; i++) mockBapiRequest.mockRejectedValueOnce(apiError(503));
    };
    mockBapiRequest.mockResolvedValueOnce(page([]));
    // 13 failures wait 1+2+4+8+16+30*8 = 271s, short of the limit; then a success.
    failFor(13);
    mockBapiRequest.mockResolvedValueOnce(page([]));
    failFor(13);
    mockBapiRequest.mockResolvedValueOnce(page([makeLog("log_1", NOW)]));

    await runWithClock(2);

    expect(captured.err).not.toContain("Giving up");
    expect(printedIds(captured.out)).toEqual(["log_1"]);
  });

  test("prints NDJSON: one log object per line", async () => {
    const entry = makeLog("log_1", T + 1_000);
    mockBapiRequest.mockResolvedValueOnce(page([entry, makeLog("log_0", T + 500)]));

    await runFollow({ json: true }, 0);

    const lines = captured.out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual(entry);
    expect(captured.err).not.toContain("LOG ID");
  });

  test("prints NDJSON in agent mode without --json", async () => {
    mockIsAgent.mockReturnValue(true);
    mockBapiRequest.mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]));

    await runFollow({}, 0);

    expect(printedIds(captured.out)).toEqual(["log_1"]);
  });

  test("prints fixed-width lines under a header to stderr in human mode", async () => {
    mockBapiRequest.mockResolvedValueOnce(
      page([makeLog("log_2", NOW, { actor: "", type: "session.created" }), makeLog("log_1", NOW)]),
    );

    await runFollow({}, 0);

    expect(captured.out).toBe("");
    const lines = captured.err.replace(ANSI_ESCAPE_PATTERN, "").split("\n");
    const header = lines.find((line) => line.includes("LOG ID"))!;
    expect(header).toMatch(/TIME\s+TYPE\s+ACTOR\s+SUBJECT\s+LOCATION\s+LOG ID/);
    const first = lines.findIndex((line) => line.includes("log_1"));
    const second = lines.findIndex((line) => line.includes("log_2"));
    expect(first).toBeLessThan(second);
    // Fixed widths: the LOG ID column starts at the same offset on every line.
    expect(lines[first]!.indexOf("log_1")).toBe(header.indexOf("LOG ID"));
    expect(lines[second]!.indexOf("log_2")).toBe(header.indexOf("LOG ID"));
    expect(lines[second]).toContain("session.created");
    expect(captured.err).toContain("Press Ctrl-C to stop");
  });

  test("puts the PAYLOAD column last with --fields", async () => {
    mockBapiRequest.mockResolvedValueOnce(
      page([makeLog("log_1", NOW, { payload: { user_id: "user_123" } })]),
    );

    await runFollow({ type: "user.created", fields: "user_id" }, 0);

    const plain = captured.err.replace(ANSI_ESCAPE_PATTERN, "");
    expect(plain).toMatch(/LOCATION\s+LOG ID\s+PAYLOAD/);
    expect(plain).toMatch(/log_1\s+user_id=user_123/);
  });

  test("retries a transient failure with backoff and a warning, then keeps following", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]))
      .mockRejectedValueOnce(apiError(503))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"))
      .mockResolvedValueOnce(page([makeLog("log_2", T + 2_000)]));

    // An interval the backoff can't be mistaken for.
    const { sleeps } = await runFollow({ json: true, interval: 5_000 }, 1);

    expect(sleeps).toEqual([5_000, 1_000, 2_000, 4_000, 5_000]);
    expect(printedIds(captured.out)).toEqual(["log_1", "log_2"]);
    expect(captured.err).toContain("Fetching logs failed (503: status 503). Retrying in 1s");
    expect(captured.err).toContain("Fetching logs failed (fetch failed). Retrying in 2s");
    expect(captured.err).toContain(
      "Fetching logs failed (The operation timed out.). Retrying in 4s",
    );
  });

  test("retries a failed backfill request too", async () => {
    mockBapiRequest
      .mockRejectedValueOnce(apiError(500))
      .mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]));

    await runFollow({ json: true }, 0);

    expect(printedIds(captured.out)).toEqual(["log_1"]);
    expect(captured.err).toContain("Retrying in 1s");
  });

  test("waits out a 429's Retry-After", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(page([]))
      .mockRejectedValueOnce(apiError(429, { "retry-after": "7" }))
      .mockResolvedValueOnce(page([]));

    const { sleeps } = await runFollow({ json: true }, 1);

    expect(sleeps).toContain(7_000);
    expect(captured.err).toContain("Retrying in 7s");
  });

  test.each([401, 403, 400, 404])("exits with the API error on a %d", async (status) => {
    mockBapiRequest.mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]));
    mockBapiRequest.mockRejectedValueOnce(apiError(status));

    await expect(runFollow({ json: true }, 5)).rejects.toMatchObject({ status });
    expect(mockBapiRequest).toHaveBeenCalledTimes(2);
    expect(captured.err).not.toContain("Retrying");
  });

  test("exits with the API error when the backfill is unauthorized", async () => {
    mockBapiRequest.mockRejectedValueOnce(apiError(401));

    await expect(runFollow({ json: true }, 5)).rejects.toMatchObject({ status: 401 });
    expect(captured.out).toBe("");
  });

  test("stops cleanly when the signal aborts during the interval", async () => {
    mockBapiRequest.mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]));

    const { controller } = await runFollow({ json: true }, 0);

    expect(controller.signal.aborted).toBe(true);
    expect(mockBapiRequest).toHaveBeenCalledTimes(1);
  });

  test("stops cleanly when the signal aborts an in-flight poll", async () => {
    const controller = new AbortController();
    mockBapiRequest
      .mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]))
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      });

    await follow(
      { json: true },
      { now: () => NOW, sleep: async () => {}, signal: controller.signal },
    );

    expect(printedIds(captured.out)).toEqual(["log_1"]);
    expect(captured.err).not.toContain("Retrying");
  });

  test("passes its stop signal to every request, combined with the request timeout", async () => {
    const { controller } = await runFollow({ json: true }, 1);

    const request = mockBapiRequest.mock.calls[1]?.[0] as { signal?: AbortSignal };
    // Its own signal, which the stop aborted with the stop's reason.
    expect(request.signal).not.toBe(controller.signal);
    expect(request.signal?.aborted).toBe(true);
    expect(request.signal?.reason).toBe(controller.signal.reason);
  });

  test("leaves Ctrl-C to the CLI's handler and stops when it aborts in-flight work", async () => {
    const before = process.listeners("SIGINT");
    mockBapiRequest.mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]));
    let sleeps = 0;

    await follow(
      { json: true },
      {
        now: () => NOW,
        sleep: async () => {
          // The CLI's SIGINT handler latches 130 and aborts the interrupt signal.
          if (++sleeps === 2) abortInFlight();
        },
      },
    );

    expect(sleeps).toBe(2);
    expect(process.listeners("SIGINT")).toEqual(before);
    const request = mockBapiRequest.mock.calls[1]?.[0] as { signal?: AbortSignal };
    expect(request.signal?.reason).toBe(interruptSignal().reason);
    expect(printedIds(captured.out)).toEqual(["log_1"]);
  });

  test.each([
    { label: "a null item", data: [null] },
    { label: "a string item", data: ["log_1"] },
    { label: "an array item", data: [[]] },
  ])("stops with a clean error when a poll's data holds $label", async ({ data }) => {
    mockBapiRequest
      .mockResolvedValueOnce(page([makeLog("log_1", T + 1_000)]))
      .mockResolvedValueOnce(page(data));

    await expect(runFollow({ json: true }, 5)).rejects.toThrow(
      "The Logs API returned an unexpected response.",
    );
    expect(mockBapiRequest).toHaveBeenCalledTimes(2);
    expect(printedIds(captured.out)).toEqual(["log_1"]);
  });

  test("stops with an error when a poll repeats its cursor", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([], { next_page_status: "unknown", starting_after: "cur_1" }))
      .mockResolvedValueOnce(page([], { next_page_status: "unknown", starting_after: "cur_1" }));

    await expect(runFollow({ json: true }, 5)).rejects.toThrow("same cursor twice");
  });

  const invalid = [
    { label: "--to", options: { to: 1_000 }, message: "--follow can't be combined with --to" },
    {
      label: "--cursor",
      options: { cursor: "cur_1" },
      message: "--follow can't be combined with --cursor.",
    },
    {
      label: "an interval under 1s",
      options: { interval: 500 },
      message: "--interval must be at least 1s.",
    },
    {
      label: "--since with --from",
      options: { since: 1_000, from: 1_000 },
      message: "Pass either --since or --from, not both.",
    },
    {
      label: "an invalid filter",
      options: { user: "user_1", actor: "user_2" },
      message: "--user can't be combined with --actor.",
    },
  ];

  test.each(invalid)(
    "rejects $label before resolving a key or calling the API",
    async ({ options, message }) => {
      await expect(runFollow({ json: true, ...options }, 0)).rejects.toThrow(message);
      expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
      expect(mockBapiRequest).not.toHaveBeenCalled();
    },
  );

  test("rejects --interval without --follow", async () => {
    await expect(list({ json: true, interval: 2_000 })).rejects.toThrow(
      "--interval requires --follow.",
    );
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });
});

describe("FollowWindow", () => {
  test("looks back from the newest log printed, or from the anchor before any", () => {
    const window = new FollowWindow(T);
    expect(window.after).toBe(T - LOOKBACK_MS);

    window.mark(makeLog("log_2", T + 20_000) as never);
    window.mark(makeLog("log_1", T + 5_000) as never);

    expect(window.after).toBe(T + 20_000 - LOOKBACK_MS);
  });

  test("never looks back past its floor", () => {
    const window = new FollowWindow(T, T - 3_000);
    expect(window.after).toBe(T - 3_000);
  });

  test("forgets the IDs older than the window, so memory stays bounded", () => {
    const window = new FollowWindow(T);
    // One log a second for ten minutes: only the last window's worth is kept.
    for (let second = 0; second < 600; second++) {
      window.mark(makeLog(`log_${second}`, T + second * 1_000) as never);
      window.evict();
    }

    expect(window.size).toBe(LOOKBACK_MS / 1_000 + 1);
    expect(window.isNew(makeLog("log_599", T + 599_000) as never)).toBe(false);
    expect(window.isNew(makeLog("log_590", T + 590_000) as never)).toBe(false);
    expect(window.isNew(makeLog("log_new", T + 595_000) as never)).toBe(true);
  });

  test("treats a log older than the window as printed, even once its ID is gone", () => {
    const window = new FollowWindow(T);
    window.mark(makeLog("log_1", T) as never);
    window.mark(makeLog("log_2", T + 60_000) as never);
    window.evict();

    expect(window.size).toBe(1);
    expect(window.isNew(makeLog("log_1", T) as never)).toBe(false);
  });

  test("looks back no more than 5 minutes before the API's clock, and forgets older IDs", () => {
    const window = new FollowWindow(T);
    window.mark(makeLog("log_1", T) as never);
    window.observe(T + 10 * 60_000);
    window.evict();

    expect(window.after).toBe(T + 10 * 60_000 - MAX_DELAY_MS);
    expect(window.size).toBe(0);
    expect(window.isNew(makeLog("log_1", T) as never)).toBe(false);
  });

  test("keeps the --limit or --since floor above the 5-minute bound", () => {
    const window = new FollowWindow(T, T + 9 * 60_000);
    window.observe(T + 10 * 60_000);
    expect(window.after).toBe(T + 9 * 60_000);
  });

  test("keeps the IDs a poll still being finished can return", () => {
    const window = new FollowWindow(T);
    window.mark(makeLog("log_1", T) as never);
    window.mark(makeLog("log_2", T + 60_000) as never);
    window.evict(T);

    expect(window.size).toBe(2);
    expect(window.isNew(makeLog("log_1", T) as never, T)).toBe(false);
    expect(window.isNew(makeLog("log_0", T) as never, T)).toBe(true);
  });
});

describe("retry policy", () => {
  test.each([
    { error: apiError(500), transient: true },
    { error: apiError(503), transient: true },
    { error: apiError(429), transient: true },
    { error: new TypeError("fetch failed"), transient: true },
    { error: apiError(401), transient: false },
    { error: apiError(403), transient: false },
    { error: apiError(422), transient: false },
    { error: new CliError("The Logs API returned an unexpected response."), transient: false },
    { error: new DOMException("aborted", "AbortError"), transient: false },
    { error: new DOMException("The operation timed out.", "TimeoutError"), transient: true },
  ])("treats $error.message as transient: $transient", ({ error, transient }) => {
    expect(isTransientError(error)).toBe(transient);
  });

  test.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [5, 16_000],
    [6, MAX_RETRY_DELAY_MS],
    [20, MAX_RETRY_DELAY_MS],
  ])("backs off attempt %d by %dms", (attempt, expected) => {
    expect(retryDelayMs(apiError(503), attempt)).toBe(expected);
  });

  test("caps a 429's Retry-After at the maximum backoff", () => {
    expect(retryDelayMs(apiError(429, { "retry-after": "600" }), 1)).toBe(MAX_RETRY_DELAY_MS);
  });
});

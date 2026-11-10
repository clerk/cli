import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockBapiRequest = mock();
mock.module("../../lib/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));

const mockResolveBapiSecretKey = mock();
mock.module("../../lib/bapi-command.ts", () => ({
  resolveBapiSecretKey: (...args: unknown[]) => mockResolveBapiSecretKey(...args),
}));

const mockWithSpinner = mock((_msg: string, fn: () => Promise<unknown>) => fn());
mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  pausedOutro: () => {},
  bar: () => {},
  withSpinner: (...args: Parameters<typeof mockWithSpinner>) => mockWithSpinner(...args),
}));

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

const { list, MAX_REQUESTS } = await import("./list.ts");

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");

function makeLog(id: string, overrides: Record<string, unknown> = {}) {
  return {
    object: "log",
    id,
    event_time: Date.UTC(2026, 10, 9, 15, 30, 0),
    type: "user.created",
    actor: "user_123",
    subject: "user_123",
    event_context: {
      device: { ip_address: "203.0.113.7", location: { city: "Lima", country_code: "PE" } },
    },
    ...overrides,
  };
}

function page(data: unknown[], cursor: Record<string, unknown> = {}) {
  return { status: 200, headers: new Headers(), body: { data, cursor }, rawBody: "" };
}

function requestedUrl(call: number): URL {
  const request = mockBapiRequest.mock.calls[call]?.[0] as { path: string };
  return new URL(request.path, "https://api.clerk.test");
}

describe("logs list", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveBapiSecretKey.mockResolvedValue("sk_test_123");
    mockBapiRequest.mockResolvedValue(page([makeLog("log_1")], { next_page_status: "false" }));
  });

  afterEach(() => {
    mockBapiRequest.mockReset();
    mockResolveBapiSecretKey.mockReset();
    mockWithSpinner.mockClear();
    mockIsAgent.mockReset();
  });

  test("forwards targeting options when resolving the secret key", async () => {
    await list({ json: true, secretKey: "sk_test_override", app: "app_123", instance: "prod" });

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_override",
      app: "app_123",
      instance: "prod",
    });
  });

  test("requests the flat view with the pinned API version and the default limit", async () => {
    await list({ json: true });

    expect(mockBapiRequest).toHaveBeenCalledTimes(1);
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/logs?view=flat&limit=50",
      secretKey: "sk_test_123",
      apiVersion: "2026-08-20",
    });
  });

  test("wraps the network read in a spinner", async () => {
    await list();

    expect(mockWithSpinner).toHaveBeenCalledWith("Fetching logs...", expect.any(Function));
  });

  test("passes --limit and --cursor through", async () => {
    await list({ json: true, limit: 10, cursor: "cur_prev" });

    const url = requestedUrl(0);
    expect(url.pathname).toBe("/logs");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("starting_after")).toBe("cur_prev");
  });

  test("keeps paging while next_page_status is unknown, asking only for what is left", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(page([], { next_page_status: "unknown", starting_after: "cur_1" }))
      .mockResolvedValueOnce(
        page([makeLog("log_1")], { next_page_status: "unknown", starting_after: "cur_2" }),
      )
      .mockResolvedValueOnce(
        page([makeLog("log_2"), makeLog("log_3")], {
          next_page_status: "true",
          starting_after: "cur_3",
        }),
      );

    await list({ json: true, limit: 3 });

    expect(mockBapiRequest).toHaveBeenCalledTimes(3);
    expect(requestedUrl(0).searchParams.get("starting_after")).toBeNull();
    expect(requestedUrl(1).searchParams.get("starting_after")).toBe("cur_1");
    expect(requestedUrl(2).searchParams.get("starting_after")).toBe("cur_2");
    expect(requestedUrl(2).searchParams.get("limit")).toBe("2");

    const output = JSON.parse(captured.out);
    expect(output.data.map((entry: { id: string }) => entry.id)).toEqual([
      "log_1",
      "log_2",
      "log_3",
    ]);
    expect(output.cursor.next).toBe("cur_3");
  });

  test("stops when the API reports no more pages", async () => {
    mockBapiRequest.mockResolvedValueOnce(
      page([makeLog("log_1")], { next_page_status: "false", starting_after: "cur_1" }),
    );

    await list({ json: true });

    expect(mockBapiRequest).toHaveBeenCalledTimes(1);
    expect(JSON.parse(captured.out).cursor.next).toBeNull();
  });

  test("stops with an error when the API repeats the cursor it was given", async () => {
    mockBapiRequest.mockResolvedValue(
      page([], { next_page_status: "unknown", starting_after: "cur_stuck" }),
    );

    await expect(list({ json: true, cursor: "cur_stuck" })).rejects.toThrow("same cursor twice");
    expect(mockBapiRequest).toHaveBeenCalledTimes(1);
  });

  test("returns the cursor to continue from after the request budget runs out", async () => {
    let request = 0;
    mockBapiRequest.mockImplementation(async () => {
      request += 1;
      return page([], { next_page_status: "unknown", starting_after: `cur_${request}` });
    });

    await list({ json: true });

    expect(mockBapiRequest).toHaveBeenCalledTimes(MAX_REQUESTS);
    const output = JSON.parse(captured.out);
    expect(output.data).toEqual([]);
    expect(output.cursor.next).toBe(`cur_${MAX_REQUESTS}`);
  });

  test("prints a { data, cursor } envelope with the searched range and retention", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(
        page([], {
          next_page_status: "unknown",
          starting_after: "cur_1",
          searched_from: 3_000,
          searched_to: 4_000,
        }),
      )
      .mockResolvedValueOnce(
        page([makeLog("log_1")], {
          next_page_status: "false",
          retention_limit_reached: true,
          retention_days: 7,
          searched_from: 1_000,
          searched_to: 3_000,
        }),
      );

    await list({ json: true });

    expect(JSON.parse(captured.out)).toEqual({
      data: [makeLog("log_1")],
      cursor: {
        next: null,
        retention_limit_reached: true,
        retention_days: 7,
        searched_from: 1_000,
        searched_to: 4_000,
      },
    });
  });

  test("prints JSON in agent mode without --json", async () => {
    mockIsAgent.mockReturnValue(true);

    await list();

    expect(JSON.parse(captured.out).data).toHaveLength(1);
    expect(captured.err).not.toContain("TIME");
  });

  test("prints a table and a summary pointing at the next cursor", async () => {
    mockBapiRequest.mockResolvedValueOnce(
      page([makeLog("log_1"), makeLog("log_2", { actor: "", type: "session.created" })], {
        next_page_status: "true",
        starting_after: "cur_next",
      }),
    );

    await list({ limit: 2 });

    expect(captured.out).toBe("");
    const plain = captured.err.replace(ANSI_ESCAPE_PATTERN, "");
    expect(plain).toMatch(/TIME\s+TYPE\s+ACTOR\s+SUBJECT\s+LOCATION\s+LOG ID/);
    expect(captured.err).toContain("user.created");
    expect(captured.err).toContain("session.created");
    expect(captured.err).toContain("Lima, PE");
    expect(captured.err).toContain("log_2");
    expect(captured.err).toContain("2 logs");
    expect(captured.err).toContain("--cursor cur_next");
  });

  test("warns when no logs are found", async () => {
    mockBapiRequest.mockResolvedValueOnce(page([], { next_page_status: "false" }));

    await list();

    expect(captured.err).toContain("No logs found.");
    expect(captured.err).not.toContain("--cursor");
  });

  test("warns when the plan's retention cut the results", async () => {
    mockBapiRequest.mockResolvedValueOnce(
      page([makeLog("log_1")], {
        next_page_status: "false",
        retention_limit_reached: true,
        retention_days: 7,
      }),
    );

    await list();

    expect(captured.err).toContain("Results only go back 7 days, your plan's log retention.");
  });

  test("propagates API errors from the first request without printing data", async () => {
    mockBapiRequest.mockRejectedValueOnce(new Error("boom"));

    await expect(list({ json: true })).rejects.toThrow("boom");
    expect(captured.out).toBe("");
  });

  test("propagates API errors when no logs were collected before the failure", async () => {
    const failure = new Error("boom");
    mockBapiRequest
      .mockResolvedValueOnce(page([], { next_page_status: "unknown", starting_after: "cur_1" }))
      .mockRejectedValueOnce(failure);

    await expect(list({ json: true })).rejects.toBe(failure);
    expect(captured.out).toBe("");
  });

  test("prints the logs already fetched as JSON when a later page fails", async () => {
    const failure = new Error("boom");
    mockBapiRequest
      .mockResolvedValueOnce(
        page([makeLog("log_1")], { next_page_status: "unknown", starting_after: "cur_1" }),
      )
      .mockRejectedValueOnce(failure);

    await expect(list({ json: true, limit: 5 })).rejects.toBe(failure);

    const output = JSON.parse(captured.out);
    expect(output.data.map((entry: { id: string }) => entry.id)).toEqual(["log_1"]);
    expect(output.cursor.next).toBe("cur_1");
    expect(requestedUrl(1).searchParams.get("starting_after")).toBe("cur_1");
  });

  test("prints the table and a warning when a later page fails", async () => {
    mockBapiRequest
      .mockResolvedValueOnce(
        page([makeLog("log_1")], { next_page_status: "unknown", starting_after: "cur_1" }),
      )
      .mockRejectedValueOnce(new Error("boom"));

    await expect(list({ limit: 5 })).rejects.toThrow("boom");

    expect(captured.out).toBe("");
    expect(captured.err).toContain("log_1");
    expect(captured.err).toContain("1 log");
    expect(captured.err).toContain("Listing stopped early because a request failed");
    expect(captured.err).toContain("--cursor cur_1");
  });
});

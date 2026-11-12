import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { BapiError, CliError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockBapiRequest = mock();
mock.module("../../lib/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));

const mockResolveBapiSecretKey = mock();
const mockDescribeBapiTarget = mock();
mock.module("../../lib/bapi-command.ts", () => ({
  resolveBapiSecretKey: (...args: unknown[]) => mockResolveBapiSecretKey(...args),
  describeBapiTarget: (...args: unknown[]) => mockDescribeBapiTarget(...args),
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

const { get, parseLogLookup, groupSubject } = await import("./get.ts");

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");
const GROUP_ID = "sua_2xYzAbC123";
const STARTED_AT = Date.UTC(2026, 10, 9, 15, 30, 0);

function makeLog(id: string, overrides: Record<string, unknown> = {}) {
  return {
    object: "log",
    id,
    event_time: STARTED_AT,
    type: "sign_up.created",
    actor: "",
    subject: "ins_123",
    group_id: GROUP_ID,
    group_type: "sign_up",
    group_started_at: STARTED_AT,
    event_context: {
      device: { ip_address: "203.0.113.7", location: { city: "Lima", country_code: "PE" } },
    },
    ...overrides,
  };
}

function page(data: unknown[], cursor: Record<string, unknown> = {}) {
  return { status: 200, headers: new Headers(), body: { data, cursor }, rawBody: "" };
}

function requestedUrl(call = 0): URL {
  const request = mockBapiRequest.mock.calls[call]?.[0] as { path: string };
  return new URL(request.path, "https://api.clerk.test");
}

function notFound(): BapiError {
  return new BapiError(
    404,
    JSON.stringify({ errors: [{ code: "resource_not_found", message: "not found" }] }),
    new Headers(),
  );
}

describe("parseLogLookup", () => {
  test.each<[string, "sign_in" | "sign_up"]>([
    ["sia_2xYzAbC123", "sign_in"],
    ["sua_2xYzAbC123", "sign_up"],
    ["  sia_abc  ", "sign_in"],
  ])("reads %p as a %s group", (raw, groupType) => {
    expect(parseLogLookup(raw)).toEqual({ kind: "group", id: raw.trim(), groupType });
  });

  test("reads a UUID as a log ID", () => {
    expect(parseLogLookup("019D8E31-A1BC-7E07-9347-0FD20B25C475")).toEqual({
      kind: "log",
      id: "019d8e31-a1bc-7e07-9347-0fd20b25c475",
    });
  });

  test.each([["sia_"], ["sua_"], ["sia_abc/def"], ["user_123"], ["sess_123"], ["hello"], ["1"]])(
    "rejects %p as a usage error listing the accepted forms",
    (raw) => {
      expect(() => parseLogLookup(raw)).toThrow(
        `Invalid ID "${raw}". Pass the ID of a log group: a sign-in ID (sia_…) or a sign-up ID (sua_…).`,
      );
    },
  );

  test.each([[undefined], [""], ["   "]])("asks for an ID when given %p", (raw) => {
    let caught: unknown;
    try {
      parseLogLookup(raw);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(2);
    expect((caught as CliError).message).toContain("Pass the ID of a log group");
  });
});

describe("groupSubject", () => {
  test("is the latest user a log is about", () => {
    expect(
      groupSubject([
        makeLog("a", { subject: "ins_1" }),
        makeLog("b", { subject: "user_1" }),
        makeLog("c", { subject: "user_2" }),
        makeLog("d", { subject: "ins_1" }),
      ] as never),
    ).toBe("user_2");
  });

  test("falls back to the first log's subject without a user", () => {
    expect(groupSubject([makeLog("a", { subject: "ins_1" })] as never)).toBe("ins_1");
  });

  test("is undefined without logs", () => {
    expect(groupSubject([])).toBeUndefined();
  });
});

describe("logs get", () => {
  const captured = useCaptureLog();
  let savedSecretKey: string | undefined;

  beforeEach(() => {
    savedSecretKey = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;
    mockIsAgent.mockReturnValue(false);
    mockResolveBapiSecretKey.mockResolvedValue("sk_test_123");
    mockDescribeBapiTarget.mockResolvedValue("my-app (development)");
    mockBapiRequest.mockResolvedValue(page([makeLog("log_1")], { next_page_status: "false" }));
  });

  afterEach(() => {
    if (savedSecretKey === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = savedSecretKey;
    mockBapiRequest.mockReset();
    mockResolveBapiSecretKey.mockReset();
    mockDescribeBapiTarget.mockReset();
    mockWithSpinner.mockClear();
    mockIsAgent.mockReset();
  });

  test("requests the group's events with the pinned API version, the default limit and no started_at", async () => {
    await get(GROUP_ID, { json: true });

    expect(mockBapiRequest).toHaveBeenCalledTimes(1);
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: `/logs/groups/${GROUP_ID}/events?limit=50`,
      secretKey: "sk_test_123",
      apiVersion: "2026-08-20",
    });
    expect(requestedUrl().searchParams.has("started_at")).toBe(false);
  });

  test("forwards targeting options when resolving the secret key", async () => {
    await get(GROUP_ID, { json: true, secretKey: "sk_test_x", app: "app_1", instance: "prod" });

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_x",
      app: "app_1",
      instance: "prod",
    });
  });

  test("wraps the request in a spinner", async () => {
    await get(GROUP_ID);

    expect(mockWithSpinner).toHaveBeenCalledWith("Fetching logs...", expect.any(Function));
  });

  test("passes --limit and --cursor (as starting_after) through", async () => {
    await get(GROUP_ID, { json: true, limit: 10, cursor: "cur_events" });

    const url = requestedUrl();
    expect(url.pathname).toBe(`/logs/groups/${GROUP_ID}/events`);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("starting_after")).toBe("cur_events");
  });

  test("sends the event filters", async () => {
    await get(GROUP_ID, {
      json: true,
      type: "sign_up.*",
      user: "user_123",
      payloadFilter: ["user_id=user_123"],
      fields: "user_id",
      endUserOnly: true,
    });

    const params = requestedUrl().searchParams;
    expect(params.get("type")).toBe("sign_up.*");
    expect(params.get("user_id")).toBe("user_123");
    expect(params.get("payload_filter[user_id]")).toBe("user_123");
    expect(params.get("payload_fields")).toBe("user_id");
    expect(params.get("end_user_facing_only")).toBe("true");
    expect(params.has("view")).toBe(false);
  });

  test("rejects invalid filters before resolving a key or calling the API", async () => {
    await expect(get(GROUP_ID, { user: "user_1", actor: "user_2" })).rejects.toThrow(
      "--user can't be combined with --actor.",
    );
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("rejects a log ID as not supported yet, before any request", async () => {
    let caught: unknown;
    try {
      await get("019d8e31-a1bc-7e07-9347-0fd20b25c475", { json: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(2);
    expect((caught as CliError).message).toBe(
      "Looking up a single log by its ID isn't supported yet. Pass the ID of a log group instead: a sign-in ID (sia_…) or a sign-up ID (sua_…).",
    );
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("rejects an invalid ID before any request", async () => {
    await expect(get("user_123", { json: true })).rejects.toThrow('Invalid ID "user_123"');
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("turns a 404 into a log-group-not-found error naming the targeted instance", async () => {
    mockBapiRequest.mockRejectedValueOnce(notFound());

    let caught: unknown;
    try {
      await get(GROUP_ID, { json: true, app: "app_1", instance: "dev" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe("log_group_not_found");
    expect((caught as CliError).message).toStartWith(
      `Log group not found: no log group ${GROUP_ID} in my-app (development).`,
    );
    expect(mockDescribeBapiTarget).toHaveBeenCalledWith({
      json: true,
      app: "app_1",
      instance: "dev",
    });
  });

  test("names the secret key's instance on a 404 when --secret-key picked it", async () => {
    mockBapiRequest.mockRejectedValueOnce(notFound());

    await expect(get(GROUP_ID, { json: true, secretKey: "sk_test_x" })).rejects.toThrow(
      `Log group not found: no log group ${GROUP_ID} in the instance of this secret key.`,
    );
    expect(mockDescribeBapiTarget).not.toHaveBeenCalled();
  });

  test("names the secret key's instance on a 404 when CLERK_SECRET_KEY picked it", async () => {
    process.env.CLERK_SECRET_KEY = "sk_test_env";
    mockBapiRequest.mockRejectedValueOnce(notFound());

    await expect(get(GROUP_ID, { json: true })).rejects.toThrow(
      "in the instance of this secret key.",
    );
    expect(mockDescribeBapiTarget).not.toHaveBeenCalled();
  });

  test("passes other API errors through", async () => {
    const error = new BapiError(
      422,
      JSON.stringify({ errors: [{ message: "bad" }] }),
      new Headers(),
    );
    mockBapiRequest.mockRejectedValueOnce(error);

    await expect(get(GROUP_ID, { json: true })).rejects.toBe(error);
  });

  test("rejects a body without a data array", async () => {
    mockBapiRequest.mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
      body: { cursor: {} },
      rawBody: "",
    });

    await expect(get(GROUP_ID, { json: true })).rejects.toThrow(
      "The Logs API returned an unexpected response.",
    );
  });

  test("prints a { data, cursor } envelope with a null next on the last page", async () => {
    await get(GROUP_ID, { json: true });

    expect(JSON.parse(captured.out)).toEqual({
      data: [makeLog("log_1")],
      cursor: { next: null },
    });
  });

  test("prints the next cursor when the group has more logs", async () => {
    mockBapiRequest.mockResolvedValueOnce(
      page([makeLog("log_1")], { next_page_status: "true", starting_after: "cur_next" }),
    );

    await get(GROUP_ID, { json: true, limit: 1 });

    expect(JSON.parse(captured.out).cursor).toEqual({ next: "cur_next" });
  });

  test("makes one request even when the group has more logs", async () => {
    mockBapiRequest.mockResolvedValueOnce(
      page([makeLog("log_1")], { next_page_status: "true", starting_after: "cur_next" }),
    );

    await get(GROUP_ID, { json: true, limit: 1 });

    expect(mockBapiRequest).toHaveBeenCalledTimes(1);
  });

  test("outputs JSON in agent mode", async () => {
    mockIsAgent.mockReturnValue(true);

    await get(GROUP_ID);

    expect(JSON.parse(captured.out).data).toHaveLength(1);
  });

  test("prints a header, the event table and the summary in human mode", async () => {
    mockBapiRequest.mockResolvedValueOnce(
      page(
        [
          makeLog("log_1"),
          makeLog("log_2", {
            type: "sign_up.completed",
            subject: "user_123",
            event_time: STARTED_AT + 1_000,
          }),
        ],
        { next_page_status: "true", starting_after: "cur_next" },
      ),
    );

    await get(GROUP_ID);

    expect(captured.out).toBe("");
    const err = captured.err.replace(ANSI_ESCAPE_PATTERN, "");
    const lines = err.split("\n");
    expect(lines).toContain(`sign_up ${GROUP_ID}`);
    expect(err).toContain("Subject user_123");
    expect(err).toMatch(/Started (\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}:\d{2}/);
    expect(err).toMatch(/TIME\s+TYPE\s+ACTOR\s+SUBJECT\s+LOCATION\s+LOG ID/);
    expect(err).toMatch(/sign_up\.created\s+-\s+ins_123\s+Lima, PE\s+log_1/);
    expect(err).toContain("sign_up.completed");
    expect(err).toContain("2 logs · more: re-run with `--cursor cur_next`");
  });

  test("adds a PAYLOAD column with the requested fields when --fields is set", async () => {
    mockBapiRequest.mockResolvedValueOnce(
      page([makeLog("log_1", { payload: { sign_up_id: GROUP_ID } })], {
        next_page_status: "false",
      }),
    );

    await get(GROUP_ID, { type: "sign_up.created", fields: "sign_up_id" });

    const err = captured.err.replace(ANSI_ESCAPE_PATTERN, "");
    expect(err).toMatch(/LOCATION\s+PAYLOAD\s+LOG ID/);
    expect(err).toContain(`sign_up_id=${GROUP_ID}`);
  });

  test("takes the group type from the ID prefix when no log is returned", async () => {
    mockBapiRequest.mockResolvedValueOnce(page([], { next_page_status: "false" }));

    await get("sia_abc");

    const err = captured.err.replace(ANSI_ESCAPE_PATTERN, "");
    expect(err.split("\n")).toContain("sign_in sia_abc");
    expect(err).toContain("No logs found.");
    expect(err).toContain("0 logs");
    expect(err).not.toContain("more:");
  });
});

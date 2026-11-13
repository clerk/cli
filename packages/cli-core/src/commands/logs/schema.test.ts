import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { BapiError, CliError, EXIT_CODE } from "../../lib/errors.ts";
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

const { schema, compareByGroup } = await import("./schema.ts");

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");
const plain = (value: string) => value.replace(ANSI_ESCAPE_PATTERN, "");

const CONCRETE_SCHEMA = {
  object: "log_schema",
  event_type: "sign_in.completed",
  description: "A user completed a sign-in.",
  severity: "success",
  docs_group: "sign_in",
  fields: [
    { path: "sign_in_id", type: "string", optional: false },
    { path: "strategy", type: "string", optional: true, enum: ["password", "email_code"] },
    { path: "attempts", type: "integer", optional: true },
  ],
};

const WILDCARD_SCHEMA = {
  object: "log_schema",
  event_type: "sign_in.*",
  matched_event_types: ["sign_in.completed", "sign_in.failed"],
  fields: [{ path: "sign_in_id", type: "string", optional: false }],
};

function response(body: unknown) {
  return { status: 200, headers: new Headers(), body, rawBody: "" };
}

function requestedUrl(): URL {
  const request = mockBapiRequest.mock.calls[0]?.[0] as { path: string };
  return new URL(request.path, "https://api.clerk.test");
}

describe("logs schema", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveBapiSecretKey.mockResolvedValue("sk_test_123");
    mockBapiRequest.mockResolvedValue(response(CONCRETE_SCHEMA));
  });

  afterEach(() => {
    mockBapiRequest.mockReset();
    mockResolveBapiSecretKey.mockReset();
    mockWithSpinner.mockClear();
    mockIsAgent.mockReset();
  });

  test("forwards targeting options when resolving the secret key", async () => {
    await schema("sign_in.completed", {
      json: true,
      secretKey: "sk_test_override",
      app: "app_123",
      instance: "prod",
    });

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_override",
      app: "app_123",
      instance: "prod",
    });
  });

  test("requests the schema with the pinned API version", async () => {
    await schema("sign_in.completed", { json: true });

    expect(mockBapiRequest).toHaveBeenCalledTimes(1);
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/logs/schemas?type=sign_in.completed",
      secretKey: "sk_test_123",
      apiVersion: "2026-08-20",
    });
  });

  test.each([
    ["a concrete type", "sign_in.completed", "type=sign_in.completed"],
    ["a wildcard", "sign_in.*", "type=sign_in.*"],
    ["a family name", "sign_in", "type=sign_in"],
  ])("passes %s through as-is", async (_label, eventType, query) => {
    await schema(eventType, { json: true });

    const url = requestedUrl();
    expect(url.pathname).toBe("/logs/schemas");
    expect(url.search).toBe(`?${query}`);
    expect(url.searchParams.get("type")).toBe(eventType);
  });

  test("wraps the network read in a spinner", async () => {
    await schema("sign_in.completed");

    expect(mockWithSpinner).toHaveBeenCalledWith("Fetching schema...", expect.any(Function));
  });

  test.each([
    ["an empty event type", "", "The event type is empty"],
    ["a blank event type", "  ", "The event type is empty"],
    ["a bare *", "*", "A wildcard needs an event type prefix"],
  ])(
    "rejects %s with a usage error before resolving a key or calling the API",
    async (_label, eventType, message) => {
      const error = await schema(eventType, { json: true }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain(message);
      expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
      expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
      expect(mockBapiRequest).not.toHaveBeenCalled();
    },
  );

  test("propagates the API's 422 for an unknown type with the schema context", async () => {
    const failure = new BapiError(
      422,
      JSON.stringify({
        errors: [{ code: "form_param_value_invalid", message: "unknown event type nope.created" }],
      }),
      new Headers(),
    );
    mockBapiRequest.mockRejectedValueOnce(failure);

    await expect(schema("nope.created", { json: true })).rejects.toBe(failure);
    expect(failure.context).toBe("Failed to read the log schema");
    expect(captured.out).toBe("");
  });

  test.each([
    { label: "null", body: null },
    { label: "a string", body: "<html>" },
    { label: "an array", body: [] },
  ])("fails when the response body is $label", async ({ body }) => {
    mockBapiRequest.mockResolvedValueOnce(response(body));

    await expect(schema("sign_in.completed", { json: true })).rejects.toThrow(
      "The Logs API returned an unexpected response.",
    );
    expect(captured.out).toBe("");
  });

  test.each([
    ["fields is not an array", { ...CONCRETE_SCHEMA, fields: "sign_in_id" }],
    ["a field has no path", { ...CONCRETE_SCHEMA, fields: [{ type: "string", optional: false }] }],
    [
      "a field's enum is not an array",
      {
        ...CONCRETE_SCHEMA,
        fields: [{ path: "strategy", type: "string", optional: true, enum: "password" }],
      },
    ],
    [
      "matched_event_types is not an array",
      { ...WILDCARD_SCHEMA, matched_event_types: "sign_in.completed" },
    ],
    ["event_type is missing", { object: "log_schema", fields: [] }],
  ])("fails with the unexpected-response error when %s", async (_label, body) => {
    mockBapiRequest.mockResolvedValueOnce(response(body));

    await expect(schema("sign_in.completed")).rejects.toThrow(
      "The Logs API returned an unexpected response.",
    );
    expect(plain(captured.err)).not.toContain("PATH");
  });

  test("prints a malformed object as-is with --json", async () => {
    const body = { ...CONCRETE_SCHEMA, fields: "sign_in_id" };
    mockBapiRequest.mockResolvedValueOnce(response(body));

    await schema("sign_in.completed", { json: true });

    expect(JSON.parse(captured.out)).toEqual(body);
  });

  test("treats missing fields as no fields", async () => {
    const { fields: _fields, ...body } = CONCRETE_SCHEMA;
    mockBapiRequest.mockResolvedValueOnce(response(body));

    await schema("sign_in.completed");

    expect(plain(captured.err)).toContain("This event type has no payload fields.");
  });

  test.each([
    ["a concrete type", CONCRETE_SCHEMA],
    ["a wildcard", WILDCARD_SCHEMA],
  ])("prints the log_schema object as-is for %s with --json", async (_label, body) => {
    mockBapiRequest.mockResolvedValueOnce(response(body));

    await schema(body.event_type, { json: true });

    expect(JSON.parse(captured.out)).toEqual(body);
  });

  test("prints JSON in agent mode without --json", async () => {
    mockIsAgent.mockReturnValue(true);

    await schema("sign_in.completed");

    expect(JSON.parse(captured.out)).toEqual(CONCRETE_SCHEMA);
    expect(captured.err).not.toContain("PATH");
  });

  test("prints a header with the event type, description and severity", async () => {
    await schema("sign_in.completed");

    expect(captured.out).toBe("");
    const err = plain(captured.err);
    expect(err).toContain("sign_in.completed");
    expect(err).toContain("A user completed a sign-in.");
    expect(err).toContain("Severity: success");
    expect(err).not.toContain("Matches:");
  });

  test("prints a PATH / TYPE / OPTIONAL / ENUM table", async () => {
    await schema("sign_in.completed");

    const err = plain(captured.err);
    expect(err).toMatch(/PATH\s+TYPE\s+OPTIONAL\s+ENUM/);
    expect(err).toMatch(/sign_in_id\s+string\s+no\s+-/);
    expect(err).toMatch(/strategy\s+string\s+yes\s+password, email_code/);
    expect(err).toMatch(/attempts\s+integer\s+yes\s+-/);
  });

  test("lists the matched event types for a wildcard", async () => {
    mockBapiRequest.mockResolvedValueOnce(response(WILDCARD_SCHEMA));

    await schema("sign_in.*");

    const err = plain(captured.err);
    expect(err).toContain("Matches: sign_in.completed, sign_in.failed");
    expect(err).not.toContain("Severity:");
  });

  test("ends with a hint to filter on the first field", async () => {
    await schema("sign_in.completed");

    expect(plain(captured.err)).toContain(
      "→ Filter on a field: clerk logs list --type sign_in.completed --payload-filter 'sign_in_id=<value>'",
    );
  });

  test("quotes a wildcard event type in the hint", async () => {
    mockBapiRequest.mockResolvedValueOnce(response(WILDCARD_SCHEMA));

    await schema("sign_in.*");

    expect(plain(captured.err)).toContain("clerk logs list --type 'sign_in.*' --payload-filter");
  });

  test.each([
    [
      "a concrete type",
      { ...CONCRETE_SCHEMA, fields: [] },
      "This event type has no payload fields.",
    ],
    [
      "a wildcard",
      { ...WILDCARD_SCHEMA, fields: [] },
      "The matched event types share no payload fields.",
    ],
  ])("says so when %s has no fields", async (_label, body, message) => {
    mockBapiRequest.mockResolvedValueOnce(response(body));

    await schema(body.event_type);

    const err = plain(captured.err);
    expect(err).toContain(message);
    expect(err).not.toContain("PATH");
    expect(err).not.toContain("--payload-filter");
  });
});

const CATALOG = {
  object: "list",
  data: [
    {
      object: "log_schema",
      event_type: "session.created",
      description: "A session was created.",
      severity: "info",
      docs_group: "session",
      fields: [{ path: "session_id", type: "string", optional: false }],
    },
    {
      object: "log_schema",
      event_type: "sign_in.failed",
      description: "A sign-in attempt failed.",
      severity: "warning",
      docs_group: "sign_in",
      fields: [{ path: "reason", type: "string", optional: true, enum: ["bad_password"] }],
    },
    {
      object: "log_schema",
      event_type: "user.created",
      description: "A user was created.",
      severity: "success",
      docs_group: "auth",
      fields: [{ path: "user_id", type: "string", optional: false }],
    },
    {
      object: "log_schema",
      event_type: "sign_in.completed",
      description: "A user completed a sign-in.",
      severity: "success",
      docs_group: "sign_in",
      fields: [],
    },
    {
      object: "log_schema",
      event_type: "aaa.ungrouped",
      fields: [],
    },
  ],
  total_count: 5,
};

describe("logs schema (no event type)", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveBapiSecretKey.mockResolvedValue("sk_test_123");
    mockBapiRequest.mockResolvedValue(response(CATALOG));
  });

  afterEach(() => {
    mockBapiRequest.mockReset();
    mockResolveBapiSecretKey.mockReset();
    mockWithSpinner.mockClear();
    mockIsAgent.mockReset();
  });

  test("requests GET /logs/types with the pinned API version", async () => {
    await schema(undefined, { json: true });

    expect(mockBapiRequest).toHaveBeenCalledTimes(1);
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/logs/types",
      secretKey: "sk_test_123",
      apiVersion: "2026-08-20",
    });
  });

  test("forwards targeting options when resolving the secret key", async () => {
    await schema(undefined, { json: true, secretKey: "sk_live_1", app: "app_1", instance: "prod" });

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_live_1",
      app: "app_1",
      instance: "prod",
    });
  });

  test("wraps the network read in a spinner", async () => {
    await schema(undefined);

    expect(mockWithSpinner).toHaveBeenCalledWith("Fetching event types...", expect.any(Function));
  });

  test("prints the catalog as-is with --json, fields included", async () => {
    await schema(undefined, { json: true });

    expect(JSON.parse(captured.out)).toEqual(CATALOG);
    expect(captured.err).not.toContain("TYPE");
  });

  test("prints JSON in agent mode without --json", async () => {
    mockIsAgent.mockReturnValue(true);

    await schema(undefined);

    expect(JSON.parse(captured.out)).toEqual(CATALOG);
  });

  test("prints a TYPE / GROUP / DESCRIPTION table on stderr, without fields", async () => {
    await schema(undefined);

    expect(captured.out).toBe("");
    const err = plain(captured.err);
    expect(err).toMatch(/TYPE\s+GROUP\s+DESCRIPTION/);
    expect(err).toMatch(/sign_in\.completed\s+sign_in\s+A user completed a sign-in\./);
    expect(err).toMatch(/aaa\.ungrouped\s+-/);
    expect(err).not.toContain("PATH");
    expect(err).not.toContain("session_id");
  });

  test("sorts by group, then by type, with ungrouped types last", async () => {
    await schema(undefined);

    const rows = plain(captured.err)
      .split("\n")
      .map((line) => line.split(/\s+/)[0])
      .filter((first) => first?.includes("."));
    expect(rows).toEqual([
      "user.created",
      "session.created",
      "sign_in.completed",
      "sign_in.failed",
      "aaa.ungrouped",
    ]);
  });

  test.each([
    [
      "the same group, by type",
      { docs_group: "a", event_type: "a.b" },
      { docs_group: "a", event_type: "a.c" },
      -1,
    ],
    [
      "different groups, by group",
      { docs_group: "b", event_type: "a.a" },
      { docs_group: "a", event_type: "z.z" },
      1,
    ],
    [
      "an ungrouped type after a grouped one",
      { event_type: "a.a" },
      { docs_group: "z", event_type: "z.z" },
      1,
    ],
    [
      "two identical entries",
      { docs_group: "a", event_type: "a.a" },
      { docs_group: "a", event_type: "a.a" },
      0,
    ],
  ])("compareByGroup orders %s", (_label, a, b, expected) => {
    const entry = (fields: object) => ({ object: "log_schema" as const, fields: [], ...fields });
    expect(Math.sign(compareByGroup(entry(a) as never, entry(b) as never))).toBe(expected);
  });

  test("ends with the count and a hint to see a type's fields", async () => {
    await schema(undefined);

    const err = plain(captured.err);
    expect(err).toContain("5 event types");
    expect(err).toContain("→ See a type's fields: clerk logs schema <event-type>");
  });

  test("says event type, singular, for one", async () => {
    mockBapiRequest.mockResolvedValueOnce(
      response({ ...CATALOG, data: [CATALOG.data[0]], total_count: 1 }),
    );

    await schema(undefined);

    expect(plain(captured.err)).toContain("1 event type\n");
  });

  test("says so when the catalog is empty", async () => {
    mockBapiRequest.mockResolvedValueOnce(response({ object: "list", data: [], total_count: 0 }));

    await schema(undefined);

    const err = plain(captured.err);
    expect(err).toContain("The instance has no event types to list.");
    expect(err).not.toContain("TYPE");
  });

  test.each([
    { label: "null", body: null },
    { label: "a string", body: "<html>" },
    { label: "an array", body: [] },
    { label: "an object without data", body: { object: "list" } },
    { label: "data that is not an array", body: { object: "list", data: {} } },
    { label: "data with a non-object item", body: { object: "list", data: ["user.created"] } },
    { label: "data with a null item", body: { object: "list", data: [null] } },
  ])("fails in both modes when the response is $label", async ({ body }) => {
    mockBapiRequest.mockResolvedValue(response(body));

    await expect(schema(undefined, { json: true })).rejects.toThrow(
      "The Logs API returned an unexpected response.",
    );
    await expect(schema(undefined)).rejects.toThrow(
      "The Logs API returned an unexpected response.",
    );
    expect(captured.out).toBe("");
  });

  test("fails the table, but not --json, when an entry has no event_type", async () => {
    const body = { object: "list", data: [{ object: "log_schema", fields: [] }], total_count: 1 };
    mockBapiRequest.mockResolvedValue(response(body));

    await expect(schema(undefined)).rejects.toThrow(
      "The Logs API returned an unexpected response.",
    );
    expect(plain(captured.err)).not.toContain("TYPE");

    await schema(undefined, { json: true });
    expect(JSON.parse(captured.out)).toEqual(body);
  });

  test("turns a 404 into an error saying the API can't list event types yet", async () => {
    mockBapiRequest.mockRejectedValueOnce(
      new BapiError(
        404,
        JSON.stringify({ errors: [{ code: "resource_not_found", message: "not found" }] }),
        new Headers(),
      ),
    );

    const error = await schema(undefined, { json: true }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliError);
    expect(error).not.toBeInstanceOf(BapiError);
    expect((error as CliError).message).toContain("can't list event types yet");
    expect((error as CliError).message).toContain("clerk logs schema sign_in.completed");
    expect(captured.out).toBe("");
  });

  test.each([401, 403, 429, 500])("propagates a %d with the list context", async (status) => {
    const failure = new BapiError(
      status,
      JSON.stringify({ errors: [{ code: "x", message: `failed with ${status}` }] }),
      new Headers(),
    );
    mockBapiRequest.mockRejectedValueOnce(failure);

    await expect(schema(undefined, { json: true })).rejects.toBe(failure);
    expect(failure.context).toBe("Failed to list the log event types");
    expect(captured.out).toBe("");
  });
});

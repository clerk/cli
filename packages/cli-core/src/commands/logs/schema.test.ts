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

const { schema } = await import("./schema.ts");

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
    ["no event type", undefined, "Pass an event type"],
    ["an empty event type", "  ", "Pass an event type"],
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
      "→ Filter on a field: clerk logs --type sign_in.completed --payload-filter 'sign_in_id=<value>'",
    );
  });

  test("quotes a wildcard event type in the hint", async () => {
    mockBapiRequest.mockResolvedValueOnce(response(WILDCARD_SCHEMA));

    await schema("sign_in.*");

    expect(plain(captured.err)).toContain("clerk logs --type 'sign_in.*' --payload-filter");
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

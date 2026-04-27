import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { popPrefix, pushPrefix } from "../../lib/log.ts";
import { captureLog } from "../../test/lib/stubs.ts";

const mockBapiRequest = mock();
mock.module("../../commands/api/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));

const mockResolveBapiSecretKey = mock();
mock.module("../../lib/bapi-command.ts", () => ({
  resolveBapiSecretKey: (...args: unknown[]) => mockResolveBapiSecretKey(...args),
}));

const mockResolveUsersInstanceContext = mock();
mock.module("./interactive/instance-context.ts", () => ({
  resolveUsersInstanceContext: (...args: unknown[]) => mockResolveUsersInstanceContext(...args),
}));

const mockWithSpinner = mock((_msg: string, fn: () => Promise<unknown>) => fn());
mock.module("../../lib/spinner.ts", () => ({
  withSpinner: (...args: Parameters<typeof mockWithSpinner>) => mockWithSpinner(...args),
}));

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

const { list } = await import("./list.ts");

const mockUsers = [
  {
    id: "user_123",
    first_name: "Alice",
    last_name: "Example",
    username: "alice",
    primary_email_address_id: "idn_1",
    email_addresses: [
      {
        id: "idn_1",
        email_address: "alice@example.com",
      },
    ],
  },
  {
    id: "user_456",
    username: "bob",
    phone_numbers: [
      {
        id: "phn_1",
        phone_number: "+15551234567",
      },
    ],
  },
];

describe("users list", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveBapiSecretKey.mockResolvedValue("sk_test_123");
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { data: mockUsers, totalCount: mockUsers.length },
      rawBody: JSON.stringify({ data: mockUsers, totalCount: mockUsers.length }),
    });
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    captured = captureLog();
  });

  afterEach(() => {
    captured.teardown();
    mockBapiRequest.mockReset();
    mockResolveBapiSecretKey.mockReset();
    mockResolveUsersInstanceContext.mockReset();
    mockWithSpinner.mockReset();
    mockWithSpinner.mockImplementation((_msg: string, fn: () => Promise<unknown>) => fn());
    mockIsAgent.mockReset();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function runList(options: Parameters<typeof list>[0] = {}) {
    return captured.run(() => list(options));
  }

  test("forwards targeting options when resolving the secret key", async () => {
    await runList({ json: true, secretKey: "sk_test_override", app: "app_123", instance: "prod" });

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_override",
      app: "app_123",
      instance: "prod",
    });
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/users",
      secretKey: "sk_test_123",
    });
  });

  test("wraps the network read in the standard users list spinner", async () => {
    await runList();

    expect(mockWithSpinner).toHaveBeenCalledWith("Fetching users...", expect.any(Function));
  });

  test("serializes common filters and pagination into query params", async () => {
    await runList({
      query: "alice",
      emailAddress: ["alice@example.com", "admin@example.com"],
      phoneNumber: ["+15551234567"],
      username: ["alice-user"],
      userId: ["user_123", "user_456"],
      externalId: ["ext_123"],
      orderBy: "-last_sign_in_at",
      limit: 25,
      offset: 50,
    });

    const request = mockBapiRequest.mock.calls[0]?.[0] as { path: string } | undefined;
    expect(request).toBeDefined();

    const url = new URL(request!.path, "https://api.clerk.test");
    expect(url.pathname).toBe("/users");
    expect(url.searchParams.get("query")).toBe("alice");
    expect(url.searchParams.getAll("email_address")).toEqual([
      "alice@example.com",
      "admin@example.com",
    ]);
    expect(url.searchParams.getAll("phone_number")).toEqual(["+15551234567"]);
    expect(url.searchParams.getAll("username")).toEqual(["alice-user"]);
    expect(url.searchParams.getAll("user_id")).toEqual(["user_123", "user_456"]);
    expect(url.searchParams.getAll("external_id")).toEqual(["ext_123"]);
    expect(url.searchParams.get("order_by")).toBe("-last_sign_in_at");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("offset")).toBe("50");
  });

  test("reads users from Clerk's paginated response shape", async () => {
    await runList();

    expect(captured.out).toContain("Alice Example");
    expect(captured.out).toContain("bob");
  });

  test("prints a concise human-readable table by default", async () => {
    await runList();

    expect(captured.out).toContain("Alice Example");
    expect(captured.out).toContain("alice@example.com");
    expect(captured.out).toContain("user_123");
    expect(captured.out).toContain("bob");
    expect(captured.out).toContain("+15551234567");
    expect(captured.err).toContain("2 users");
  });

  test("prints a helpful message when no users are returned", async () => {
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { data: [], totalCount: 0 },
      rawBody: JSON.stringify({ data: [], totalCount: 0 }),
    });

    await runList();

    expect(captured.out).toBe("");
    expect(captured.err).toContain("No users found");
  });

  test("outputs JSON when requested", async () => {
    await runList({ json: true });

    expect(JSON.parse(captured.out)).toEqual({
      data: mockUsers,
      totalCount: mockUsers.length,
    });
    expect(captured.err).toBe("");
  });

  test("outputs JSON in agent mode", async () => {
    mockIsAgent.mockReturnValue(true);

    await runList();

    expect(JSON.parse(captured.out)).toEqual({
      data: mockUsers,
      totalCount: mockUsers.length,
    });
  });

  test("falls back to the shared picker-aware resolver in human mode when no credentials resolve", async () => {
    mockResolveBapiSecretKey.mockRejectedValue(
      new CliError("No secret key found.", { code: ERROR_CODE.NO_SECRET_KEY }),
    );
    mockResolveUsersInstanceContext.mockResolvedValue({ secretKey: "sk_test_picked" });

    await runList();

    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({});
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/users",
      secretKey: "sk_test_picked",
    });
  });

  test("routes the table to stderr (under the gutter) when invoked inside an intro/outro block", async () => {
    pushPrefix();
    try {
      await runList();
    } finally {
      popPrefix();
    }

    expect(captured.out).toBe("");
    expect(captured.err).toContain("Alice Example");
    expect(captured.err).toContain("user_123");
    expect(captured.err).toContain("alice@example.com");
    expect(captured.err).toContain("2 users");
  });

  test("re-throws the original NO_SECRET_KEY error in agent mode without invoking the picker", async () => {
    mockIsAgent.mockReturnValue(true);
    const original = new CliError("No secret key found.", { code: ERROR_CODE.NO_SECRET_KEY });
    mockResolveBapiSecretKey.mockRejectedValue(original);

    await expect(runList()).rejects.toBe(original);
    expect(mockResolveUsersInstanceContext).not.toHaveBeenCalled();
  });

  test.each([
    { label: "--app", options: { app: "app_123" } },
    { label: "--instance", options: { instance: "prod" } },
    { label: "--secret-key", options: { secretKey: "sk_test_explicit" } },
  ])(
    "re-throws NO_SECRET_KEY without invoking the picker when $label is set",
    async ({ options }) => {
      const original = new CliError("No secret key found.", { code: ERROR_CODE.NO_SECRET_KEY });
      mockResolveBapiSecretKey.mockRejectedValue(original);

      await expect(runList(options)).rejects.toBe(original);
      expect(mockResolveUsersInstanceContext).not.toHaveBeenCalled();
    },
  );
});

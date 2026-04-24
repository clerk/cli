import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { captureLog } from "../../test/lib/stubs.ts";

const mockBapiRequest = mock();
mock.module("../../commands/api/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));

const mockResolveBapiSecretKey = mock();
mock.module("../../lib/bapi-command.ts", () => ({
  resolveBapiSecretKey: (...args: unknown[]) => mockResolveBapiSecretKey(...args),
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

const { get } = await import("./get.ts");

const mockUser = {
  id: "user_123",
  first_name: "Alice",
  last_name: "Example",
  username: "alice",
  image_url: "https://img.example/alice.png",
  primary_email_address_id: "idn_1",
  email_addresses: [
    {
      id: "idn_1",
      email_address: "alice@example.com",
    },
  ],
};

describe("users get", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveBapiSecretKey.mockResolvedValue("sk_test_123");
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: mockUser,
      rawBody: JSON.stringify(mockUser),
    });
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    captured = captureLog();
  });

  afterEach(() => {
    captured.teardown();
    mockBapiRequest.mockReset();
    mockResolveBapiSecretKey.mockReset();
    mockWithSpinner.mockReset();
    mockWithSpinner.mockImplementation((_msg: string, fn: () => Promise<unknown>) => fn());
    mockIsAgent.mockReset();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function runGet(userId = "user_123", options: Parameters<typeof get>[1] = {}) {
    return captured.run(() => get(userId, options));
  }

  test("forwards targeting options when resolving the secret key", async () => {
    await runGet("user_123", {
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
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/users/user_123",
      secretKey: "sk_test_123",
    });
  });

  test("wraps the network read in the standard user fetch spinner", async () => {
    await runGet();

    expect(mockWithSpinner).toHaveBeenCalledWith("Fetching user...", expect.any(Function));
  });

  test("prints concise human-readable details by default", async () => {
    await runGet();

    expect(captured.out).toContain("Alice Example");
    expect(captured.out).toContain("user_123");
    expect(captured.out).toContain("alice@example.com");
    expect(captured.out).toContain("alice");
    expect(captured.err).toBe("");
  });

  test("outputs JSON when requested", async () => {
    await runGet("user_123", { json: true });

    expect(JSON.parse(captured.out)).toEqual(mockUser);
    expect(captured.err).toBe("");
  });

  test("outputs JSON in agent mode", async () => {
    mockIsAgent.mockReturnValue(true);

    await runGet();

    expect(JSON.parse(captured.out)).toEqual(mockUser);
  });
});

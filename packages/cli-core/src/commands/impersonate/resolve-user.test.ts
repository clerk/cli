import { test, expect, describe, beforeEach } from "bun:test";
import { setMode } from "../../mode.ts";
import { CliError } from "../../lib/errors.ts";
import { mock } from "bun:test";

const mockBapiRequest = mock();
mock.module("../../lib/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));

const mockPickUser = mock();
mock.module("../users/interactive/pick-user.ts", () => ({
  pickUser: (...args: unknown[]) => mockPickUser(...args),
}));

const { resolveImpersonationTarget } = await import("./resolve-user.ts");

describe("resolveImpersonationTarget", () => {
  beforeEach(() => {
    setMode("human");
    mockBapiRequest.mockReset();
    mockPickUser.mockReset();
  });

  test("uses a user_xxx argument directly without calling BAPI", async () => {
    const result = await resolveImpersonationTarget("user_2x9k", { secretKey: "sk_test_123" });
    expect(result).toBe("user_2x9k");
    expect(mockBapiRequest).not.toHaveBeenCalled();
    expect(mockPickUser).not.toHaveBeenCalled();
  });

  test("searches by exact email_address filter when the argument contains '@'", async () => {
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: [{ id: "user_alice" }],
      rawBody: "",
    });

    const result = await resolveImpersonationTarget("alice@example.com", {
      secretKey: "sk_test_123",
    });

    expect(result).toBe("user_alice");
    expect(mockBapiRequest.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/users?email_address=alice%40example.com&limit=6",
      secretKey: "sk_test_123",
    });
  });

  test("searches by fuzzy query when the argument has no '@'", async () => {
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: [{ id: "user_bob" }],
      rawBody: "",
    });

    await resolveImpersonationTarget("bob", { secretKey: "sk_test_123" });

    expect(mockBapiRequest.mock.calls[0]?.[0]).toMatchObject({
      path: "/users?query=bob&limit=6",
    });
  });

  test("throws a usage error when zero users match", async () => {
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: [],
      rawBody: "",
    });

    await expect(
      resolveImpersonationTarget("nobody@example.com", { secretKey: "sk_test_123" }),
    ).rejects.toThrow(/no user found matching "nobody@example.com"/i);
  });

  test("names the searched app and instance in the zero-match error when known", async () => {
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: [],
      rawBody: "",
    });

    await expect(
      resolveImpersonationTarget("nobody@example.com", {
        secretKey: "sk_test_123",
        appLabel: "My Application",
        instanceLabel: "development",
      }),
    ).rejects.toThrow(
      /no user found matching "nobody@example.com" on My Application \(development\)/i,
    );
  });

  test("human mode: opens the picker (no prefilled query) when 2+ users match", async () => {
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: [{ id: "user_a" }, { id: "user_b" }],
      rawBody: "",
    });
    mockPickUser.mockResolvedValue("user_a");

    const result = await resolveImpersonationTarget("smith", { secretKey: "sk_test_123" });

    expect(result).toBe("user_a");
    expect(mockPickUser).toHaveBeenCalledWith(
      expect.objectContaining({ secretKey: "sk_test_123" }),
    );
  });

  test("agent mode: throws a usage error listing candidate user IDs when 2+ users match", async () => {
    setMode("agent");
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: [{ id: "user_a" }, { id: "user_b" }],
      rawBody: "",
    });

    await expect(resolveImpersonationTarget("smith", { secretKey: "sk_test_123" })).rejects.toThrow(
      /user_a, user_b/,
    );
    expect(mockPickUser).not.toHaveBeenCalled();
  });

  test("human mode: no argument opens the picker", async () => {
    mockPickUser.mockResolvedValue("user_picked");

    const result = await resolveImpersonationTarget(undefined, { secretKey: "sk_test_123" });

    expect(result).toBe("user_picked");
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("agent mode: no argument throws a usage error instead of prompting", async () => {
    setMode("agent");

    await expect(
      resolveImpersonationTarget(undefined, { secretKey: "sk_test_123" }),
    ).rejects.toThrow(CliError);
    expect(mockPickUser).not.toHaveBeenCalled();
  });
});

import { test, expect, describe, beforeEach, mock } from "bun:test";

const mockBapiRequest = mock();
const mockSearch = mock();

mock.module("../../api/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));
mock.module("../../../lib/listage.ts", () => ({
  search: (...args: unknown[]) => mockSearch(...args),
  filterChoices: () => [],
  Separator: class {},
}));

const { pickUser, formatUserChoice } = await import("./pick-user.ts");

describe("pickUser", () => {
  beforeEach(() => {
    mockBapiRequest.mockReset();
    mockSearch.mockReset();
  });

  test("calls bapiRequest with /users?query=...&limit=21 when source is invoked", async () => {
    let capturedSource:
      | ((term: string | undefined, opt: { signal: AbortSignal }) => Promise<unknown[]>)
      | undefined;
    mockSearch.mockImplementation(async (config: { source: typeof capturedSource }) => {
      capturedSource = config.source;
      return "user_picked";
    });
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: [{ id: "user_1", first_name: "Alice", email_addresses: [{ email_address: "a@b.co" }] }],
      rawBody: "[]",
    });

    const result = await pickUser({ secretKey: "sk_test_xyz" });
    expect(result).toBe("user_picked");

    const choices = await capturedSource!("ali", { signal: new AbortController().signal });
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: expect.stringContaining("/users?query=ali"),
      secretKey: "sk_test_xyz",
    });
    const requestPath = (mockBapiRequest.mock.calls[0]?.[0] as { path: string } | undefined)?.path;
    expect(requestPath).toContain("limit=21");
    expect(choices).toHaveLength(1);
    expect((choices[0] as { value: string }).value).toBe("user_1");
  });

  test("appends a refine-search separator when results overflow the picker limit", async () => {
    let capturedSource:
      | ((term: string | undefined, opt: { signal: AbortSignal }) => Promise<unknown[]>)
      | undefined;
    mockSearch.mockImplementation(async (config: { source: typeof capturedSource }) => {
      capturedSource = config.source;
      return "user_picked";
    });
    const overflow = Array.from({ length: 21 }, (_, i) => ({
      id: `user_${i}`,
      first_name: `User${i}`,
      email_addresses: [{ email_address: `u${i}@example.com` }],
    }));
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: overflow,
      rawBody: JSON.stringify(overflow),
    });

    await pickUser({ secretKey: "sk_test_xyz" });

    const choices = await capturedSource!(undefined, { signal: new AbortController().signal });
    // 20 user choices plus the trailing separator hint.
    expect(choices).toHaveLength(21);
    expect((choices[19] as { value: string }).value).toBe("user_19");
    expect((choices[20] as { value?: string }).value).toBeUndefined();
  });
});

describe("formatUserChoice", () => {
  test("renders name + email + id", () => {
    expect(
      formatUserChoice({
        id: "user_1",
        first_name: "Alice",
        last_name: "Smith",
        email_addresses: [{ email_address: "a@example.com" }],
      }),
    ).toBe("Alice Smith (a@example.com) — user_1");
  });

  test("falls back to email when no name", () => {
    expect(
      formatUserChoice({
        id: "user_2",
        email_addresses: [{ email_address: "b@example.com" }],
      }),
    ).toBe("b@example.com (b@example.com) — user_2");
  });

  test("falls back to user_id when no name or email", () => {
    expect(formatUserChoice({ id: "user_3" })).toBe("user_3 (no email) — user_3");
  });
});

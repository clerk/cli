import { test, expect, describe, beforeEach, mock } from "bun:test";

const mockBapiRequest = mock();
mock.module("./bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));

const { createActorToken, revokeActorToken } = await import("./actor-tokens.ts");

describe("createActorToken", () => {
  beforeEach(() => {
    mockBapiRequest.mockReset();
  });

  test("POSTs the snake_case actor-token contract and returns the typed token", async () => {
    mockBapiRequest.mockResolvedValue({ body: { id: "act_1", url: "https://example.com/ticket" } });

    const token = await createActorToken("sk_test_123", {
      userId: "user_2x9k",
      actor: { sub: "cli:admin@example.com", iss: "clerk-cli" },
      expiresInSeconds: 900,
    });

    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/actor_tokens",
      secretKey: "sk_test_123",
      body: JSON.stringify({
        user_id: "user_2x9k",
        actor: { sub: "cli:admin@example.com", iss: "clerk-cli" },
        expires_in_seconds: 900,
      }),
    });
    expect(token).toEqual({ id: "act_1", url: "https://example.com/ticket" });
  });
});

describe("revokeActorToken", () => {
  beforeEach(() => {
    mockBapiRequest.mockReset();
  });

  test("POSTs to the revoke path and returns the parsed body", async () => {
    mockBapiRequest.mockResolvedValue({ body: { id: "act_1", status: "revoked" } });

    const result = await revokeActorToken("sk_test_123", "act_1");

    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/actor_tokens/act_1/revoke",
      secretKey: "sk_test_123",
    });
    expect(result).toEqual({ id: "act_1", status: "revoked" });
  });
});

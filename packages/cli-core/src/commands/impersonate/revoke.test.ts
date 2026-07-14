import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { setMode } from "../../mode.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import { BapiError, CliError, ERROR_CODE } from "../../lib/errors.ts";

const mockRequireLoginEmail = mock();
mock.module("./actor.ts", () => ({
  requireLoginEmail: (...args: unknown[]) => mockRequireLoginEmail(...args),
  buildActorStamp: (loginEmail: string) => ({ sub: `cli:${loginEmail}`, iss: "clerk-cli" }),
}));

const mockResolveUsersInstanceContext = mock();
mock.module("../users/interactive/instance-context.ts", () => ({
  resolveUsersInstanceContext: (...args: unknown[]) => mockResolveUsersInstanceContext(...args),
}));

const mockBapiRequest = mock();
mock.module("../../lib/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));

mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  pausedOutro: () => {},
  bar: () => {},
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { revoke } = await import("./revoke.ts");

const CTX = {
  secretKey: "sk_test_123",
  appId: "app_abc123",
  appLabel: "My App",
  instanceId: "ins_dev789",
  instanceLabel: "development",
};

describe("revoke", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    setMode("human");
    mockRequireLoginEmail.mockResolvedValue("admin@example.com");
    mockResolveUsersInstanceContext.mockResolvedValue(CTX);
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { id: "act_1", status: "revoked" },
      rawBody: "",
    });
  });

  afterEach(() => {
    mockRequireLoginEmail.mockReset();
    mockResolveUsersInstanceContext.mockReset();
    mockBapiRequest.mockReset();
  });

  test("hard-fails before touching BAPI when not logged in", async () => {
    mockRequireLoginEmail.mockRejectedValue(
      new CliError("Not logged in. Run `clerk auth login` to authenticate", {
        code: ERROR_CODE.AUTH_REQUIRED,
      }),
    );

    await expect(revoke({ actorTokenId: "act_1" })).rejects.toThrow(/Not logged in/);
    expect(mockResolveUsersInstanceContext).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("calls POST /actor_tokens/{id}/revoke against the resolved secret key", async () => {
    await revoke({ actorTokenId: "act_1" });

    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/actor_tokens/act_1/revoke",
      secretKey: CTX.secretKey,
    });
  });

  test("human mode: prints a success message to stderr", async () => {
    await revoke({ actorTokenId: "act_1" });
    expect(captured.err).toContain("Revoked actor token act_1.");
  });

  test("agent mode: emits structured JSON with the token id and status", async () => {
    setMode("agent");
    await revoke({ actorTokenId: "act_1" });
    expect(JSON.parse(captured.out)).toEqual({ id: "act_1", status: "revoked" });
  });

  test("targets the app/instance from resolveUsersInstanceContext", async () => {
    await revoke({ actorTokenId: "act_1", app: "app_abc123", instance: "prod" });
    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      secretKey: undefined,
      app: "app_abc123",
      instance: "prod",
    });
  });

  describe("accepted-token fallback", () => {
    // BAPI rejects the revoke with 400 once the ticket was consumed — the
    // token is `accepted` and the impersonation lives on as a session.
    const SESSION_MINE = {
      id: "sess_mine",
      status: "active",
      actor: { sub: "cli:admin@example.com", iss: "clerk-cli" },
    };
    const SESSION_MINE_CTX = {
      id: "sess_ctx",
      status: "active",
      actor: { sub: "cli:admin@example.com+oncall", iss: "clerk-cli" },
    };
    const SESSION_OTHER_ACTOR = {
      id: "sess_other",
      status: "active",
      actor: { sub: "cli:someone-else@example.com", iss: "clerk-cli" },
    };
    const SESSION_NO_ACTOR = { id: "sess_plain", status: "active", actor: null };

    function bapiError(status: number, message: string): BapiError {
      return new BapiError(status, JSON.stringify({ errors: [{ message }] }), new Headers());
    }

    function mockAcceptedTokenFlow(
      sessions: unknown = [SESSION_MINE, SESSION_MINE_CTX, SESSION_OTHER_ACTOR, SESSION_NO_ACTOR],
    ): void {
      mockBapiRequest.mockImplementation(async (options: unknown) => {
        const { method, path } = options as { method: string; path: string };
        if (method === "POST" && path === "/actor_tokens/act_1/revoke") {
          throw bapiError(400, "cannot revoke");
        }
        if (method === "GET" && path.startsWith("/sessions?")) {
          return { status: 200, headers: new Headers(), body: sessions, rawBody: "" };
        }
        const revokeMatch = /^\/sessions\/([^/]+)\/revoke$/.exec(path);
        if (method === "POST" && revokeMatch) {
          return {
            status: 200,
            headers: new Headers(),
            body: { id: revokeMatch[1], status: "revoked" },
            rawBody: "",
          };
        }
        throw new Error(`unexpected BAPI call: ${method} ${path}`);
      });
    }

    test("without --user: errors explaining the token was accepted, without touching the sessions API", async () => {
      mockAcceptedTokenFlow();
      await expect(revoke({ actorTokenId: "act_1" })).rejects.toThrow(/already accepted/);
      expect(mockBapiRequest).toHaveBeenCalledTimes(1);
    });

    test("with --user: lists active sessions and revokes those matching the operator's actor stamp", async () => {
      mockAcceptedTokenFlow();
      await revoke({ actorTokenId: "act_1", user: "user_target" });

      expect(mockBapiRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/sessions?user_id=user_target&status=active",
        secretKey: CTX.secretKey,
      });
      expect(mockBapiRequest).toHaveBeenCalledWith({
        method: "POST",
        path: "/sessions/sess_mine/revoke",
        secretKey: CTX.secretKey,
      });
      expect(mockBapiRequest).toHaveBeenCalledWith({
        method: "POST",
        path: "/sessions/sess_ctx/revoke",
        secretKey: CTX.secretKey,
      });
      const sessionRevokes = mockBapiRequest.mock.calls
        .map((call) => (call[0] as { path: string }).path)
        .filter((path) => /^\/sessions\/[^/]+\/revoke$/.test(path));
      expect(sessionRevokes).toHaveLength(2);
    });

    test("human mode: warns about the accepted token and reports each revoked session", async () => {
      mockAcceptedTokenFlow();
      await revoke({ actorTokenId: "act_1", user: "user_target" });

      expect(captured.err).toContain(
        "Token already accepted — an active impersonation session exists.",
      );
      expect(captured.err).toContain("Found session sess_mine (actor: cli:admin@example.com)");
      expect(captured.err).toContain("Revoked session sess_mine — impersonation ended.");
      expect(captured.err).toContain("Revoked session sess_ctx — impersonation ended.");
    });

    test("agent mode: emits JSON with the revoked session ids", async () => {
      setMode("agent");
      mockAcceptedTokenFlow();
      await revoke({ actorTokenId: "act_1", user: "user_target" });

      expect(JSON.parse(captured.out)).toEqual({
        id: "act_1",
        status: "accepted",
        revokedSessionIds: ["sess_mine", "sess_ctx"],
      });
    });

    test("errors when no active session carries the operator's actor stamp", async () => {
      mockAcceptedTokenFlow([SESSION_OTHER_ACTOR, SESSION_NO_ACTOR]);
      await expect(revoke({ actorTokenId: "act_1", user: "user_target" })).rejects.toThrow(
        /No active impersonation session/,
      );
    });

    test("supports the paginated { data: [...] } list shape", async () => {
      mockAcceptedTokenFlow({ data: [SESSION_MINE] });
      await revoke({ actorTokenId: "act_1", user: "user_target" });

      expect(mockBapiRequest).toHaveBeenCalledWith({
        method: "POST",
        path: "/sessions/sess_mine/revoke",
        secretKey: CTX.secretKey,
      });
    });

    test("non-400 revoke failures propagate without touching the sessions API", async () => {
      mockBapiRequest.mockRejectedValue(bapiError(404, "not found"));
      await expect(revoke({ actorTokenId: "act_1", user: "user_target" })).rejects.toThrow(
        /not found/,
      );
      expect(mockBapiRequest).toHaveBeenCalledTimes(1);
    });

    test("rejects --user values that are not user IDs before calling BAPI", async () => {
      await expect(revoke({ actorTokenId: "act_1", user: "alice@example.com" })).rejects.toThrow(
        /--user/,
      );
      expect(mockBapiRequest).not.toHaveBeenCalled();
    });
  });
});

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { setMode } from "../../mode.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";

const mockRequireLoginEmail = mock();
mock.module("./actor.ts", () => ({
  requireLoginEmail: (...args: unknown[]) => mockRequireLoginEmail(...args),
  buildActorStamp: () => ({ sub: "cli:unused", iss: "clerk-cli" }),
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
  formatTargetSuffix: (label?: string) => (label ? ` · on ${label}` : ""),
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
});

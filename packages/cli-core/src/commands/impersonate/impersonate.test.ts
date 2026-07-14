import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { setMode } from "../../mode.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import { BapiError, BillingError, CliError, ERROR_CODE } from "../../lib/errors.ts";
import { getDashboardUrl } from "../../lib/environment.ts";

const mockRequireLoginEmail = mock();
const mockBuildActorStamp = mock();
mock.module("./actor.ts", () => ({
  requireLoginEmail: (...args: unknown[]) => mockRequireLoginEmail(...args),
  buildActorStamp: (...args: unknown[]) => mockBuildActorStamp(...args),
}));

const mockResolveImpersonationTarget = mock();
mock.module("./resolve-user.ts", () => ({
  resolveImpersonationTarget: (...args: unknown[]) => mockResolveImpersonationTarget(...args),
}));

const mockResolveUsersInstanceContext = mock();
mock.module("../users/interactive/instance-context.ts", () => ({
  resolveUsersInstanceContext: (...args: unknown[]) => mockResolveUsersInstanceContext(...args),
}));

const mockBapiRequest = mock();
mock.module("../../lib/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));

const mockOpenBrowser = mock();
mock.module("../../lib/open.ts", () => ({
  openBrowser: (...args: unknown[]) => mockOpenBrowser(...args),
}));

const mockConfirm = mock();
mock.module("../../lib/prompts.ts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  text: async () => "",
  password: async () => "",
  editor: async () => "{}",
}));

mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  pausedOutro: () => {},
  bar: () => {},
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { impersonate } = await import("./impersonate.ts");

const SIGN_IN_URL = "https://example.clerk.accounts.dev/v1/tickets/accept?ticket=tkt_abc";
const BILLING_URL = `${getDashboardUrl().replace(/\/$/, "")}/settings/billing`;

function reject422(): void {
  mockBapiRequest.mockRejectedValue(
    new BapiError(
      422,
      JSON.stringify({ errors: [{ message: "limit exceeded", meta: { limit: 100, used: 100 } }] }),
      new Headers(),
    ),
  );
}

const CTX = {
  secretKey: "sk_test_123",
  appId: "app_abc123",
  appLabel: "My App",
  instanceId: "ins_dev789",
  instanceLabel: "development",
};

const PROD_CTX = { ...CTX, instanceLabel: "production" };

function setStdinTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

describe("impersonate", () => {
  const captured = useCaptureLog();
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    setMode("human");
    setStdinTTY(true);
    mockRequireLoginEmail.mockResolvedValue("admin@example.com");
    mockBuildActorStamp.mockReturnValue({ sub: "cli:admin@example.com", iss: "clerk-cli" });
    mockResolveUsersInstanceContext.mockResolvedValue(CTX);
    mockResolveImpersonationTarget.mockResolvedValue("user_2x9k");
    mockConfirm.mockResolvedValue(true);
    mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "open" });
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { id: "act_1", url: SIGN_IN_URL },
      rawBody: "",
    });
  });

  afterEach(() => {
    setStdinTTY(originalIsTTY);
    mockRequireLoginEmail.mockReset();
    mockBuildActorStamp.mockReset();
    mockResolveUsersInstanceContext.mockReset();
    mockResolveImpersonationTarget.mockReset();
    mockBapiRequest.mockReset();
    mockOpenBrowser.mockReset();
    mockConfirm.mockReset();
  });

  test("hard-fails before any BAPI call when requireLoginEmail rejects", async () => {
    mockRequireLoginEmail.mockRejectedValue(
      new CliError("Not logged in. Run `clerk auth login` to authenticate", {
        code: ERROR_CODE.AUTH_REQUIRED,
      }),
    );

    await expect(impersonate({ user: "user_2x9k" })).rejects.toThrow(/Not logged in/);
    expect(mockResolveUsersInstanceContext).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("human mode: confirms before creating the token, prints the URL verbatim, and offers to open it", async () => {
    mockConfirm.mockResolvedValueOnce(true); // "Impersonate ... ?"
    mockConfirm.mockResolvedValueOnce(true); // "Press Enter to open ..."

    await impersonate({ user: "user_2x9k" });

    expect(mockConfirm).toHaveBeenNthCalledWith(1, expect.objectContaining({ default: false }));
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/actor_tokens",
      secretKey: CTX.secretKey,
      body: JSON.stringify({
        user_id: "user_2x9k",
        actor: { sub: "cli:admin@example.com", iss: "clerk-cli" },
        expires_in_seconds: 3600,
      }),
    });
    expect(captured.out).toBe(SIGN_IN_URL);
    expect(captured.err).toContain("Revoke with: clerk imp revoke act_1 --user user_2x9k");
    expect(mockOpenBrowser).toHaveBeenCalledWith(SIGN_IN_URL);
  });

  test("declining the confirm prompt aborts without calling BAPI", async () => {
    mockConfirm.mockResolvedValueOnce(false);

    await expect(impersonate({ user: "user_2x9k" })).rejects.toThrow("User aborted");
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("--yes skips the confirm prompt", async () => {
    await impersonate({ user: "user_2x9k", yes: true, print: true });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test("production instance: prints the guardrail warning before confirming", async () => {
    mockResolveUsersInstanceContext.mockResolvedValue(PROD_CTX);

    await impersonate({ user: "user_2x9k", print: true });

    expect(captured.err).toContain("production — signs you in as this user and bypasses their MFA");
  });

  test("sk_live_ secret key without an instance label still prints the guardrail warning", async () => {
    const { instanceLabel: _drop, ...rest } = CTX;
    mockResolveUsersInstanceContext.mockResolvedValue({ ...rest, secretKey: "sk_live_123" });

    await impersonate({ user: "user_2x9k", print: true });

    expect(captured.err).toContain("production — signs you in as this user and bypasses their MFA");
  });

  test("--expires-in overrides the default 3600s lifetime", async () => {
    await impersonate({ user: "user_2x9k", expiresIn: 900, print: true, yes: true });

    const requestBody = (mockBapiRequest.mock.calls[0]![0] as { body: string }).body;
    expect(JSON.parse(requestBody)).toEqual({
      user_id: "user_2x9k",
      actor: { sub: "cli:admin@example.com", iss: "clerk-cli" },
      expires_in_seconds: 900,
    });
  });

  test("--actor passes context through to buildActorStamp", async () => {
    mockBuildActorStamp.mockReturnValue({ sub: "cli:admin@example.com+oncall", iss: "clerk-cli" });

    await impersonate({ user: "user_2x9k", actor: "oncall", print: true, yes: true });

    expect(mockBuildActorStamp).toHaveBeenCalledWith("admin@example.com", "oncall");
  });

  test("--print prints the URL only — no confirm-to-open prompt, no browser", async () => {
    await impersonate({ user: "user_2x9k", yes: true, print: true });

    expect(captured.out).toBe(SIGN_IN_URL);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test("--open prints the URL and opens the browser immediately, skipping the prompt", async () => {
    await impersonate({ user: "user_2x9k", yes: true, open: true });

    expect(mockOpenBrowser).toHaveBeenCalledTimes(1);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test("non-TTY stdin in human mode behaves like --print and never prompts", async () => {
    setStdinTTY(false);

    await impersonate({ user: "user_2x9k", yes: true });

    expect(captured.out).toBe(SIGN_IN_URL);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test("agent mode: emits structured JSON, never confirms, never opens a browser", async () => {
    setMode("agent");

    await impersonate({ user: "user_2x9k" });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockOpenBrowser).not.toHaveBeenCalled();
    expect(JSON.parse(captured.out)).toEqual({
      url: SIGN_IN_URL,
      id: "act_1",
      userId: "user_2x9k",
      actor: { sub: "cli:admin@example.com", iss: "clerk-cli" },
      appId: CTX.appId,
      appLabel: CTX.appLabel,
      instanceId: CTX.instanceId,
      instanceLabel: CTX.instanceLabel,
      expiresInSeconds: 3600,
    });
  });

  test("402 surfaces a value-framed add-on message with the billing page as docsUrl", async () => {
    mockBapiRequest.mockRejectedValue(
      new BapiError(402, JSON.stringify({ errors: [{ message: "not enabled" }] }), new Headers()),
    );

    let error: unknown;
    try {
      await impersonate({ user: "user_2x9k", print: true, yes: true });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BillingError);
    expect((error as BillingError).message).toBe("Impersonation is available as an add-on.");
    expect((error as BillingError).code).toBe(ERROR_CODE.IMPERSONATION_NOT_ENABLED);
    expect((error as BillingError).docsUrl).toBe(BILLING_URL);
  });

  test("422 surfaces a numberless limit message with the billing page as docsUrl", async () => {
    reject422();

    let error: unknown;
    try {
      await impersonate({ user: "user_2x9k", print: true, yes: true });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BillingError);
    expect((error as BillingError).message).toBe(
      "You've reached your impersonation limit this billing period.",
    );
    expect((error as BillingError).code).toBe(ERROR_CODE.IMPERSONATION_LIMIT_EXCEEDED);
    expect((error as BillingError).docsUrl).toBe(BILLING_URL);
  });

  test("422 drops the used/limit counts even when BAPI reports them in meta", async () => {
    reject422();

    let error: unknown;
    try {
      await impersonate({ user: "user_2x9k", print: true, yes: true });
    } catch (caught) {
      error = caught;
    }

    expect((error as BillingError).message).not.toMatch(/100/);
  });

  test("billing block in agent mode throws with docsUrl and never prompts or opens a browser", async () => {
    setMode("agent");
    reject422();

    await expect(impersonate({ user: "user_2x9k" })).rejects.toBeInstanceOf(BillingError);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("billing block with --print prints the URL via the error, no prompt, no browser", async () => {
    reject422();

    await expect(impersonate({ user: "user_2x9k", print: true, yes: true })).rejects.toBeInstanceOf(
      BillingError,
    );
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("billing block with --yes opens the billing page without prompting, then exits non-zero", async () => {
    reject422();

    await expect(impersonate({ user: "user_2x9k", yes: true })).rejects.toBeInstanceOf(
      BillingError,
    );
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockOpenBrowser).toHaveBeenCalledWith(BILLING_URL);
  });

  test("billing block in a TTY prompts to upgrade and opens the billing page on yes", async () => {
    reject422();
    mockConfirm.mockResolvedValueOnce(true); // "Impersonate ...?"
    mockConfirm.mockResolvedValueOnce(true); // "Add more impersonations now?"

    await expect(impersonate({ user: "user_2x9k" })).rejects.toBeInstanceOf(BillingError);
    expect(mockConfirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "Add more impersonations now?", default: true }),
    );
    expect(mockOpenBrowser).toHaveBeenCalledWith(BILLING_URL);
  });

  test("billing block in a TTY leaves the browser closed when the upgrade prompt is declined", async () => {
    reject422();
    mockConfirm.mockResolvedValueOnce(true); // "Impersonate ...?"
    mockConfirm.mockResolvedValueOnce(false); // "Add more impersonations now?"

    await expect(impersonate({ user: "user_2x9k" })).rejects.toBeInstanceOf(BillingError);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("billing block in non-TTY human mode never opens a browser (no --yes)", async () => {
    setStdinTTY(false);
    reject422();

    // Pre-flight "Impersonate ...?" confirm still resolves (mocked); the upgrade
    // nudge must NOT open a browser because stdin is not a TTY and --yes is absent.
    await expect(impersonate({ user: "user_2x9k" })).rejects.toBeInstanceOf(BillingError);
    expect(mockConfirm).toHaveBeenCalledTimes(1); // only the pre-flight confirm, no upgrade prompt
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });
});

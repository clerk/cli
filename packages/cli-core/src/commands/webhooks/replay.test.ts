import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { ERROR_CODE, PlapiError, UserAbortError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockResendWebhookMessage = mock();
const mockRecoverWebhookMessages = mock();
mock.module("../../lib/plapi.ts", () => ({
  resendWebhookMessage: (...args: unknown[]) => mockResendWebhookMessage(...args),
  recoverWebhookMessages: (...args: unknown[]) => mockRecoverWebhookMessages(...args),
}));

const mockResolveAppContext = mock();
const mockGetRelayEntry = mock();
mock.module("../../lib/config.ts", () => ({
  resolveAppContext: (...args: unknown[]) => mockResolveAppContext(...args),
  getRelayEntry: (...args: unknown[]) => mockGetRelayEntry(...args),
}));

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

const mockConfirm = mock();
mock.module("../../lib/prompts.ts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

const { webhooksReplay } = await import("./replay.ts");

describe("webhooks replay", () => {
  useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockConfirm.mockResolvedValue(true);
    mockGetRelayEntry.mockResolvedValue(undefined);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_1",
      appLabel: "My App",
      instanceId: "ins_1",
      instanceLabel: "development",
    });
    mockResendWebhookMessage.mockResolvedValue(undefined);
    mockRecoverWebhookMessages.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockResendWebhookMessage.mockReset();
    mockRecoverWebhookMessages.mockReset();
    mockResolveAppContext.mockReset();
    mockGetRelayEntry.mockReset();
    mockIsAgent.mockReset();
    mockConfirm.mockReset();
  });

  test.each([
    {
      label: "both <msg_id> and --since",
      options: { msgId: "msg_1", since: "2026-05-01T00:00:00Z" },
    },
    { label: "neither <msg_id> nor --since", options: {} },
    {
      label: "--until without --since",
      options: { msgId: "msg_1", until: "2026-05-01T00:00:00Z" },
    },
    {
      label: "--until alone (no <msg_id>, no --since)",
      options: { until: "2026-05-01T00:00:00Z" },
    },
    {
      label: "--since without --endpoint",
      options: { since: "2026-05-01T00:00:00Z" },
    },
    {
      label: "invalid --since timestamp",
      options: { since: "not-a-date", endpoint: "ep_1" },
    },
    {
      label: "invalid --until timestamp",
      options: { since: "2026-05-01T00:00:00Z", until: "nope", endpoint: "ep_1" },
    },
  ])("$label is a usage error", async ({ options }) => {
    await expect(webhooksReplay(options)).rejects.toMatchObject({
      code: ERROR_CODE.USAGE_ERROR,
    });
    expect(mockResendWebhookMessage).not.toHaveBeenCalled();
    expect(mockRecoverWebhookMessages).not.toHaveBeenCalled();
  });

  test("--until alone points at the missing --since instead of a vaguer hint", async () => {
    await expect(webhooksReplay({ until: "2026-05-01T00:00:00Z" })).rejects.toThrow(
      "--until requires --since.",
    );
  });

  test("resends one message to an explicit --endpoint without prompting", async () => {
    await webhooksReplay({ msgId: "msg_1", endpoint: "ep_1" });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockResendWebhookMessage).toHaveBeenCalledWith("app_1", "ins_1", "ep_1", "msg_1");
  });

  test("resend defaults --endpoint to the persisted relay endpoint", async () => {
    mockGetRelayEntry.mockResolvedValue({ token: "Ab12Cd34Ef", endpoint_id: "ep_relay" });

    await webhooksReplay({ msgId: "msg_1" });

    expect(mockResendWebhookMessage).toHaveBeenCalledWith("app_1", "ins_1", "ep_relay", "msg_1");
  });

  test("resend without --endpoint or a relay endpoint is a usage error", async () => {
    await expect(webhooksReplay({ msgId: "msg_1" })).rejects.toMatchObject({
      code: ERROR_CODE.USAGE_ERROR,
    });
  });

  test("resend maps a PLAPI 404 to webhook_message_not_found", async () => {
    mockResendWebhookMessage.mockRejectedValue(new PlapiError(404, "{}"));

    await expect(webhooksReplay({ msgId: "msg_gone", endpoint: "ep_1" })).rejects.toMatchObject({
      code: ERROR_CODE.WEBHOOK_MESSAGE_NOT_FOUND,
      message: "No webhook message with ID msg_gone was found.",
    });
  });

  test("--since prompts, then recovers the window", async () => {
    await webhooksReplay({ since: "2026-05-01T00:00:00Z", endpoint: "ep_1" });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockRecoverWebhookMessages).toHaveBeenCalledWith("app_1", "ins_1", "ep_1", {
      since: "2026-05-01T00:00:00Z",
      until: undefined,
    });
  });

  test("--since --until bounds the recovery window", async () => {
    await webhooksReplay({
      since: "2026-05-01T00:00:00Z",
      until: "2026-05-01T01:00:00Z",
      endpoint: "ep_1",
      yes: true,
    });

    expect(mockRecoverWebhookMessages).toHaveBeenCalledWith("app_1", "ins_1", "ep_1", {
      since: "2026-05-01T00:00:00Z",
      until: "2026-05-01T01:00:00Z",
    });
  });

  test("--since aborts cleanly when the prompt is declined", async () => {
    mockConfirm.mockResolvedValue(false);

    await expect(
      webhooksReplay({ since: "2026-05-01T00:00:00Z", endpoint: "ep_1" }),
    ).rejects.toBeInstanceOf(UserAbortError);
    expect(mockRecoverWebhookMessages).not.toHaveBeenCalled();
  });

  test("--since in agent mode without --yes is a usage error", async () => {
    mockIsAgent.mockReturnValue(true);

    await expect(
      webhooksReplay({ since: "2026-05-01T00:00:00Z", endpoint: "ep_1" }),
    ).rejects.toMatchObject({ code: ERROR_CODE.USAGE_ERROR });
    expect(mockRecoverWebhookMessages).not.toHaveBeenCalled();
    expect(mockResolveAppContext).not.toHaveBeenCalled();
  });

  test("--since maps a PLAPI 404 to webhook_endpoint_not_found", async () => {
    mockRecoverWebhookMessages.mockRejectedValue(new PlapiError(404, "{}"));

    await expect(
      webhooksReplay({ since: "2026-05-01T00:00:00Z", endpoint: "ep_missing", yes: true }),
    ).rejects.toMatchObject({ code: ERROR_CODE.WEBHOOK_ENDPOINT_NOT_FOUND });
  });
});

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { ERROR_CODE, PlapiError, UserAbortError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockDeleteWebhookEndpoint = mock();
mock.module("../../lib/plapi.ts", () => ({
  deleteWebhookEndpoint: (...args: unknown[]) => mockDeleteWebhookEndpoint(...args),
}));

const mockResolveAppContext = mock();
mock.module("../../lib/config.ts", () => ({
  resolveAppContext: (...args: unknown[]) => mockResolveAppContext(...args),
  getRelayEntry: async () => undefined,
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

const { webhooksDelete } = await import("./delete.ts");

describe("webhooks delete", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockConfirm.mockResolvedValue(true);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_1",
      appLabel: "My App",
      instanceId: "ins_1",
      instanceLabel: "development",
    });
    mockDeleteWebhookEndpoint.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockDeleteWebhookEndpoint.mockReset();
    mockResolveAppContext.mockReset();
    mockIsAgent.mockReset();
    mockConfirm.mockReset();
  });

  test("prompts before deleting in human mode", async () => {
    await webhooksDelete({ endpointId: "ep_1" });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockDeleteWebhookEndpoint).toHaveBeenCalledWith("app_1", "ins_1", "ep_1");
    expect(captured.out).toBe("");
    expect(captured.err).toContain("Deleted webhook endpoint");
  });

  test("--yes skips the prompt", async () => {
    await webhooksDelete({ endpointId: "ep_1", yes: true });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDeleteWebhookEndpoint).toHaveBeenCalled();
  });

  test("aborts cleanly when the prompt is declined", async () => {
    mockConfirm.mockResolvedValue(false);

    await expect(webhooksDelete({ endpointId: "ep_1" })).rejects.toBeInstanceOf(UserAbortError);
    expect(mockDeleteWebhookEndpoint).not.toHaveBeenCalled();
  });

  test("agent mode without --yes is a usage error", async () => {
    mockIsAgent.mockReturnValue(true);

    await expect(webhooksDelete({ endpointId: "ep_1" })).rejects.toMatchObject({
      code: ERROR_CODE.USAGE_ERROR,
    });
    expect(mockDeleteWebhookEndpoint).not.toHaveBeenCalled();
  });

  test("agent mode with --yes deletes without prompting", async () => {
    mockIsAgent.mockReturnValue(true);

    await webhooksDelete({ endpointId: "ep_1", yes: true });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDeleteWebhookEndpoint).toHaveBeenCalled();
  });

  test("maps a PLAPI 404 to webhook_endpoint_not_found", async () => {
    mockDeleteWebhookEndpoint.mockRejectedValue(new PlapiError(404, "{}"));

    await expect(webhooksDelete({ endpointId: "ep_missing", yes: true })).rejects.toMatchObject({
      code: ERROR_CODE.WEBHOOK_ENDPOINT_NOT_FOUND,
    });
  });
});

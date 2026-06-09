import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { CliError, ERROR_CODE, PlapiError, UserAbortError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockGetWebhookEndpointSecret = mock();
const mockRotateWebhookEndpointSecret = mock();
mock.module("../../lib/plapi.ts", () => ({
  getWebhookEndpointSecret: (...args: unknown[]) => mockGetWebhookEndpointSecret(...args),
  rotateWebhookEndpointSecret: (...args: unknown[]) => mockRotateWebhookEndpointSecret(...args),
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

const { webhooksSecret } = await import("./secret.ts");

describe("webhooks secret", () => {
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
    mockGetWebhookEndpointSecret.mockResolvedValue({ secret: "whsec_abc123" });
    mockRotateWebhookEndpointSecret.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockGetWebhookEndpointSecret.mockReset();
    mockRotateWebhookEndpointSecret.mockReset();
    mockResolveAppContext.mockReset();
    mockIsAgent.mockReset();
    mockConfirm.mockReset();
  });

  test("prints the bare secret on stdout in human mode", async () => {
    await webhooksSecret({ endpointId: "ep_1" });

    expect(captured.stdout).toEqual(["whsec_abc123"]);
    expect(captured.err).toContain("Signing secret for");
    expect(mockRotateWebhookEndpointSecret).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test("outputs { secret } as JSON with --json", async () => {
    await webhooksSecret({ endpointId: "ep_1", json: true });

    expect(JSON.parse(captured.out)).toEqual({ secret: "whsec_abc123" });
    expect(captured.err).toBe("");
  });

  test("outputs { secret } in agent mode without --json", async () => {
    mockIsAgent.mockReturnValue(true);

    await webhooksSecret({ endpointId: "ep_1" });

    expect(JSON.parse(captured.out)).toEqual({ secret: "whsec_abc123" });
  });

  test("--rotate prompts, rotates, then fetches the new secret", async () => {
    await webhooksSecret({ endpointId: "ep_1", rotate: true });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockRotateWebhookEndpointSecret).toHaveBeenCalledWith("app_1", "ins_1", "ep_1");
    expect(mockGetWebhookEndpointSecret).toHaveBeenCalledWith("app_1", "ins_1", "ep_1");
    expect(captured.stdout).toEqual(["whsec_abc123"]);
    expect(captured.err).toContain("dual-signs");
  });

  test("--rotate --yes skips the prompt", async () => {
    await webhooksSecret({ endpointId: "ep_1", rotate: true, yes: true });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockRotateWebhookEndpointSecret).toHaveBeenCalled();
  });

  test("--rotate aborts cleanly when the prompt is declined", async () => {
    mockConfirm.mockResolvedValue(false);

    await expect(webhooksSecret({ endpointId: "ep_1", rotate: true })).rejects.toBeInstanceOf(
      UserAbortError,
    );
    expect(mockRotateWebhookEndpointSecret).not.toHaveBeenCalled();
  });

  test("--rotate in agent mode without --yes is a usage error", async () => {
    mockIsAgent.mockReturnValue(true);

    await expect(webhooksSecret({ endpointId: "ep_1", rotate: true })).rejects.toMatchObject({
      code: ERROR_CODE.USAGE_ERROR,
    });
    expect(mockRotateWebhookEndpointSecret).not.toHaveBeenCalled();
  });

  test("maps a PLAPI 404 to webhook_endpoint_not_found", async () => {
    mockGetWebhookEndpointSecret.mockRejectedValue(new PlapiError(404, "{}"));

    await expect(webhooksSecret({ endpointId: "ep_missing" })).rejects.toMatchObject({
      code: ERROR_CODE.WEBHOOK_ENDPOINT_NOT_FOUND,
    });
    await expect(webhooksSecret({ endpointId: "ep_missing" })).rejects.toBeInstanceOf(CliError);
  });
});

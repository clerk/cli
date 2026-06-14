import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { CliError, ERROR_CODE, PlapiError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockGetWebhookEndpoint = mock();
mock.module("../../lib/plapi.ts", () => ({
  getWebhookEndpoint: (...args: unknown[]) => mockGetWebhookEndpoint(...args),
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

const { webhooksGet } = await import("./get.ts");

const mockEndpoint = {
  id: "ep_1",
  url: "https://example.com/webhooks",
  version: 1,
  description: "Primary",
  disabled: false,
  filter_types: ["user.created", "user.deleted"],
  channels: null,
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-02T00:00:00Z",
};

describe("webhooks get", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_1",
      appLabel: "My App",
      instanceId: "ins_1",
      instanceLabel: "development",
    });
    mockGetWebhookEndpoint.mockResolvedValue(mockEndpoint);
  });

  afterEach(() => {
    mockGetWebhookEndpoint.mockReset();
    mockResolveAppContext.mockReset();
    mockIsAgent.mockReset();
  });

  test("fetches the endpoint by ID", async () => {
    await webhooksGet({ endpointId: "ep_1" });

    expect(mockGetWebhookEndpoint).toHaveBeenCalledWith("app_1", "ins_1", "ep_1");
  });

  test("prints endpoint details on stderr in human mode", async () => {
    await webhooksGet({ endpointId: "ep_1" });

    expect(captured.out).toBe("");
    expect(captured.err).toContain("ep_1");
    expect(captured.err).toContain("https://example.com/webhooks");
    expect(captured.err).toContain("enabled");
    expect(captured.err).toContain("user.created, user.deleted");
  });

  test("outputs the bare endpoint resource as JSON with --json", async () => {
    await webhooksGet({ endpointId: "ep_1", json: true });

    expect(JSON.parse(captured.out)).toEqual(mockEndpoint);
    expect(captured.err).toBe("");
  });

  test("outputs JSON in agent mode without --json", async () => {
    mockIsAgent.mockReturnValue(true);

    await webhooksGet({ endpointId: "ep_1" });

    expect(JSON.parse(captured.out)).toEqual(mockEndpoint);
  });

  test("maps a PLAPI 404 to webhook_endpoint_not_found", async () => {
    mockGetWebhookEndpoint.mockRejectedValue(new PlapiError(404, "{}"));

    const promise = webhooksGet({ endpointId: "ep_missing" });

    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(webhooksGet({ endpointId: "ep_missing" })).rejects.toMatchObject({
      code: ERROR_CODE.WEBHOOK_ENDPOINT_NOT_FOUND,
      message: "No webhook endpoint with ID ep_missing was found.",
    });
  });

  test("re-throws non-404 PLAPI errors untouched", async () => {
    const original = new PlapiError(500, "{}");
    mockGetWebhookEndpoint.mockRejectedValue(original);

    await expect(webhooksGet({ endpointId: "ep_1" })).rejects.toBe(original);
  });
});

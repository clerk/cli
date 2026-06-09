import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { CliError, ERROR_CODE, PlapiError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockCreateWebhookEndpoint = mock();
const mockGetWebhookEndpointSecret = mock();
mock.module("../../lib/plapi.ts", () => ({
  createWebhookEndpoint: (...args: unknown[]) => mockCreateWebhookEndpoint(...args),
  getWebhookEndpointSecret: (...args: unknown[]) => mockGetWebhookEndpointSecret(...args),
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

const { webhooksCreate } = await import("./create.ts");

const createdEndpoint = {
  id: "ep_new",
  url: "https://example.com/webhooks",
  version: 1,
  description: "My endpoint",
  disabled: false,
  filter_types: ["user.created"],
  channels: null,
  created_at: "2026-06-09T00:00:00Z",
  updated_at: "2026-06-09T00:00:00Z",
};

describe("webhooks create", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_1",
      appLabel: "My App",
      instanceId: "ins_1",
      instanceLabel: "development",
    });
    mockCreateWebhookEndpoint.mockResolvedValue(createdEndpoint);
    mockGetWebhookEndpointSecret.mockResolvedValue({ secret: "whsec_new123" });
  });

  afterEach(() => {
    mockCreateWebhookEndpoint.mockReset();
    mockGetWebhookEndpointSecret.mockReset();
    mockResolveAppContext.mockReset();
    mockIsAgent.mockReset();
  });

  test("missing --url is a usage error", async () => {
    await expect(webhooksCreate({})).rejects.toMatchObject({ code: ERROR_CODE.USAGE_ERROR });
    expect(mockCreateWebhookEndpoint).not.toHaveBeenCalled();
  });

  test("sends url and version 1 by default", async () => {
    await webhooksCreate({ url: "https://example.com/webhooks" });

    expect(mockCreateWebhookEndpoint).toHaveBeenCalledWith("app_1", "ins_1", {
      url: "https://example.com/webhooks",
      version: 1,
    });
  });

  test("maps optional flags to the create body", async () => {
    await webhooksCreate({
      url: "https://example.com/webhooks",
      events: "user.created, user.deleted",
      description: "My endpoint",
      channels: "a,b",
      disabled: true,
    });

    expect(mockCreateWebhookEndpoint).toHaveBeenCalledWith("app_1", "ins_1", {
      url: "https://example.com/webhooks",
      version: 1,
      description: "My endpoint",
      disabled: true,
      filter_types: ["user.created", "user.deleted"],
      channels: ["a", "b"],
    });
  });

  test("fetches the signing secret after creating", async () => {
    await webhooksCreate({ url: "https://example.com/webhooks" });

    expect(mockGetWebhookEndpointSecret).toHaveBeenCalledWith("app_1", "ins_1", "ep_new");
  });

  test("emits the endpoint flat with signing_secret in JSON mode", async () => {
    await webhooksCreate({ url: "https://example.com/webhooks", json: true });

    expect(JSON.parse(captured.out)).toEqual({
      ...createdEndpoint,
      signing_secret: "whsec_new123",
    });
    expect(captured.err).toBe("");
  });

  test("prints details and the unmasked secret in human mode", async () => {
    await webhooksCreate({ url: "https://example.com/webhooks" });

    expect(captured.out).toBe("");
    expect(captured.err).toContain("Created webhook endpoint");
    expect(captured.err).toContain("ep_new");
    expect(captured.err).toContain("whsec_new123");
  });

  test("partial failure: secret fetch error exits 1 with the recovery command", async () => {
    mockGetWebhookEndpointSecret.mockRejectedValue(new PlapiError(500, "{}"));

    const promise = webhooksCreate({ url: "https://example.com/webhooks" });

    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(webhooksCreate({ url: "https://example.com/webhooks" })).rejects.toThrow(
      "Endpoint created (id: ep_new) but the signing secret could not be fetched. " +
        "Run 'clerk webhooks secret ep_new' to retrieve it.",
    );
  });
});

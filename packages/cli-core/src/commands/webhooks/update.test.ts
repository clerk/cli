import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { ERROR_CODE, PlapiError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockUpdateWebhookEndpoint = mock();
mock.module("../../lib/plapi.ts", () => ({
  updateWebhookEndpoint: (...args: unknown[]) => mockUpdateWebhookEndpoint(...args),
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

const { webhooksUpdate } = await import("./update.ts");

const updatedEndpoint = {
  id: "ep_1",
  url: "https://example.com/new",
  version: 1,
  description: "Updated",
  disabled: false,
  filter_types: ["user.created"],
  channels: null,
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-09T00:00:00Z",
};

describe("webhooks update", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_1",
      appLabel: "My App",
      instanceId: "ins_1",
      instanceLabel: "development",
    });
    mockUpdateWebhookEndpoint.mockResolvedValue(updatedEndpoint);
  });

  afterEach(() => {
    mockUpdateWebhookEndpoint.mockReset();
    mockResolveAppContext.mockReset();
    mockIsAgent.mockReset();
  });

  test.each([
    {
      label: "--url",
      options: { url: "https://example.com/new" },
      expected: { url: "https://example.com/new" },
    },
    {
      label: "--description",
      options: { description: "Updated" },
      expected: { description: "Updated" },
    },
    {
      label: "--events (comma-separated)",
      options: { events: "user.created, user.deleted" },
      expected: { filter_types: ["user.created", "user.deleted"] },
    },
    {
      label: "--channels (comma-separated)",
      options: { channels: "a,b" },
      expected: { channels: ["a", "b"] },
    },
    { label: "--enable", options: { enable: true }, expected: { disabled: false } },
    { label: "--disable", options: { disable: true }, expected: { disabled: true } },
  ])("$label maps to the PATCH body", async ({ options, expected }) => {
    await webhooksUpdate({ endpointId: "ep_1", ...options });

    expect(mockUpdateWebhookEndpoint).toHaveBeenCalledWith("app_1", "ins_1", "ep_1", expected);
  });

  test("omits disabled from the PATCH body when neither --enable nor --disable is set", async () => {
    await webhooksUpdate({ endpointId: "ep_1", url: "https://example.com/new" });

    const params = mockUpdateWebhookEndpoint.mock.calls[0]?.[3] as Record<string, unknown>;
    expect("disabled" in params).toBe(false);
  });

  test("--enable with --disable is a usage error", async () => {
    await expect(
      webhooksUpdate({ endpointId: "ep_1", enable: true, disable: true }),
    ).rejects.toMatchObject({ code: ERROR_CODE.USAGE_ERROR });
    expect(mockUpdateWebhookEndpoint).not.toHaveBeenCalled();
  });

  test("no update flags at all is a usage error", async () => {
    await expect(webhooksUpdate({ endpointId: "ep_1" })).rejects.toMatchObject({
      code: ERROR_CODE.USAGE_ERROR,
    });
    expect(mockUpdateWebhookEndpoint).not.toHaveBeenCalled();
  });

  test.each([
    { label: "--events", options: { events: "" } },
    { label: "--channels", options: { channels: " , " } },
  ])("an empty $label value does not bypass the no-flags guard", async ({ options }) => {
    await expect(webhooksUpdate({ endpointId: "ep_1", ...options })).rejects.toMatchObject({
      code: ERROR_CODE.USAGE_ERROR,
    });
    expect(mockUpdateWebhookEndpoint).not.toHaveBeenCalled();
  });

  test("prints the updated endpoint in human mode", async () => {
    await webhooksUpdate({ endpointId: "ep_1", description: "Updated" });

    expect(captured.out).toBe("");
    expect(captured.err).toContain("Updated webhook endpoint");
    expect(captured.err).toContain("https://example.com/new");
  });

  test("outputs the updated endpoint resource as JSON with --json", async () => {
    await webhooksUpdate({ endpointId: "ep_1", description: "Updated", json: true });

    expect(JSON.parse(captured.out)).toEqual(updatedEndpoint);
    expect(captured.err).toBe("");
  });

  test("outputs the updated endpoint resource in agent mode without --json", async () => {
    mockIsAgent.mockReturnValue(true);

    await webhooksUpdate({ endpointId: "ep_1", description: "Updated" });

    expect(JSON.parse(captured.out)).toEqual(updatedEndpoint);
  });

  test("maps a PLAPI 404 to webhook_endpoint_not_found", async () => {
    mockUpdateWebhookEndpoint.mockRejectedValue(new PlapiError(404, "{}"));

    await expect(
      webhooksUpdate({ endpointId: "ep_missing", description: "x" }),
    ).rejects.toMatchObject({ code: ERROR_CODE.WEBHOOK_ENDPOINT_NOT_FOUND });
  });
});

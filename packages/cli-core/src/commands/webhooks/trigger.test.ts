import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { ERROR_CODE, PlapiError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockListWebhookEventTypes = mock();
const mockSendWebhookExample = mock();
mock.module("../../lib/plapi.ts", () => ({
  listWebhookEventTypes: (...args: unknown[]) => mockListWebhookEventTypes(...args),
  sendWebhookExample: (...args: unknown[]) => mockSendWebhookExample(...args),
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

const { webhooksTrigger } = await import("./trigger.ts");

function catalogPage(names: string[], hasNextPage = false, startingAfter: string | null = null) {
  return {
    data: names.map((name) => ({
      name,
      description: "",
      archived: false,
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    })),
    cursor: { starting_after: startingAfter, ending_before: null, has_next_page: hasNextPage },
  };
}

describe("webhooks trigger", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockGetRelayEntry.mockResolvedValue({ token: "Ab12Cd34Ef", endpoint_id: "ep_relay" });
    mockResolveAppContext.mockResolvedValue({
      appId: "app_1",
      appLabel: "My App",
      instanceId: "ins_1",
      instanceLabel: "development",
    });
    mockListWebhookEventTypes.mockResolvedValue(catalogPage(["user.created", "user.deleted"]));
    mockSendWebhookExample.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockListWebhookEventTypes.mockReset();
    mockSendWebhookExample.mockReset();
    mockResolveAppContext.mockReset();
    mockGetRelayEntry.mockReset();
    mockIsAgent.mockReset();
  });

  test("validates the event type, then sends the example", async () => {
    await webhooksTrigger({ eventType: "user.created" });

    expect(mockListWebhookEventTypes).toHaveBeenCalledWith("app_1", "ins_1", {
      limit: 250,
      iterator: undefined,
    });
    expect(mockSendWebhookExample).toHaveBeenCalledWith(
      "app_1",
      "ins_1",
      "ep_relay",
      "user.created",
    );
    expect(captured.err).toContain("delivery is async");
  });

  test("uses an explicit --endpoint over the relay default", async () => {
    await webhooksTrigger({ eventType: "user.created", endpoint: "ep_1" });

    expect(mockSendWebhookExample).toHaveBeenCalledWith("app_1", "ins_1", "ep_1", "user.created");
  });

  test("no --endpoint and no relay endpoint is a usage error", async () => {
    mockGetRelayEntry.mockResolvedValue(undefined);

    await expect(webhooksTrigger({ eventType: "user.created" })).rejects.toMatchObject({
      code: ERROR_CODE.USAGE_ERROR,
    });
    expect(mockSendWebhookExample).not.toHaveBeenCalled();
  });

  test("unknown event type fails fast with unknown_event_type", async () => {
    await expect(webhooksTrigger({ eventType: "user.exploded" })).rejects.toMatchObject({
      code: ERROR_CODE.UNKNOWN_EVENT_TYPE,
    });
    expect(mockSendWebhookExample).not.toHaveBeenCalled();
  });

  test("unknown event type wins over a missing relay endpoint (fail fast)", async () => {
    mockGetRelayEntry.mockResolvedValue(undefined);

    await expect(webhooksTrigger({ eventType: "user.exploded" })).rejects.toMatchObject({
      code: ERROR_CODE.UNKNOWN_EVENT_TYPE,
    });
    expect(mockSendWebhookExample).not.toHaveBeenCalled();
  });

  test("pages through the catalog before declaring a type unknown", async () => {
    mockListWebhookEventTypes
      .mockResolvedValueOnce(catalogPage(["user.created"], true, "iter_2"))
      .mockResolvedValueOnce(catalogPage(["organization.created"]));

    await webhooksTrigger({ eventType: "organization.created" });

    expect(mockListWebhookEventTypes).toHaveBeenCalledTimes(2);
    expect(mockListWebhookEventTypes).toHaveBeenLastCalledWith("app_1", "ins_1", {
      limit: 250,
      iterator: "iter_2",
    });
    expect(mockSendWebhookExample).toHaveBeenCalled();
  });

  test("has_next_page=true with null cursor throws a CliError", async () => {
    // Server returns has_next_page but no starting_after — defensive cursor guard.
    mockListWebhookEventTypes.mockResolvedValue(catalogPage(["other.event"], true, null));

    await expect(webhooksTrigger({ eventType: "user.created" })).rejects.toThrow(
      "Server returned has_next_page=true with no pagination cursor",
    );
    expect(mockSendWebhookExample).not.toHaveBeenCalled();
  });

  test("maps a PLAPI 404 on send to webhook_endpoint_not_found", async () => {
    mockSendWebhookExample.mockRejectedValue(new PlapiError(404, "{}"));

    await expect(
      webhooksTrigger({ eventType: "user.created", endpoint: "ep_missing" }),
    ).rejects.toMatchObject({ code: ERROR_CODE.WEBHOOK_ENDPOINT_NOT_FOUND });
  });
});

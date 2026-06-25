import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { ERROR_CODE, PlapiError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockListWebhookMessages = mock();
mock.module("../../lib/plapi.ts", () => ({
  listWebhookMessages: (...args: unknown[]) => mockListWebhookMessages(...args),
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

const { webhooksMessages } = await import("./messages.ts");

const mockMessages = [
  {
    id: "msg_1",
    event_type: "user.created",
    status: "success",
    next_attempt: null,
    payload: { object: "event" },
    created_at: "2026-06-09T12:00:00Z",
  },
  {
    id: "msg_2",
    event_type: "user.deleted",
    status: "fail",
    next_attempt: "2026-06-09T12:05:00Z",
    payload: { object: "event" },
    created_at: "2026-06-09T12:01:00Z",
  },
];

function messagesResponse(hasNextPage = false) {
  return {
    data: mockMessages,
    cursor: { starting_after: "iter_next", ending_before: null, has_next_page: hasNextPage },
  };
}

describe("webhooks messages", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockGetRelayEntry.mockResolvedValue(undefined);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_1",
      appLabel: "My App",
      instanceId: "ins_1",
      instanceLabel: "development",
    });
    mockListWebhookMessages.mockResolvedValue(messagesResponse());
  });

  afterEach(() => {
    mockListWebhookMessages.mockReset();
    mockResolveAppContext.mockReset();
    mockGetRelayEntry.mockReset();
    mockIsAgent.mockReset();
  });

  test("lists deliveries for an explicit --endpoint", async () => {
    await webhooksMessages({ endpoint: "ep_1" });

    expect(mockListWebhookMessages).toHaveBeenCalledWith("app_1", "ins_1", "ep_1", {
      limit: 100,
      iterator: undefined,
      status: undefined,
    });
  });

  test("defaults --endpoint to the persisted relay endpoint", async () => {
    mockGetRelayEntry.mockResolvedValue({ token: "Ab12Cd34Ef", endpoint_id: "ep_relay" });

    await webhooksMessages();

    expect(mockGetRelayEntry).toHaveBeenCalledWith("ins_1");
    expect(mockListWebhookMessages).toHaveBeenCalledWith(
      "app_1",
      "ins_1",
      "ep_relay",
      expect.anything(),
    );
  });

  test("no --endpoint and no relay endpoint is a usage error", async () => {
    await expect(webhooksMessages()).rejects.toMatchObject({
      code: ERROR_CODE.USAGE_ERROR,
      message:
        "No relay endpoint found for this instance. Run 'clerk webhooks listen' first, or pass --endpoint <ep_id>.",
    });
    expect(mockListWebhookMessages).not.toHaveBeenCalled();
  });

  test("forwards --status, --limit, and --iterator", async () => {
    await webhooksMessages({ endpoint: "ep_1", status: "fail", limit: 10, iterator: "iter_x" });

    expect(mockListWebhookMessages).toHaveBeenCalledWith("app_1", "ins_1", "ep_1", {
      limit: 10,
      iterator: "iter_x",
      status: "fail",
    });
  });

  test("prints a delivery table in human mode", async () => {
    await webhooksMessages({ endpoint: "ep_1" });

    expect(captured.out).toBe("");
    expect(captured.err).toContain("msg_1");
    expect(captured.err).toContain("user.created");
    expect(captured.err).toContain("fail");
    expect(captured.err).toContain("2 deliveries returned");
  });

  test("warns when the endpoint has no deliveries", async () => {
    mockListWebhookMessages.mockResolvedValue({
      data: [],
      cursor: { starting_after: null, ending_before: null, has_next_page: false },
    });

    await webhooksMessages({ endpoint: "ep_1" });

    expect(captured.err).toContain("No deliveries found");
  });

  test("prints iterator hint on empty-data page when more results exist", async () => {
    mockListWebhookMessages.mockResolvedValue({
      data: [],
      cursor: { starting_after: "iter_next", ending_before: null, has_next_page: true },
    });

    await webhooksMessages({ endpoint: "ep_1" });

    expect(captured.err).toContain("No deliveries found");
    expect(captured.err).toContain("--iterator iter_next");
  });

  test("hints at the next --iterator value when more pages exist", async () => {
    mockListWebhookMessages.mockResolvedValue(messagesResponse(true));

    await webhooksMessages({ endpoint: "ep_1" });

    expect(captured.err).toContain("--iterator iter_next");
  });

  test("outputs the full response (including payloads) as JSON with --json", async () => {
    await webhooksMessages({ endpoint: "ep_1", json: true });

    expect(JSON.parse(captured.out)).toEqual(messagesResponse());
    expect(captured.err).toBe("");
  });

  test("outputs JSON in agent mode without --json", async () => {
    mockIsAgent.mockReturnValue(true);

    await webhooksMessages({ endpoint: "ep_1" });

    expect(JSON.parse(captured.out)).toEqual(messagesResponse());
  });

  test("maps a PLAPI 404 to webhook_endpoint_not_found", async () => {
    mockListWebhookMessages.mockRejectedValue(new PlapiError(404, "{}"));

    await expect(webhooksMessages({ endpoint: "ep_missing" })).rejects.toMatchObject({
      code: ERROR_CODE.WEBHOOK_ENDPOINT_NOT_FOUND,
    });
  });
});

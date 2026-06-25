import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockListWebhookEventTypes = mock();
mock.module("../../lib/plapi.ts", () => ({
  listWebhookEventTypes: (...args: unknown[]) => mockListWebhookEventTypes(...args),
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

const { webhooksEventTypes } = await import("./event-types.ts");

const mockEventTypes = [
  {
    name: "user.created",
    description: "A user was created",
    archived: false,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  },
  {
    name: "session.removed",
    description: "A session was removed",
    archived: true,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  },
];

function eventTypesResponse(hasNextPage = false) {
  return {
    data: mockEventTypes,
    cursor: { starting_after: "iter_next", ending_before: null, has_next_page: hasNextPage },
  };
}

describe("webhooks event-types", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_1",
      appLabel: "My App",
      instanceId: "ins_1",
      instanceLabel: "development",
    });
    mockListWebhookEventTypes.mockResolvedValue(eventTypesResponse());
  });

  afterEach(() => {
    mockListWebhookEventTypes.mockReset();
    mockResolveAppContext.mockReset();
    mockIsAgent.mockReset();
  });

  test("fetches one page with the default limit", async () => {
    await webhooksEventTypes();

    expect(mockListWebhookEventTypes).toHaveBeenCalledWith("app_1", "ins_1", {
      limit: 100,
      iterator: undefined,
    });
  });

  test("forwards --limit and --iterator", async () => {
    await webhooksEventTypes({ limit: 5, iterator: "iter_prev" });

    expect(mockListWebhookEventTypes).toHaveBeenCalledWith("app_1", "ins_1", {
      limit: 5,
      iterator: "iter_prev",
    });
  });

  test("prints names and descriptions, marking archived types", async () => {
    await webhooksEventTypes();

    expect(captured.out).toBe("");
    expect(captured.err).toContain("user.created");
    expect(captured.err).toContain("A user was created");
    expect(captured.err).toContain("session.removed");
    expect(captured.err).toContain("(archived)");
    expect(captured.err).toContain("2 event types returned");
  });

  test("hints at the next --iterator value when more pages exist", async () => {
    mockListWebhookEventTypes.mockResolvedValue(eventTypesResponse(true));

    await webhooksEventTypes();

    expect(captured.err).toContain("--iterator iter_next");
  });

  test("warns when the catalog is empty", async () => {
    mockListWebhookEventTypes.mockResolvedValue({
      data: [],
      cursor: { starting_after: null, ending_before: null, has_next_page: false },
    });

    await webhooksEventTypes();

    expect(captured.err).toContain("No event types found.");
  });

  test("prints iterator hint on empty-data page when more results exist", async () => {
    mockListWebhookEventTypes.mockResolvedValue({
      data: [],
      cursor: { starting_after: "iter_next", ending_before: null, has_next_page: true },
    });

    await webhooksEventTypes();

    expect(captured.err).toContain("No event types found.");
    expect(captured.err).toContain("--iterator iter_next");
  });

  test("outputs the full response as JSON with --json", async () => {
    await webhooksEventTypes({ json: true });

    expect(JSON.parse(captured.out)).toEqual(eventTypesResponse());
    expect(captured.err).toBe("");
  });

  test("outputs JSON in agent mode without --json", async () => {
    mockIsAgent.mockReturnValue(true);

    await webhooksEventTypes();

    expect(JSON.parse(captured.out)).toEqual(eventTypesResponse());
  });
});

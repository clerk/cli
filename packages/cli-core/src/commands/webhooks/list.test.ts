import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockListWebhookEndpoints = mock();
mock.module("../../lib/plapi.ts", () => ({
  listWebhookEndpoints: (...args: unknown[]) => mockListWebhookEndpoints(...args),
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

const { webhooksList } = await import("./list.ts");

const mockEndpoints = [
  {
    id: "ep_1",
    url: "https://example.com/webhooks",
    version: 1,
    description: "Primary",
    disabled: false,
    filter_types: ["user.created"],
    channels: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  },
  {
    id: "ep_2",
    url: "https://example.com/other",
    version: 1,
    disabled: true,
    filter_types: null,
    channels: null,
    created_at: "2026-06-02T00:00:00Z",
    updated_at: "2026-06-02T00:00:00Z",
  },
];

function listResponse(overrides: Partial<{ data: unknown[]; has_next_page: boolean }> = {}) {
  return {
    data: overrides.data ?? mockEndpoints,
    cursor: {
      starting_after: "iter_next",
      ending_before: null,
      has_next_page: overrides.has_next_page ?? false,
    },
  };
}

describe("webhooks list", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_1",
      appLabel: "My App",
      instanceId: "ins_1",
      instanceLabel: "development",
    });
    mockListWebhookEndpoints.mockResolvedValue(listResponse());
  });

  afterEach(() => {
    mockListWebhookEndpoints.mockReset();
    mockResolveAppContext.mockReset();
    mockIsAgent.mockReset();
  });

  test("fetches one page with the default limit", async () => {
    await webhooksList();

    expect(mockResolveAppContext).toHaveBeenCalledWith({});
    expect(mockListWebhookEndpoints).toHaveBeenCalledWith("app_1", "ins_1", {
      limit: 100,
      iterator: undefined,
    });
  });

  test("forwards --limit and --iterator", async () => {
    await webhooksList({ limit: 25, iterator: "iter_prev" });

    expect(mockListWebhookEndpoints).toHaveBeenCalledWith("app_1", "ins_1", {
      limit: 25,
      iterator: "iter_prev",
    });
  });

  test("forwards --app and --instance to context resolution", async () => {
    await webhooksList({ app: "app_2", instance: "prod" });

    expect(mockResolveAppContext).toHaveBeenCalledWith({ app: "app_2", instance: "prod" });
  });

  test("prints a human-readable table by default", async () => {
    await webhooksList();

    expect(captured.out).toBe("");
    expect(captured.err).toContain("ep_1");
    expect(captured.err).toContain("https://example.com/webhooks");
    expect(captured.err).toContain("user.created");
    expect(captured.err).toContain("disabled");
    expect(captured.err).toContain("2 endpoints returned");
  });

  test("warns when no endpoints exist", async () => {
    mockListWebhookEndpoints.mockResolvedValue(listResponse({ data: [] }));

    await webhooksList();

    expect(captured.out).toBe("");
    expect(captured.err).toContain("No webhook endpoints found.");
  });

  test("hints at the next --iterator value when more pages exist", async () => {
    mockListWebhookEndpoints.mockResolvedValue(listResponse({ has_next_page: true }));

    await webhooksList();

    expect(captured.err).toContain("--iterator iter_next");
  });

  test("omits the pagination hint on the last page", async () => {
    await webhooksList();

    expect(captured.err).not.toContain("--iterator");
  });

  test("outputs the full list response as JSON with --json", async () => {
    await webhooksList({ json: true });

    expect(JSON.parse(captured.out)).toEqual(listResponse());
    expect(captured.err).toBe("");
  });

  test("outputs JSON in agent mode without --json", async () => {
    mockIsAgent.mockReturnValue(true);

    await webhooksList();

    expect(JSON.parse(captured.out)).toEqual(listResponse());
    expect(captured.err).toBe("");
  });
});

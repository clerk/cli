import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { ERROR_CODE, PlapiError } from "../../lib/errors.ts";
import { stubFetch, useCaptureLog } from "../../test/lib/stubs.ts";
import type { RelayEventFrame } from "./relay-protocol.ts";

type EventHandler = (event: RelayEventFrame, reply: (frame: string) => void) => void;

interface FakeClientOptions {
  token: string;
  onEvent: EventHandler;
  onTokenRotated: (token: string) => Promise<void>;
  onReconnect: () => void;
}

const relayClients: FakeRelayClient[] = [];
const lastClient = () => relayClients.at(-1);

class FakeRelayClient {
  token: string;
  started = false;
  stopped = false;

  constructor(readonly options: FakeClientOptions) {
    this.token = options.token;
    relayClients.push(this);
  }

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  stop(): void {
    this.stopped = true;
  }
}

mock.module("./relay-client.ts", () => ({ RelayClient: FakeRelayClient }));

const mockGetWebhookEndpoint = mock();
const mockCreateWebhookEndpoint = mock();
const mockUpdateWebhookEndpoint = mock();
const mockGetWebhookEndpointSecret = mock();
mock.module("../../lib/plapi.ts", () => ({
  getWebhookEndpoint: (...args: unknown[]) => mockGetWebhookEndpoint(...args),
  createWebhookEndpoint: (...args: unknown[]) => mockCreateWebhookEndpoint(...args),
  updateWebhookEndpoint: (...args: unknown[]) => mockUpdateWebhookEndpoint(...args),
  getWebhookEndpointSecret: (...args: unknown[]) => mockGetWebhookEndpointSecret(...args),
}));

const mockResolveAppContext = mock();
const mockGetRelayEntry = mock();
const mockSetRelayEntry = mock();
mock.module("../../lib/config.ts", () => ({
  resolveAppContext: (...args: unknown[]) => mockResolveAppContext(...args),
  getRelayEntry: (...args: unknown[]) => mockGetRelayEntry(...args),
  setRelayEntry: (...args: unknown[]) => mockSetRelayEntry(...args),
}));

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

const { webhooksListen } = await import("./listen.ts");

const KEY = randomBytes(24);
const SECRET = `whsec_${KEY.toString("base64")}`;

const relayEndpoint = (overrides: Record<string, unknown> = {}) => ({
  id: "ep_relay",
  url: "https://play.svix.com/in/Ab12Cd34Ef/",
  version: 1,
  disabled: false,
  filter_types: null,
  channels: null,
  created_at: "2026-06-09T00:00:00Z",
  updated_at: "2026-06-09T00:00:00Z",
  ...overrides,
});

function signedEvent(body: string, overrides: Partial<RelayEventFrame> = {}): RelayEventFrame {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1,${createHmac("sha256", KEY).update(`msg_1.${timestamp}.${body}`, "utf8").digest("base64")}`;
  return {
    id: "frame_1",
    method: "POST",
    headers: {
      "svix-id": "msg_1",
      "svix-timestamp": timestamp,
      "svix-signature": signature,
      "content-type": "application/json",
    },
    bodyB64: Buffer.from(body, "utf8").toString("base64"),
    ...overrides,
  };
}

/** listen never resolves; run it and wait until the ready output lands. */
async function startListen(
  options: Parameters<typeof webhooksListen>[0],
  captured: { out: string; err: string },
): Promise<void> {
  const run = webhooksListen(options);
  run.catch(() => {});
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (captured.out.includes('"ready"') || captured.err.includes("Webhook relay ready")) return;
  }
  throw new Error("listen never became ready");
}

describe("webhooks listen", () => {
  const captured = useCaptureLog();
  const originalFetch = globalThis.fetch;
  let savedSigintListeners: NodeJS.SignalsListener[] = [];

  beforeEach(() => {
    savedSigintListeners = process.listeners("SIGINT") as NodeJS.SignalsListener[];
    mockIsAgent.mockReturnValue(false);
    relayClients.length = 0;
    mockResolveAppContext.mockResolvedValue({
      appId: "app_1",
      appLabel: "My App",
      instanceId: "ins_1",
      instanceLabel: "development",
    });
    mockGetRelayEntry.mockResolvedValue({ token: "Ab12Cd34Ef", endpoint_id: "ep_relay" });
    mockSetRelayEntry.mockResolvedValue(undefined);
    mockGetWebhookEndpoint.mockResolvedValue(relayEndpoint());
    mockCreateWebhookEndpoint.mockResolvedValue(relayEndpoint());
    mockUpdateWebhookEndpoint.mockImplementation(
      async (_app: string, _ins: string, _ep: string, patch: Record<string, unknown>) =>
        relayEndpoint(patch),
    );
    mockGetWebhookEndpointSecret.mockResolvedValue({ secret: SECRET });
  });

  afterEach(() => {
    process.removeAllListeners("SIGINT");
    for (const listener of savedSigintListeners) process.on("SIGINT", listener);
    globalThis.fetch = originalFetch;
    mockGetWebhookEndpoint.mockReset();
    mockCreateWebhookEndpoint.mockReset();
    mockUpdateWebhookEndpoint.mockReset();
    mockGetWebhookEndpointSecret.mockReset();
    mockResolveAppContext.mockReset();
    mockGetRelayEntry.mockReset();
    mockSetRelayEntry.mockReset();
    mockIsAgent.mockReset();
  });

  test("invalid --headers is a usage error before any network call", async () => {
    await expect(webhooksListen({ headers: "not-a-pair" })).rejects.toMatchObject({
      code: ERROR_CODE.USAGE_ERROR,
    });
    expect(mockResolveAppContext).not.toHaveBeenCalled();
  });

  test("first run generates and persists a c_-prefixed base62 token, then creates the endpoint", async () => {
    mockGetRelayEntry.mockResolvedValue(undefined);

    await startListen({}, captured);

    const [firstInstanceId, firstEntry] = mockSetRelayEntry.mock.calls[0] as [
      string,
      { token: string },
    ];
    const persistedToken = firstEntry.token;
    expect(firstInstanceId).toBe("ins_1");
    expect(persistedToken).toMatch(/^c_[0-9A-Za-z]{10}$/);

    expect(mockCreateWebhookEndpoint).toHaveBeenCalledWith("app_1", "ins_1", {
      url: `https://play.svix.com/in/${persistedToken}/`,
      version: 1,
    });
    expect(mockSetRelayEntry).toHaveBeenLastCalledWith("ins_1", {
      token: persistedToken,
      endpoint_id: "ep_relay",
    });
  });

  test("reuses the persisted endpoint without patching when nothing changed", async () => {
    await startListen({}, captured);

    expect(mockGetWebhookEndpoint).toHaveBeenCalledWith("app_1", "ins_1", "ep_relay");
    expect(mockCreateWebhookEndpoint).not.toHaveBeenCalled();
    expect(mockUpdateWebhookEndpoint).not.toHaveBeenCalled();
    expect(captured.err).toContain("Webhook relay ready");
    expect(captured.err).toContain(SECRET);
  });

  test("PATCHes filter_types (with a warning) when --events differs", async () => {
    await startListen({ events: "user.created,user.deleted" }, captured);

    expect(mockUpdateWebhookEndpoint).toHaveBeenCalledWith("app_1", "ins_1", "ep_relay", {
      filter_types: ["user.created", "user.deleted"],
    });
    expect(captured.err).toContain("affects any other");
  });

  test("recreates the endpoint when the persisted one returns 404", async () => {
    mockGetWebhookEndpoint.mockRejectedValue(new PlapiError(404, "{}"));

    await startListen({}, captured);

    expect(mockCreateWebhookEndpoint).toHaveBeenCalled();
  });

  test("emits the NDJSON ready line in agent mode", async () => {
    mockIsAgent.mockReturnValue(true);

    await startListen({ forwardTo: "http://localhost:3000/api/webhooks" }, captured);

    const ready = JSON.parse(captured.out) as Record<string, unknown>;
    expect(ready).toEqual({
      type: "ready",
      relay_url: "https://play.svix.com/in/Ab12Cd34Ef/",
      signing_secret: SECRET,
      endpoint_id: "ep_relay",
      events_filter: null,
    });
  });

  test("registers its own SIGINT handler before the socket opens", async () => {
    await startListen({}, captured);

    expect(process.listenerCount("SIGINT")).toBe(1);
    expect(lastClient()?.started).toBe(true);
  });

  test("deliveries arriving before the secret fetch wait for setup to finish", async () => {
    mockIsAgent.mockReturnValue(true);
    let releaseSecret!: (value: { secret: string }) => void;
    mockGetWebhookEndpointSecret.mockReturnValue(
      new Promise((resolve) => {
        releaseSecret = resolve;
      }),
    );

    const run = webhooksListen({});
    run.catch(() => {});
    for (let i = 0; i < 50 && !lastClient(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    lastClient()!.options.onEvent(signedEvent('{"type":"user.created"}'), () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captured.out).not.toContain('"type":"event"');
    expect(captured.err).not.toContain("signature verification failed");

    releaseSecret({ secret: SECRET });
    for (let i = 0; i < 50 && !captured.out.includes('"type":"event"'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const readyIndex = captured.out.indexOf('"ready"');
    const eventIndex = captured.out.indexOf('"type":"event"');
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    expect(eventIndex).toBeGreaterThan(readyIndex);
    expect(captured.err).not.toContain("signature verification failed");
  });

  test("delivery without --forward-to replies a synthetic 200 and emits forward_status null", async () => {
    mockIsAgent.mockReturnValue(true);

    await startListen({}, captured);
    captured.clear();

    const replies: string[] = [];
    lastClient()!.options.onEvent(signedEvent('{"type":"user.created"}'), (frame) =>
      replies.push(frame),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(JSON.parse(replies[0]!)).toEqual({
      type: "event",
      version: 1,
      data: { id: "frame_1", status: 200, headers: {}, body: "" },
    });

    const line = JSON.parse(captured.out) as Record<string, unknown>;
    expect(line.type).toBe("event");
    expect(line.svix_id).toBe("msg_1");
    expect(line.event_type).toBe("user.created");
    expect(line.forward_status).toBeNull();
    expect(captured.err).toBe(""); // no verification warning for a valid signature
  });

  test("delivery with --forward-to POSTs to the handler and frames the response back", async () => {
    mockIsAgent.mockReturnValue(true);
    let forwarded: { url: string; headers: Headers; body: string } | undefined;
    stubFetch(async (input, init) => {
      forwarded = {
        url: input.toString(),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      };
      return new Response("handled", { status: 201 });
    });

    await startListen(
      { forwardTo: "http://localhost:3000/api/webhooks", headers: "x-env:dev" },
      captured,
    );
    captured.clear();

    const replies: string[] = [];
    lastClient()!.options.onEvent(signedEvent('{"type":"user.created"}'), (frame) =>
      replies.push(frame),
    );
    for (let i = 0; i < 20 && replies.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(forwarded?.url).toBe("http://localhost:3000/api/webhooks");
    expect(forwarded?.headers.get("svix-id")).toBe("msg_1");
    expect(forwarded?.headers.get("x-env")).toBe("dev");
    expect(forwarded?.body).toBe('{"type":"user.created"}');

    const reply = JSON.parse(replies[0]!) as { data: { status: number; body: string } };
    expect(reply.data.status).toBe(201);
    expect(Buffer.from(reply.data.body, "base64").toString("utf8")).toBe("handled");

    const line = JSON.parse(captured.out) as { forward_status: number };
    expect(line.forward_status).toBe(201);
  });

  test("warns on an invalid signature but still forwards", async () => {
    mockIsAgent.mockReturnValue(true);

    await startListen({}, captured);
    captured.clear();

    const event = signedEvent('{"type":"user.created"}');
    event.headers["svix-signature"] = "v1,Zm9yZ2VkIHNpZ25hdHVyZQ==";
    lastClient()!.options.onEvent(event, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captured.err).toContain("signature verification failed for msg_1");
    expect(captured.out).toContain('"type":"event"');
  });

  test("--skip-verify suppresses the signature warning", async () => {
    mockIsAgent.mockReturnValue(true);

    await startListen({ skipVerify: true }, captured);
    captured.clear();

    const event = signedEvent('{"type":"user.created"}');
    event.headers["svix-signature"] = "v1,Zm9yZ2VkIHNpZ25hdHVyZQ==";
    lastClient()!.options.onEvent(event, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captured.err).toBe("");
  });

  test("token rotation persists the new token and re-points the endpoint URL", async () => {
    await startListen({}, captured);

    await lastClient()!.options.onTokenRotated("Zz98Yy76Xx");

    expect(mockSetRelayEntry).toHaveBeenLastCalledWith("ins_1", {
      token: "Zz98Yy76Xx",
      endpoint_id: "ep_relay",
    });
    expect(mockUpdateWebhookEndpoint).toHaveBeenCalledWith("app_1", "ins_1", "ep_relay", {
      url: "https://play.svix.com/in/Zz98Yy76Xx/",
    });
  });
});

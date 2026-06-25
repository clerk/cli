import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { ERROR_CODE } from "../../lib/errors.ts";
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

const mockGetRelayEntry = mock();
const mockSetRelayEntry = mock();
mock.module("../../lib/config.ts", () => ({
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

const RELAY_KEY = "__relay_only__";

function event(body: string, overrides: Partial<RelayEventFrame> = {}): RelayEventFrame {
  return {
    id: "frame_1",
    method: "POST",
    headers: {
      "svix-id": "msg_1",
      "svix-timestamp": "1717935000",
      "svix-signature": "v1,Zm9yZ2VkIHNpZ25hdHVyZQ==",
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

describe("webhooks listen (V1, relay-only)", () => {
  const captured = useCaptureLog();
  const originalFetch = globalThis.fetch;
  let savedSigintListeners: NodeJS.SignalsListener[] = [];

  beforeEach(() => {
    savedSigintListeners = process.listeners("SIGINT") as NodeJS.SignalsListener[];
    mockIsAgent.mockReturnValue(false);
    relayClients.length = 0;
    mockGetRelayEntry.mockResolvedValue(undefined);
    mockSetRelayEntry.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.removeAllListeners("SIGINT");
    for (const listener of savedSigintListeners) process.on("SIGINT", listener);
    globalThis.fetch = originalFetch;
    mockGetRelayEntry.mockReset();
    mockSetRelayEntry.mockReset();
    mockIsAgent.mockReset();
  });

  test("invalid --headers is a usage error before any persistence", async () => {
    await expect(webhooksListen({ headers: "not-a-pair" })).rejects.toMatchObject({
      code: ERROR_CODE.USAGE_ERROR,
    });
    expect(mockGetRelayEntry).not.toHaveBeenCalled();
  });

  test("first run generates and persists a c_-prefixed token under the reserved key", async () => {
    await startListen({}, captured);

    expect(mockGetRelayEntry).toHaveBeenCalledWith(RELAY_KEY);
    const [key, entry] = mockSetRelayEntry.mock.calls[0] as [string, { token: string }];
    expect(key).toBe(RELAY_KEY);
    expect(entry.token).toMatch(/^c_[0-9A-Za-z]{10}$/);
    expect(lastClient()?.started).toBe(true);
    expect(lastClient()?.token).toBe(entry.token);
    // No backend: the banner never carries a signing secret.
    expect(captured.err).toContain("Webhook relay ready");
  });

  test("reuses the persisted token across runs (stable URL), no rewrite when unchanged", async () => {
    mockGetRelayEntry.mockResolvedValue({ token: "c_Persisted1" });

    await startListen({}, captured);

    expect(lastClient()?.token).toBe("c_Persisted1");
    expect(mockSetRelayEntry).not.toHaveBeenCalled();
  });

  test("--token pins the token", async () => {
    await startListen({ token: "c_Pinned1234" }, captured);

    expect(lastClient()?.token).toBe("c_Pinned1234");
    expect(mockSetRelayEntry).toHaveBeenCalledWith(RELAY_KEY, { token: "c_Pinned1234" });
  });

  test("--token with a malformed value is a usage error", async () => {
    await expect(webhooksListen({ token: "nope" })).rejects.toMatchObject({
      code: ERROR_CODE.USAGE_ERROR,
    });
  });

  test("without --token, the banner warns the token is auto-generated and how to pin it", async () => {
    mockGetRelayEntry.mockResolvedValue(undefined);

    await startListen({ forwardTo: "http://localhost:3000/api/webhooks" }, captured);

    expect(captured.err).toContain("auto-generated relay token");
    expect(captured.err).toContain("--token");
    expect(captured.err).toContain("clerk webhooks token");
  });

  test("with --token, no auto-generated-token warning is shown", async () => {
    await startListen(
      { token: "c_Pinned1234", forwardTo: "http://localhost:3000/api/webhooks" },
      captured,
    );

    expect(captured.err).not.toContain("auto-generated relay token");
  });

  test("emits the NDJSON ready line in agent mode (endpoint_id and events_filter are null)", async () => {
    mockIsAgent.mockReturnValue(true);
    mockGetRelayEntry.mockResolvedValue({ token: "c_Stable9999" });

    await startListen({ forwardTo: "http://localhost:3000/api/webhooks" }, captured);

    const ready = JSON.parse(captured.out) as Record<string, unknown>;
    expect(ready).toEqual({
      type: "ready",
      relay_url: "https://play.svix.com/in/c_Stable9999/",
      endpoint_id: null,
      events_filter: null,
      forward_to: "http://localhost:3000/api/webhooks",
    });
    expect(ready).not.toHaveProperty("signing_secret");
  });

  test("registers its own SIGINT handler before the socket opens", async () => {
    await startListen({}, captured);

    expect(process.listenerCount("SIGINT")).toBe(1);
    expect(lastClient()?.started).toBe(true);
  });

  test("delivery without --forward-to replies a synthetic 200 and emits forward_status null", async () => {
    mockIsAgent.mockReturnValue(true);

    await startListen({}, captured);
    captured.clear();

    const replies: string[] = [];
    lastClient()!.options.onEvent(event('{"type":"user.created"}'), (frame) => replies.push(frame));
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
    lastClient()!.options.onEvent(event('{"type":"user.created"}'), (frame) => replies.push(frame));
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

  test("forwards without verifying — an unsigned/forged signature produces no warning", async () => {
    mockIsAgent.mockReturnValue(true);

    await startListen({}, captured);
    captured.clear();

    // Signature is intentionally bogus; V1 has no signing secret, so no verify.
    lastClient()!.options.onEvent(event('{"type":"user.created"}'), () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captured.err).not.toContain("verification");
    expect(captured.out).toContain('"type":"event"');
  });

  test("token rotation persists the new token under the reserved key", async () => {
    await startListen({}, captured);

    await lastClient()!.options.onTokenRotated("c_Zz98Yy76Xx");

    expect(mockSetRelayEntry).toHaveBeenLastCalledWith(RELAY_KEY, { token: "c_Zz98Yy76Xx" });
  });

  test("SIGINT stops the relay client and exits 130", async () => {
    await startListen({}, captured);

    const exitSpy = spyOn(process, "exit").mockImplementation((() => {}) as () => never);
    try {
      process.emit("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(lastClient()!.stopped).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(130);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("onReconnect logs a reconnecting message to stderr", async () => {
    await startListen({}, captured);
    captured.clear();

    lastClient()!.options.onReconnect();

    expect(captured.err).toContain("reconnect");
  });
});

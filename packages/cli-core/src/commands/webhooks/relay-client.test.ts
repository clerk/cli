import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import { RelayClient } from "./relay-client.ts";
import {
  RELAY_CLOSE_TOKEN_COLLISION,
  RELAY_RECONNECT_DELAY_MS,
  RELAY_SILENCE_TIMEOUT_MS,
  encodeStartFrame,
} from "./relay-protocol.ts";

/**
 * Stand-in for Bun's client WebSocket. Records what the client sends/pings,
 * and exposes manual `open()`/`message()`/`fireClose()` triggers so tests drive
 * the connection lifecycle without a real socket.
 */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  sent: string[] = [];
  pingCount = 0;
  closedWith: number | undefined;
  pingThrows = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  ping(): void {
    if (this.pingThrows) throw new Error("dead link");
    this.pingCount++;
  }

  close(code?: number): void {
    this.closedWith = code;
  }

  open(): void {
    this.onopen?.();
  }

  message(data: string): void {
    this.onmessage?.({ data });
  }

  fireClose(code: number): void {
    this.onclose?.({ code });
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Fetch a constructed socket, asserting it exists (satisfies noUncheckedIndexedAccess). */
function wsAt(index: number): FakeWebSocket {
  const ws = FakeWebSocket.instances[index];
  if (!ws) throw new Error(`expected a relay socket at index ${index}`);
  return ws;
}

// Captured timer callbacks so tests can invoke them on demand instead of waiting.
let intervalCallback: (() => void) | undefined;
let intervalDelay: number | undefined;
let timeoutCallback: (() => void) | undefined;
let timeoutDelay: number | undefined;
let now = 0;

const realWebSocket = globalThis.WebSocket;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now;

describe("RelayClient", () => {
  useCaptureLog();

  beforeEach(() => {
    FakeWebSocket.instances = [];
    intervalCallback = undefined;
    intervalDelay = undefined;
    timeoutCallback = undefined;
    timeoutDelay = undefined;
    now = 1_000_000;

    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    Date.now = () => now;
    globalThis.setInterval = ((fn: () => void, delay?: number) => {
      intervalCallback = fn;
      intervalDelay = delay;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      timeoutCallback = fn;
      timeoutDelay = delay;
      return 2 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.setTimeout = realSetTimeout;
    Date.now = realNow;
  });

  function makeClient(overrides: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
    const events: Array<{ id: string }> = [];
    const rotated: string[] = [];
    let reconnects = 0;
    const client = new RelayClient({
      token: "c_original00",
      url: "ws://relay.test",
      onEvent: (event) => events.push(event),
      onTokenRotated: async (token) => {
        rotated.push(token);
      },
      onReconnect: () => {
        reconnects++;
      },
      ...overrides,
    });
    return {
      client,
      events,
      rotated,
      get reconnects() {
        return reconnects;
      },
    };
  }

  async function openClient(overrides?: Partial<ConstructorParameters<typeof RelayClient>[0]>) {
    const harness = makeClient(overrides);
    const started = harness.client.start();
    wsAt(0).open();
    await started;
    return harness;
  }

  test("start() dials the override URL and sends the c_-prefixed start frame", async () => {
    const { client } = await openClient();
    const ws = wsAt(0);

    expect(ws.url).toBe("ws://relay.test");
    expect(ws.sent[0]).toBe(encodeStartFrame("c_original00"));
    expect(client.token).toBe("c_original00");
  });

  test("schedules the keepalive probe at RELAY_SILENCE_TIMEOUT_MS / 2", async () => {
    await openClient();
    expect(intervalDelay).toBe(RELAY_SILENCE_TIMEOUT_MS / 2);
  });

  test("keepalive pings only after RELAY_SILENCE_TIMEOUT_MS of silence", async () => {
    await openClient();
    const ws = wsAt(0);

    now += RELAY_SILENCE_TIMEOUT_MS - 1; // still within the window
    intervalCallback?.();
    expect(ws.pingCount).toBe(0);

    now += 2; // now past the silence threshold
    intervalCallback?.();
    expect(ws.pingCount).toBe(1);
  });

  test("an inbound message resets the silence clock, deferring the next ping", async () => {
    const { events } = await openClient();
    const ws = wsAt(0);

    now += RELAY_SILENCE_TIMEOUT_MS - 5;
    ws.message(
      JSON.stringify({
        type: "event",
        data: { id: "frm_1", method: "POST", headers: {}, body: "" },
      }),
    );
    expect(events).toHaveLength(1);

    // Only 5ms have elapsed since the message reset lastActivityAt.
    now += 5;
    intervalCallback?.();
    expect(ws.pingCount).toBe(0);
  });

  test("a dead-link ping closes the socket so the redial path fires", async () => {
    await openClient();
    const ws = wsAt(0);
    ws.pingThrows = true;

    now += RELAY_SILENCE_TIMEOUT_MS + 1;
    intervalCallback?.();
    expect(ws.closedWith).toBeUndefined(); // close() called with no code on ping failure
    expect(ws.pingCount).toBe(0);
  });

  test("a non-1008 close reconnects with the SAME token after the reconnect delay", async () => {
    const harness = await openClient();
    wsAt(0).fireClose(1006);

    expect(harness.reconnects).toBe(1);
    expect(timeoutDelay).toBe(RELAY_RECONNECT_DELAY_MS);
    expect(FakeWebSocket.instances).toHaveLength(1); // no redial until the timer fires

    timeoutCallback?.();
    expect(FakeWebSocket.instances).toHaveLength(2);
    wsAt(1).open();
    expect(wsAt(1).sent[0]).toBe(encodeStartFrame("c_original00"));
    expect(harness.rotated).toHaveLength(0);
  });

  test("a 1008 collision rotates to a fresh c_ token, persists it, and redials after the reconnect delay", async () => {
    const harness = await openClient();
    wsAt(0).fireClose(RELAY_CLOSE_TOKEN_COLLISION);
    await flush();

    expect(harness.client.token).not.toBe("c_original00");
    expect(harness.client.token).toMatch(/^c_[0-9A-Za-z]{10}$/);
    expect(harness.rotated).toEqual([harness.client.token]);

    // Redial is deferred through the reconnect backoff so a relay that rejects
    // every fresh token can't drive a zero-delay reconnect storm.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(timeoutDelay).toBe(RELAY_RECONNECT_DELAY_MS);

    timeoutCallback?.();
    expect(FakeWebSocket.instances).toHaveLength(2);
    wsAt(1).open();
    expect(wsAt(1).sent[0]).toBe(encodeStartFrame(harness.client.token));
    expect(harness.reconnects).toBe(0); // collision is not a generic reconnect
  });

  test("stop() before the socket opens suppresses the start frame and the keepalive probe", async () => {
    const harness = makeClient();
    void harness.client.start(); // never resolves; the socket never finishes opening
    const ws = wsAt(0);

    harness.client.stop();
    ws.open();

    expect(ws.sent).toHaveLength(0); // no start frame on a stopped client
    expect(ws.closedWith).toBe(1000);
    expect(intervalCallback).toBeUndefined(); // probe timer never armed
  });

  test("stop() closes with 1000 and suppresses any further reconnect", async () => {
    const harness = await openClient();
    const ws = wsAt(0);

    harness.client.stop();
    expect(ws.closedWith).toBe(1000);

    ws.fireClose(1000);
    expect(harness.reconnects).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test("ignores non-event frames without invoking onEvent", async () => {
    const { events } = await openClient();
    const ws = wsAt(0);

    ws.message(JSON.stringify({ type: "pong" }));
    ws.message("not json");
    expect(events).toHaveLength(0);
  });

  test("start() rejects when the socket never opens within the first-connect timeout", async () => {
    const harness = makeClient();
    const started = harness.client.start();
    // The fake setTimeout captures the start-timeout callback; fire it manually
    // to simulate the deadline expiring before the socket ever opens.
    expect(timeoutDelay).toBe(30_000); // default first-connect deadline
    timeoutCallback?.();
    await expect(started).rejects.toThrow("Cannot reach the Svix relay");
    // The client must be stopped so no reconnect loop runs.
    wsAt(0).fireClose(1006);
    expect(harness.reconnects).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

import { log } from "../../lib/log.ts";
import {
  RELAY_CLOSE_TOKEN_COLLISION,
  RELAY_RECONNECT_DELAY_MS,
  RELAY_SILENCE_TIMEOUT_MS,
  RELAY_WS_URL,
  decodeFrame,
  encodeStartFrame,
  generateRelayToken,
  type RelayEventFrame,
} from "./relay-protocol.ts";

export interface RelayClientOptions {
  token: string;
  /** Called per inbound delivery; `reply` sends a response frame back. */
  onEvent: (event: RelayEventFrame, reply: (frame: string) => void) => void;
  /** 1008 collision → a fresh token was generated; persist it (and re-point the endpoint). */
  onTokenRotated: (token: string) => Promise<void>;
  /** Connection dropped; redialing with the same token. */
  onReconnect: () => void;
  /** Test/env override for the relay WebSocket URL. */
  url?: string;
  /** Override the first-connect deadline (ms). Default 30 000. Tests pass a small value. */
  firstConnectTimeoutMs?: number;
}

/**
 * Long-lived relay WebSocket using Bun's built-in client. Reconnects with the
 * same token (the relay URL — and therefore the registered endpoint — never
 * changes across reconnects); rotates the token only on close code 1008.
 */
export class RelayClient {
  token: string;

  private ws: WebSocket | undefined;
  private stopped = false;
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private lastActivityAt = Date.now();
  private resolveFirstOpen: (() => void) | undefined;
  private rejectFirstOpen: ((err: Error) => void) | undefined;
  private startTimeoutId: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: RelayClientOptions) {
    this.token = options.token;
  }

  /** Dial and resolve once the first connection is open and handshaken. */
  start(): Promise<void> {
    const FIRST_CONNECT_TIMEOUT_MS = this.options.firstConnectTimeoutMs ?? 30_000;
    const opened = new Promise<void>((resolve, reject) => {
      this.rejectFirstOpen = reject;
      this.resolveFirstOpen = () => {
        clearTimeout(this.startTimeoutId);
        this.startTimeoutId = undefined;
        resolve();
      };
    });
    this.startTimeoutId = setTimeout(() => {
      this.stopped = true;
      this.clearProbe();
      this.ws?.close();
      this.rejectFirstOpen?.(
        new Error("Cannot reach the Svix relay — check your network and try again."),
      );
    }, FIRST_CONNECT_TIMEOUT_MS);
    this.connect();
    return opened;
  }

  /** Close the socket and stop reconnecting. Never deletes the relay endpoint. */
  stop(): void {
    this.stopped = true;
    this.clearProbe();
    this.ws?.close(1000);
  }

  private connect(): void {
    if (this.stopped) return;

    const ws = new WebSocket(this.options.url ?? RELAY_WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      // stop() may have raced in between `new WebSocket` and this open; if so,
      // don't send the start frame, arm the probe timer, or resolve start().
      if (this.stopped) {
        ws.close(1000);
        return;
      }
      log.debug(`relay: connected, sending start frame (token=${this.token.slice(0, 2)}***)`);
      ws.send(encodeStartFrame(this.token));
      this.lastActivityAt = Date.now();
      this.startProbe(ws);
      this.resolveFirstOpen?.();
      this.resolveFirstOpen = undefined;
      this.rejectFirstOpen = undefined;
    };

    ws.onmessage = (message) => {
      this.lastActivityAt = Date.now();
      const raw = typeof message.data === "string" ? message.data : String(message.data);
      const decoded = decodeFrame(raw);
      if (decoded.type !== "event") {
        log.debug(`relay: ignoring non-event frame: ${raw.slice(0, 200)}`);
        return;
      }
      this.options.onEvent(decoded.event, (frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      });
    };

    ws.onerror = () => {
      log.debug("relay: socket error");
    };

    ws.onclose = (event) => {
      this.clearProbe();
      if (this.stopped) return;

      if (event.code === RELAY_CLOSE_TOKEN_COLLISION) {
        // Another listener holds this token: rotate, persist, redial. Reconnect
        // through the same backoff as a normal drop so a relay that rejects
        // every fresh token can't spin a zero-delay reconnect storm.
        this.token = generateRelayToken();
        log.debug("relay: token collision (1008), rotating token");
        void this.options.onTokenRotated(this.token).then(() => {
          if (this.stopped) return;
          setTimeout(() => this.connect(), RELAY_RECONNECT_DELAY_MS);
        });
        return;
      }

      log.debug(`relay: connection closed (code=${event.code}), reconnecting`);
      this.options.onReconnect();
      setTimeout(() => this.connect(), RELAY_RECONNECT_DELAY_MS);
    };
  }

  private startProbe(ws: WebSocket): void {
    this.clearProbe();
    // Bun's client WebSocket auto-pongs server pings below the JS API, so
    // silence is unobservable directly. After RELAY_SILENCE_TIMEOUT_MS without
    // any message we send a client ping: writes to a dead link fail and fire
    // close/error, which triggers the same-token redial above.
    this.probeTimer = setInterval(() => {
      if (Date.now() - this.lastActivityAt < RELAY_SILENCE_TIMEOUT_MS) return;
      try {
        ws.ping();
        this.lastActivityAt = Date.now();
      } catch {
        ws.close();
      }
    }, RELAY_SILENCE_TIMEOUT_MS / 2);
  }

  private clearProbe(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = undefined;
  }
}

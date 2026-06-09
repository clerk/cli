import { test, expect, describe } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import type { ForwardOutcome } from "./forward.ts";
import {
  buildEventLine,
  buildReadyLine,
  renderArrival,
  renderForwardDiagnostics,
  renderForwardResult,
  renderReadyBanner,
  renderVerificationWarning,
} from "./render.ts";

function outcome(overrides: Partial<ForwardOutcome> = {}): ForwardOutcome {
  return {
    status: 200,
    headers: {},
    bodyText: "",
    bodyB64: "",
    latencyMs: 12,
    failed: false,
    ...overrides,
  };
}

describe("buildReadyLine", () => {
  test("matches the agent-mode ready contract", () => {
    const line = buildReadyLine({
      relayUrl: "https://play.svix.com/in/Ab12Cd34Ef/",
      signingSecret: "whsec_abc",
      endpointId: "ep_1",
      eventsFilter: ["user.created"],
      forwardTo: "http://localhost:3000/api/webhooks",
    });

    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      type: "ready",
      relay_url: "https://play.svix.com/in/Ab12Cd34Ef/",
      signing_secret: "whsec_abc",
      endpoint_id: "ep_1",
      events_filter: ["user.created"],
    });
  });
});

describe("buildEventLine", () => {
  test("matches the agent-mode event contract", () => {
    const line = buildEventLine({
      svixId: "msg_1",
      eventType: "user.created",
      headers: { "svix-id": "msg_1", "svix-timestamp": "1717935000", "svix-signature": "v1,abc" },
      bodyB64: "e30=",
      forwardStatus: 200,
      latencyMs: 12,
    });

    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      type: "event",
      svix_id: "msg_1",
      event_type: "user.created",
      headers: { "svix-id": "msg_1", "svix-timestamp": "1717935000", "svix-signature": "v1,abc" },
      body_b64: "e30=",
      forward_status: 200,
      latency_ms: 12,
    });
  });

  test("forward_status is null when not forwarding", () => {
    const parsed = JSON.parse(
      buildEventLine({
        svixId: "msg_1",
        eventType: "user.created",
        headers: {},
        bodyB64: "",
        forwardStatus: null,
        latencyMs: 0,
      }),
    ) as { forward_status: number | null };

    expect(parsed.forward_status).toBeNull();
  });
});

describe("human rendering", () => {
  const captured = useCaptureLog();

  test("ready banner shows the secret, relay URL, and endpoint", () => {
    renderReadyBanner({
      relayUrl: "https://play.svix.com/in/Ab12Cd34Ef/",
      signingSecret: "whsec_abc",
      endpointId: "ep_1",
      eventsFilter: null,
      forwardTo: null,
    });

    expect(captured.err).toContain("whsec_abc");
    expect(captured.err).toContain("https://play.svix.com/in/Ab12Cd34Ef/");
    expect(captured.err).toContain("ep_1");
    expect(captured.err).toContain("NOT your Dashboard endpoint secret");
    expect(captured.err).toContain("not forwarding");
    expect(captured.out).toBe("");
  });

  test("arrival and result lines follow the time --> / <-- format", () => {
    renderArrival("user.created", "msg_1");
    renderForwardResult(outcome({ status: 200 }), "POST", "/api/webhooks");

    const plain = captured.err.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/\d{2}:\d{2}:\d{2} --> user\.created msg_1\n/);
    expect(plain).toMatch(/\d{2}:\d{2}:\d{2} <-- 200 POST \/api\/webhooks 12ms\n/);
  });

  test("verification warning names the delivery", () => {
    renderVerificationWarning("msg_1");

    expect(captured.err).toContain("signature verification failed for msg_1");
  });

  test.each([
    {
      label: "401 → middleware hint",
      forward: outcome({ status: 401 }),
      expected: "createRouteMatcher(['/api/webhooks(.*)'])",
    },
    {
      label: "400 → raw-body hint",
      forward: outcome({ status: 400 }),
      expected: "RAW request body",
    },
    {
      label: "unreachable handler → dev-server hint",
      forward: outcome({ status: 502, failed: true, bodyText: "connection refused" }),
      expected: "Is your dev server running",
    },
  ])("$label", ({ forward, expected }) => {
    renderForwardDiagnostics(forward, "msg_1");

    expect(captured.err).toContain(expected);
  });

  test("5xx diagnostics include the response body and the replay command", () => {
    renderForwardDiagnostics(outcome({ status: 500, bodyText: "stack trace here" }), "msg_9");

    expect(captured.err).toContain("stack trace here");
    expect(captured.err).toContain("clerk webhooks replay msg_9");
  });

  test("2xx responses produce no diagnostics", () => {
    renderForwardDiagnostics(outcome({ status: 204 }), "msg_1");

    expect(captured.err).toBe("");
  });
});

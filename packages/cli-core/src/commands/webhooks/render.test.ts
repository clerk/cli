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
  renderUnpinnedTokenHint,
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
      relayUrl: "https://webhooks.clerk.com/in/Ab12Cd34Ef/",
      forwardTo: "http://localhost:3000/api/webhooks",
    });

    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      type: "ready",
      relay_url: "https://webhooks.clerk.com/in/Ab12Cd34Ef/",
      forward_to: "http://localhost:3000/api/webhooks",
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

  test("ready banner shows the relay URL, forwarding target, and dashboard link", () => {
    renderReadyBanner({
      relayUrl: "https://webhooks.clerk.com/in/Ab12Cd34Ef/",
      forwardTo: "http://localhost:3000/api/webhooks",
    });

    expect(captured.err).toContain("https://webhooks.clerk.com/in/Ab12Cd34Ef/");
    expect(captured.err).toContain("http://localhost:3000/api/webhooks");
    expect(captured.err).toContain("dashboard.clerk.com/last-active?path=webhooks");
    expect(captured.err).toContain("Verification:");
    expect(captured.out).toBe("");
  });

  test("arrival and result lines follow the time --> / <-- format", () => {
    renderArrival("user.created", "msg_1");
    renderForwardResult(outcome({ status: 200 }), "POST", "/api/webhooks");

    const plain = Bun.stripANSI(captured.err);
    expect(plain).toMatch(/\d{2}:\d{2}:\d{2} --> user\.created msg_1\n/);
    expect(plain).toMatch(/\d{2}:\d{2}:\d{2} <-- 200 POST \/api\/webhooks 12ms\n/);
  });

  test("unpinned-token hint shows the current token and how to pin it", () => {
    renderUnpinnedTokenHint("c_Ab12Cd34Ef");

    expect(captured.err).toContain("auto-generated relay token");
    expect(captured.err).toContain("--token c_Ab12Cd34Ef");
    expect(captured.err).toContain("clerk webhooks token");
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

  test("5xx diagnostics include the response body and a re-trigger hint", () => {
    renderForwardDiagnostics(outcome({ status: 500, bodyText: "stack trace here" }), "msg_9");

    expect(captured.err).toContain("stack trace here");
    expect(captured.err).toContain("re-trigger the event");
    expect(captured.err).toContain("msg_9");
  });

  test("2xx responses produce no diagnostics", () => {
    renderForwardDiagnostics(outcome({ status: 204 }), "msg_1");

    expect(captured.err).toBe("");
  });
});

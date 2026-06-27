import { test, expect, describe, afterEach } from "bun:test";
import { CliError } from "../../lib/errors.ts";
import { stubFetch, useCaptureLog } from "../../test/lib/stubs.ts";
import { buildForwardHeaders, forwardDelivery, parseHeaderFlag } from "./forward.ts";

const originalFetch = globalThis.fetch;

describe("parseHeaderFlag", () => {
  test.each<{ label: string; value: string; expected: [string, string] }>([
    { label: "simple pair", value: "x-env:dev", expected: ["x-env", "dev"] },
    {
      label: "value containing colons (split on FIRST colon)",
      value: "authorization:Bearer abc:def",
      expected: ["authorization", "Bearer abc:def"],
    },
    { label: "empty value", value: "x-empty:", expected: ["x-empty", ""] },
    { label: "trims whitespace", value: " x-env : dev ", expected: ["x-env", "dev"] },
  ])("parses $label", ({ value, expected }) => {
    expect(parseHeaderFlag(value)).toEqual(expected);
  });

  test.each([
    { label: "pair without a colon", value: "not-a-pair" },
    { label: "pair with an empty key", value: ":value" },
  ])("throws a usage error on $label", ({ value }) => {
    expect(() => parseHeaderFlag(value)).toThrow(CliError);
  });
});

describe("buildForwardHeaders", () => {
  const eventHeaders = {
    "svix-id": "msg_1",
    "svix-timestamp": "1717935000",
    "svix-signature": "v1,abc",
    "content-type": "application/json",
  };

  test("preserves delivery headers and adds extras", () => {
    const extra = new Headers({ "x-env": "dev" });
    const headers = buildForwardHeaders(eventHeaders, extra);

    expect(headers.get("svix-id")).toBe("msg_1");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-env")).toBe("dev");
  });

  test("extras may override non-svix delivery headers", () => {
    const extra = new Headers({ "Content-Type": "text/plain" });
    const headers = buildForwardHeaders(eventHeaders, extra);

    expect(headers.get("content-type")).toBe("text/plain");
  });

  test.each([
    { label: "lowercase", key: "svix-signature" },
    { label: "uppercase", key: "SVIX-SIGNATURE" },
    { label: "mixed case", key: "Svix-Signature" },
  ])("extras can never override svix-* headers ($label)", ({ key }) => {
    const extra = new Headers({ [key]: "v1,forged" });
    const headers = buildForwardHeaders(eventHeaders, extra);

    expect(headers.get("svix-signature")).toBe("v1,abc");
  });

  test("strips hop-by-hop headers from event headers", () => {
    const withHopByHop = {
      ...eventHeaders,
      host: "svix-relay.example.com",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
    };
    const headers = buildForwardHeaders(withHopByHop, new Headers());

    expect(headers.has("host")).toBe(false);
    expect(headers.has("connection")).toBe(false);
    expect(headers.has("transfer-encoding")).toBe(false);
    expect(headers.get("svix-id")).toBe("msg_1");
  });

  test("allows duplicate extra headers via append", () => {
    const extra = new Headers();
    extra.append("x-custom", "first");
    extra.append("x-custom", "second");
    const headers = buildForwardHeaders({}, extra);

    expect(headers.get("x-custom")).toBe("first, second");
  });
});

describe("forwardDelivery", () => {
  useCaptureLog();

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("POSTs the body with headers and captures the response", async () => {
    let captured: { url: string; method: string; body: string; headers: Headers } | undefined;
    stubFetch(async (input, init) => {
      captured = {
        url: input.toString(),
        method: init?.method ?? "GET",
        body: String(init?.body),
        headers: new Headers(init?.headers),
      };
      return new Response("ok body", { status: 200, headers: { "x-served-by": "test" } });
    });

    const outcome = await forwardDelivery({
      forwardTo: "http://localhost:3000/api/webhooks",
      method: "POST",
      headers: buildForwardHeaders({ "svix-id": "msg_1" }, new Headers()),
      body: '{"type":"user.created"}',
    });

    expect(captured?.url).toBe("http://localhost:3000/api/webhooks");
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBe('{"type":"user.created"}');
    expect(captured?.headers.get("svix-id")).toBe("msg_1");

    expect(outcome.failed).toBe(false);
    expect(outcome.status).toBe(200);
    expect(outcome.bodyText).toBe("ok body");
    expect(outcome.bodyB64).toBe(Buffer.from("ok body", "utf8").toString("base64"));
    expect(outcome.headers["x-served-by"]).toBe("test");
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("returns a synthetic 502 when the local handler is unreachable", async () => {
    stubFetch(async () => {
      throw new Error("connection refused");
    });

    const outcome = await forwardDelivery({
      forwardTo: "http://localhost:9/api/webhooks",
      method: "POST",
      headers: new Headers(),
      body: "{}",
    });

    expect(outcome.failed).toBe(true);
    expect(outcome.status).toBe(502);
    expect(outcome.bodyText).toContain("connection refused");
  });

  test("non-2xx handler responses are captured, not thrown", async () => {
    stubFetch(async () => new Response("boom", { status: 500 }));

    const outcome = await forwardDelivery({
      forwardTo: "http://localhost:3000/api/webhooks",
      method: "POST",
      headers: new Headers(),
      body: "{}",
    });

    expect(outcome.failed).toBe(false);
    expect(outcome.status).toBe(500);
    expect(outcome.bodyText).toBe("boom");
  });

  test("a fetch timeout/abort yields a synthetic 502", async () => {
    stubFetch(async () => {
      // Simulate what AbortSignal.timeout(30_000) throws when the deadline fires.
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    const outcome = await forwardDelivery({
      forwardTo: "http://localhost:3000/api/webhooks",
      method: "POST",
      headers: new Headers(),
      body: "{}",
    });

    expect(outcome.failed).toBe(true);
    expect(outcome.status).toBe(502);
    expect(outcome.bodyText).toContain("timeout");
  });
});

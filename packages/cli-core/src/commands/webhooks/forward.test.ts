import { test, expect, describe, afterEach } from "bun:test";
import { CliError } from "../../lib/errors.ts";
import { stubFetch, useCaptureLog } from "../../test/lib/stubs.ts";
import { buildForwardHeaders, forwardDelivery, parseHeaderPairs } from "./forward.ts";

const originalFetch = globalThis.fetch;

describe("parseHeaderPairs", () => {
  const parseCases: Array<{
    label: string;
    value: string | undefined;
    expected: Record<string, string>;
  }> = [
    { label: "undefined", value: undefined, expected: {} },
    { label: "empty string", value: "", expected: {} },
    { label: "single pair", value: "x-env:dev", expected: { "x-env": "dev" } },
    {
      label: "multiple pairs with whitespace",
      value: " x-env : dev , x-team:core ",
      expected: { "x-env": "dev", "x-team": "core" },
    },
    {
      label: "value containing colons (split on FIRST colon)",
      value: "authorization:Bearer abc:def",
      expected: { authorization: "Bearer abc:def" },
    },
    { label: "trailing comma", value: "x-env:dev,", expected: { "x-env": "dev" } },
    { label: "empty value", value: "x-empty:", expected: { "x-empty": "" } },
  ];

  test.each(parseCases)("parses $label", ({ value, expected }) => {
    expect(parseHeaderPairs(value)).toEqual(expected);
  });

  test.each([
    { label: "pair without a colon", value: "not-a-pair" },
    { label: "pair with an empty key", value: ":value" },
  ])("throws a usage error on $label", ({ value }) => {
    expect(() => parseHeaderPairs(value)).toThrow(CliError);
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
    const headers = buildForwardHeaders(eventHeaders, { "x-env": "dev" });

    expect(headers.get("svix-id")).toBe("msg_1");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-env")).toBe("dev");
  });

  test("extras may override non-svix delivery headers", () => {
    const headers = buildForwardHeaders(eventHeaders, { "Content-Type": "text/plain" });

    expect(headers.get("content-type")).toBe("text/plain");
  });

  test.each([
    { label: "lowercase", key: "svix-signature" },
    { label: "uppercase", key: "SVIX-SIGNATURE" },
    { label: "mixed case", key: "Svix-Signature" },
  ])("extras can never override svix-* headers ($label)", ({ key }) => {
    const headers = buildForwardHeaders(eventHeaders, { [key]: "v1,forged" });

    expect(headers.get("svix-signature")).toBe("v1,abc");
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
      headers: buildForwardHeaders({ "svix-id": "msg_1" }, {}),
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
});

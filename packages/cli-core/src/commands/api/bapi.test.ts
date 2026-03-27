import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { stubFetch } from "../../test/stubs.ts";
import { bapiRequest } from "./bapi.ts";
import { BapiError } from "../../lib/errors.ts";

describe("bapi", () => {
  const originalFetch = globalThis.fetch;
  const originalBapiUrl = process.env.CLERK_BACKEND_API_URL;

  beforeEach(() => {
    process.env.CLERK_BACKEND_API_URL = "https://api.clerk.dev";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalBapiUrl === undefined) {
      delete process.env.CLERK_BACKEND_API_URL;
    } else {
      process.env.CLERK_BACKEND_API_URL = originalBapiUrl;
    }
  });

  test("constructs correct URL with /v1/ prefix", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({}), { status: 200 });
    });
    await bapiRequest({ method: "GET", path: "/users", secretKey: "sk_test_123" });
    expect(requestedUrl).toBe("https://api.clerk.dev/v1/users");
  });

  test("does not double-prefix /v1/", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({}), { status: 200 });
    });
    await bapiRequest({ method: "GET", path: "/v1/users", secretKey: "sk_test_123" });
    expect(requestedUrl).toBe("https://api.clerk.dev/v1/users");
  });

  test("handles path without leading slash", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({}), { status: 200 });
    });
    await bapiRequest({ method: "GET", path: "users", secretKey: "sk_test_123" });
    expect(requestedUrl).toBe("https://api.clerk.dev/v1/users");
  });

  test("sends Bearer token in Authorization header", async () => {
    let capturedHeaders: Headers | undefined;
    stubFetch(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    await bapiRequest({ method: "GET", path: "/users", secretKey: "sk_test_abc" });
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer sk_test_abc");
  });

  test("sends Content-Type header when body is present", async () => {
    let capturedHeaders: Headers | undefined;
    stubFetch(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    await bapiRequest({
      method: "POST",
      path: "/users",
      secretKey: "sk_test_abc",
      body: '{"email":"a@b.com"}',
    });
    expect(capturedHeaders?.get("Content-Type")).toBe("application/json");
  });

  test("does not send Content-Type header when no body", async () => {
    let capturedHeaders: Headers | undefined;
    stubFetch(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    await bapiRequest({ method: "GET", path: "/users", secretKey: "sk_test_abc" });
    expect(capturedHeaders?.get("Content-Type")).toBeNull();
  });

  test("returns parsed JSON body on success", async () => {
    const data = { data: [{ id: "user_1" }] };
    stubFetch(async () => new Response(JSON.stringify(data), { status: 200 }));
    const result = await bapiRequest({ method: "GET", path: "/users", secretKey: "sk_test_abc" });
    expect(result.body).toEqual(data);
    expect(result.status).toBe(200);
  });

  test("returns raw text when response is not JSON", async () => {
    stubFetch(async () => new Response("plain text", { status: 200 }));
    const result = await bapiRequest({ method: "GET", path: "/health", secretKey: "sk_test_abc" });
    expect(result.body).toBe("plain text");
    expect(result.rawBody).toBe("plain text");
  });

  test("throws BapiError on non-2xx response", async () => {
    stubFetch(async () => new Response("Not Found", { status: 404 }));
    try {
      await bapiRequest({ method: "GET", path: "/users/bad", secretKey: "sk_test_abc" });
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(BapiError);
      expect((error as BapiError).status).toBe(404);
      expect((error as BapiError).body).toBe("Not Found");
    }
  });

  test("respects baseUrl override", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({}), { status: 200 });
    });
    await bapiRequest({
      method: "GET",
      path: "/users",
      secretKey: "sk_test_abc",
      baseUrl: "https://custom.api.dev",
    });
    expect(requestedUrl).toBe("https://custom.api.dev/v1/users");
  });

  test("sends request body", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });
    await bapiRequest({
      method: "POST",
      path: "/users",
      secretKey: "sk_test_abc",
      body: '{"email":"a@b.com"}',
    });
    expect(JSON.parse(capturedBody)).toEqual({ email: "a@b.com" });
  });
});

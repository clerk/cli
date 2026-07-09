import { test, expect, describe } from "bun:test";
import {
  PlapiError,
  FapiError,
  BapiError,
  BillingError,
  BILLING_ERROR_REASON,
  CliError,
  ERROR_CODE,
} from "./errors.ts";

describe("ApiError envelope parsing (via PlapiError.fromBody)", () => {
  test("parses a standard single-error envelope", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "production_instance_exists",
          message: "You can only have one production instance.",
          long_message: "Each application can have at most one production instance.",
          meta: { application_id: "app_123" },
        },
      ],
      clerk_trace_id: "trace_abc",
    });
    const err = PlapiError.fromBody(400, body, "https://api.example.com/x");
    expect(err.status).toBe(400);
    expect(err.code).toBe("production_instance_exists");
    expect(err.message).toBe("You can only have one production instance.");
    expect(err.longMessage).toBe("Each application can have at most one production instance.");
    expect(err.meta).toEqual({ application_id: "app_123" });
    expect(err.clerkTraceId).toBe("trace_abc");
    expect(err.body).toBe(body);
    expect(err.url).toBe("https://api.example.com/x");
  });

  test("uses the first entry on a multi-error envelope", () => {
    const body = JSON.stringify({
      errors: [
        { code: "first", message: "First problem" },
        { code: "second", message: "Second problem" },
      ],
    });
    const err = PlapiError.fromBody(400, body);
    expect(err.code).toBe("first");
    expect(err.message).toBe("First problem");
  });

  test("populates nullable fields when optional envelope keys are absent", () => {
    const body = JSON.stringify({ errors: [{ code: "x", message: "y" }] });
    const err = PlapiError.fromBody(400, body);
    expect(err.longMessage).toBeNull();
    expect(err.meta).toBeNull();
    expect(err.clerkTraceId).toBeNull();
  });

  test("falls back gracefully on non-JSON bodies", () => {
    const err = PlapiError.fromBody(500, "<html>proxy error</html>");
    expect(err.code).toBeNull();
    expect(err.message).toBe("<html>proxy error</html>");
    expect(err.longMessage).toBeNull();
    expect(err.meta).toBeNull();
  });

  test("truncates very long non-JSON bodies in the message", () => {
    const longBody = "x".repeat(500);
    const err = PlapiError.fromBody(500, longBody);
    expect(err.code).toBeNull();
    expect(err.message).toBe("x".repeat(200) + "...");
    expect(err.body).toBe(longBody);
  });

  test("falls back when body is JSON but not a Clerk envelope", () => {
    const body = JSON.stringify({ unrelated: "shape" });
    const err = PlapiError.fromBody(400, body);
    expect(err.code).toBeNull();
    expect(err.message).toBe(body);
    expect(err.meta).toBeNull();
  });

  test("falls back when body is an empty string", () => {
    const err = PlapiError.fromBody(500, "");
    expect(err.code).toBeNull();
    expect(err.message).toBe("API error (500)");
  });

  test("falls back when body is the JSON literal null", () => {
    const err = PlapiError.fromBody(500, "null");
    expect(err.code).toBeNull();
    expect(err.message).toBe("null");
    expect(err.meta).toBeNull();
  });

  test("falls back when body is a JSON primitive (number)", () => {
    const err = PlapiError.fromBody(500, "42");
    expect(err.code).toBeNull();
    expect(err.message).toBe("42");
  });

  test("preserves an empty meta object rather than coercing to null", () => {
    const body = JSON.stringify({
      errors: [{ code: "x", message: "y", meta: {} }],
    });
    const err = PlapiError.fromBody(400, body);
    expect(err.meta).toEqual({});
  });
});

describe("PlapiError factories", () => {
  test("fromResponse reads body, status, and response.url", async () => {
    const body = JSON.stringify({ errors: [{ code: "x", message: "y" }] });
    const response = new Response(body, {
      status: 422,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", {
      value: "https://api.example.com/r",
    });
    const err = await PlapiError.fromResponse(response);
    expect(err).toBeInstanceOf(PlapiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("x");
    expect(err.url).toBe("https://api.example.com/r");
  });

  test("fromBody is synchronous and accepts an optional url", () => {
    const err = PlapiError.fromBody(500, "boom", "https://api.example.com/r");
    expect(err).toBeInstanceOf(PlapiError);
    expect(err.url).toBe("https://api.example.com/r");
    expect(err.code).toBeNull();
  });
});

describe("FapiError factories", () => {
  test("fromResponse reads body, status, and response.url", async () => {
    const response = new Response("not json", { status: 503 });
    Object.defineProperty(response, "url", { value: "https://fapi.example.com/x" });
    const err = await FapiError.fromResponse(response);
    expect(err).toBeInstanceOf(FapiError);
    expect(err.status).toBe(503);
    expect(err.url).toBe("https://fapi.example.com/x");
  });
});

describe("BapiError factories", () => {
  test("fromResponse captures headers", async () => {
    const response = new Response("err", {
      status: 400,
      headers: { "x-clerk-trace": "abc" },
    });
    const err = await BapiError.fromResponse(response);
    expect(err).toBeInstanceOf(BapiError);
    expect(err.headers.get("x-clerk-trace")).toBe("abc");
  });

  test("fromBody requires headers explicitly", () => {
    const headers = new Headers({ "x-y": "z" });
    const err = BapiError.fromBody(400, "boom", headers);
    expect(err).toBeInstanceOf(BapiError);
    expect(err.headers.get("x-y")).toBe("z");
  });
});

describe("BillingError", () => {
  test("is a CliError carrying the plan-not-enabled reason and caller-supplied code", () => {
    const err = new BillingError("Impersonation is available as an add-on.", {
      reason: BILLING_ERROR_REASON.PLAN_NOT_ENABLED,
      code: ERROR_CODE.IMPERSONATION_NOT_ENABLED,
    });
    expect(err).toBeInstanceOf(CliError);
    expect(err.name).toBe("BillingError");
    expect(err.reason).toBe(BILLING_ERROR_REASON.PLAN_NOT_ENABLED);
    expect(err.code).toBe(ERROR_CODE.IMPERSONATION_NOT_ENABLED);
  });

  test("carries a docsUrl to the billing page for the quota-exceeded reason", () => {
    const err = new BillingError("You've reached your impersonation limit this billing period.", {
      reason: BILLING_ERROR_REASON.QUOTA_EXCEEDED,
      code: ERROR_CODE.IMPERSONATION_LIMIT_EXCEEDED,
      docsUrl: "https://dashboard.clerk.com/settings/billing",
    });
    expect(err.reason).toBe(BILLING_ERROR_REASON.QUOTA_EXCEEDED);
    expect(err.docsUrl).toBe("https://dashboard.clerk.com/settings/billing");
  });
});

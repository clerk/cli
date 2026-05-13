import { test, expect, describe } from "bun:test";
import { PlapiError } from "./errors.ts";

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

  test("preserves an empty meta object rather than coercing to null", () => {
    const body = JSON.stringify({
      errors: [{ code: "x", message: "y", meta: {} }],
    });
    const err = PlapiError.fromBody(400, body);
    expect(err.meta).toEqual({});
  });
});

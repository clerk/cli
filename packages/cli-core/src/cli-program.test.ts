import { test, expect, describe } from "bun:test";
import { formatApiBody } from "./cli-program.ts";

describe("formatApiBody", () => {
  // --- Single error with meta ---

  test("surfaces unsupported_features from meta", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "unsupported_subscription_plan_features",
          message: "Your plan does not support these features",
          meta: { unsupported_features: ["saml", "custom_roles"] },
        },
      ],
    });
    const result = formatApiBody(body, false);
    expect(result).toContain("Your plan does not support these features");
    expect(result).toContain("Unsupported features: saml, custom_roles");
  });

  test("surfaces suggestions from unknown_config_key meta", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "unknown_config_key",
          message: "Unknown config key: sesion",
          meta: { param_name: "sesion", suggestions: ["session"] },
        },
      ],
    });
    const result = formatApiBody(body, false);
    expect(result).toContain("Unknown config key: sesion");
    expect(result).toContain("Did you mean: session");
    expect(result).toContain("Parameter: sesion");
  });

  test("surfaces feature name from feature_not_enabled meta", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "feature_not_enabled",
          message: "This feature is not enabled on this instance",
          meta: { param_name: "organizations" },
        },
      ],
    });
    const result = formatApiBody(body, false);
    expect(result).toContain("This feature is not enabled on this instance");
    expect(result).toContain("Feature: organizations");
  });

  test("surfaces param_name for config_validation_error", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "config_validation_error",
          message: "Invalid value for session.lifetime",
          meta: { param_name: "session.lifetime", config_key: "session" },
        },
      ],
    });
    const result = formatApiBody(body, false);
    expect(result).toContain("Invalid value for session.lifetime");
    expect(result).toContain("Parameter: session.lifetime");
  });

  test("surfaces param_name for destructive_operation_not_allowed", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "destructive_operation_not_allowed",
          message: "Cannot clear this key without destructive=true",
          meta: { param_name: "sign_up.mode" },
        },
      ],
    });
    const result = formatApiBody(body, false);
    expect(result).toContain("Cannot clear this key");
    expect(result).toContain("Parameter: sign_up.mode");
  });

  test("surfaces param_name for form_param_value_invalid", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "form_param_value_invalid",
          message: "Value is not in the allowed set",
          meta: { param_name: "branding.logo_url" },
        },
      ],
    });
    const result = formatApiBody(body, false);
    expect(result).toContain("Value is not in the allowed set");
    expect(result).toContain("Parameter: branding.logo_url");
  });

  // --- Multiple errors ---

  test("formats multiple errors joined by newlines", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "config_validation_error",
          message: "Invalid session lifetime",
          meta: { param_name: "session.lifetime" },
        },
        {
          code: "unknown_config_key",
          message: "Unknown key: bogus",
          meta: { param_name: "bogus", suggestions: ["session"] },
        },
      ],
    });
    const result = formatApiBody(body, false);
    expect(result).toContain("Invalid session lifetime");
    expect(result).toContain("Unknown key: bogus");
    expect(result).toContain("Did you mean: session");
    // Two errors separated by newline
    const lines = result.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  // --- Error without meta ---

  test("handles error without meta gracefully", () => {
    const body = JSON.stringify({
      errors: [{ code: "resource_not_found", message: "Instance not found" }],
    });
    const result = formatApiBody(body, false);
    expect(result).toBe("Instance not found");
  });

  // --- Fallback paths ---

  test("falls back to parsed.error when no errors array", () => {
    const body = JSON.stringify({ error: "Something went wrong" });
    const result = formatApiBody(body, false);
    expect(result).toBe("Something went wrong");
  });

  test("falls back to parsed.message when no errors array or error field", () => {
    const body = JSON.stringify({ message: "Bad request" });
    const result = formatApiBody(body, false);
    expect(result).toBe("Bad request");
  });

  test("truncates non-JSON body over 200 chars", () => {
    const body = "x".repeat(300);
    const result = formatApiBody(body, false);
    expect(result).toBe("x".repeat(200) + "...");
  });

  test("returns short non-JSON body as-is", () => {
    const result = formatApiBody("Bad Request", false);
    expect(result).toBe("Bad Request");
  });

  // --- Verbose mode ---

  test("verbose mode returns full pretty-printed JSON", () => {
    const obj = { errors: [{ code: "test", message: "test msg" }] };
    const body = JSON.stringify(obj);
    const result = formatApiBody(body, true);
    expect(result).toBe("\n" + JSON.stringify(obj, null, 2));
  });

  test("verbose mode returns raw body for non-JSON", () => {
    const result = formatApiBody("not json", true);
    expect(result).toBe("\nnot json");
  });

  // --- Edge cases ---

  test("handles empty errors array by falling through", () => {
    const body = JSON.stringify({ errors: [], message: "fallback" });
    const result = formatApiBody(body, false);
    expect(result).toBe("fallback");
  });

  test("handles error with empty meta", () => {
    const body = JSON.stringify({
      errors: [{ code: "config_validation_error", message: "Bad value", meta: {} }],
    });
    const result = formatApiBody(body, false);
    expect(result).toBe("Bad value");
  });

  test("handles unsupported_subscription_plan_features with empty unsupported_features", () => {
    const body = JSON.stringify({
      errors: [
        {
          code: "unsupported_subscription_plan_features",
          message: "Plan limitation",
          meta: { unsupported_features: [] },
        },
      ],
    });
    const result = formatApiBody(body, false);
    expect(result).toBe("Plan limitation");
  });
});

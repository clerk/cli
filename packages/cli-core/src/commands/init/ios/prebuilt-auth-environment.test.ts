import { describe, expect, test } from "bun:test";
import { auditIOSPrebuiltAuthEnvironment } from "./prebuilt-auth-environment.ts";

describe("auditIOSPrebuiltAuthEnvironment", () => {
  test("requires the native Apple entitlement when Apple is enabled and authenticatable", () => {
    expect(
      auditIOSPrebuiltAuthEnvironment({
        social: {
          oauth_apple: {
            enabled: true,
            authenticatable: true,
            strategy: "oauth_apple",
          },
        },
      }),
    ).toEqual({ apple: "required" });
  });

  test("does not require the entitlement when enabled Apple is not authenticatable", () => {
    expect(
      auditIOSPrebuiltAuthEnvironment({
        social: {
          oauth_apple: {
            enabled: true,
            authenticatable: false,
            strategy: "oauth_apple",
          },
        },
      }),
    ).toEqual({ apple: "not-required" });
  });

  test("does not require the entitlement when Apple is disabled", () => {
    expect(
      auditIOSPrebuiltAuthEnvironment({
        social: {
          oauth_apple: {
            enabled: false,
            authenticatable: true,
            strategy: "oauth_apple",
          },
        },
      }),
    ).toEqual({ apple: "not-required" });
  });

  test("does not require the entitlement when Apple is absent", () => {
    expect(auditIOSPrebuiltAuthEnvironment({ social: {} })).toEqual({
      apple: "not-required",
    });
  });

  test.each([
    undefined,
    null,
    {},
    { social: null },
    { social: [] },
    { social: { oauth_apple: null } },
    { social: { oauth_apple: [] } },
    { social: { oauth_apple: { enabled: "true", authenticatable: true } } },
    { social: { oauth_apple: { enabled: true, authenticatable: "true" } } },
    { social: { oauth_apple: { enabled: true } } },
    {
      social: {
        alias: { enabled: true, authenticatable: true, strategy: "oauth_apple" },
      },
    },
    {
      social: {
        oauth_apple: { enabled: true, authenticatable: true, strategy: "oauth_google" },
      },
    },
  ])("blocks malformed or ambiguous provider data", (settings) => {
    expect(auditIOSPrebuiltAuthEnvironment(settings)).toEqual({
      apple: "blocked",
      message:
        "Clerk's Apple sign-in settings could not be safely determined. Review the Apple social connection before applying the prebuilt iOS authentication UI.",
    });
  });

  test("returns only redacted status data and never retains provider details", () => {
    const secret = "client-secret-must-not-escape";
    const callbackUrl = "https://example.test/private-callback";
    const settings = {
      social: {
        oauth_apple: {
          enabled: true,
          authenticatable: true,
          strategy: "oauth_apple",
          client_secret: secret,
          redirect_url: callbackUrl,
          nested: { credential: secret },
        },
      },
    };

    const audit = auditIOSPrebuiltAuthEnvironment(settings);
    const serialized = JSON.stringify(audit);

    expect(audit).toEqual({ apple: "required" });
    expect(serialized).toBe('{"apple":"required"}');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(callbackUrl);
  });
});

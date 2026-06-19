import { test, expect, describe, afterEach } from "bun:test";
import { decodePublishableKey, bootstrapDevBrowser, fetchUserSettings } from "./fapi.ts";
import { CliError, FapiError } from "./errors.ts";
import { stubFetch } from "../test/lib/stubs.ts";

describe("decodePublishableKey", () => {
  test("decodes a development publishable key", () => {
    // base64("ideal-louse-61.clerk.accounts.dev$") = "aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA"
    const result = decodePublishableKey("pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA");
    expect(result.fapiHost).toBe("ideal-louse-61.clerk.accounts.dev");
    expect(result.instanceType).toBe("development");
  });

  test("decodes a production publishable key", () => {
    // base64("clerk.example.com$") = "Y2xlcmsuZXhhbXBsZS5jb20k"
    const result = decodePublishableKey("pk_live_Y2xlcmsuZXhhbXBsZS5jb20k");
    expect(result.fapiHost).toBe("clerk.example.com");
    expect(result.instanceType).toBe("production");
  });

  test("throws CliError on missing prefix", () => {
    expect(() => decodePublishableKey("not_a_key")).toThrow(CliError);
  });

  test("throws CliError when decoded value does not end with $", () => {
    // base64("clerk.example.com") = "Y2xlcmsuZXhhbXBsZS5jb20="
    expect(() => decodePublishableKey("pk_test_Y2xlcmsuZXhhbXBsZS5jb20=")).toThrow(CliError);
  });

  test("throws CliError when decoded host contains a slash", () => {
    // base64("clerk.example.com/path$") = encodeToB64("clerk.example.com/path$")
    const encoded = btoa("clerk.example.com/path$");
    expect(() => decodePublishableKey(`pk_test_${encoded}`)).toThrow(CliError);
  });

  test("throws CliError when decoded host contains an @ sign", () => {
    const encoded = btoa("user@clerk.example.com$");
    expect(() => decodePublishableKey(`pk_test_${encoded}`)).toThrow(CliError);
  });
});

describe("bootstrapDevBrowser", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("POSTs to /v1/dev_browser and returns the token", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    stubFetch(async (input, init) => {
      capturedUrl = String(input);
      capturedMethod = String(init?.method ?? "GET");
      return new Response(JSON.stringify({ token: "jwt-abc" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const token = await bootstrapDevBrowser("ideal-louse-61.clerk.accounts.dev");

    expect(token).toBe("jwt-abc");
    expect(capturedUrl).toBe("https://ideal-louse-61.clerk.accounts.dev/v1/dev_browser");
    expect(capturedMethod).toBe("POST");
  });

  test("throws FapiError on non-2xx response", async () => {
    stubFetch(async () => new Response("nope", { status: 500 }));
    await expect(bootstrapDevBrowser("foo.example.com")).rejects.toThrow(FapiError);
  });

  test("throws when response has no token", async () => {
    stubFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(bootstrapDevBrowser("foo.example.com")).rejects.toThrow(CliError);
  });
});

describe("fetchUserSettings", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GETs /v1/environment and returns user_settings", async () => {
    let capturedUrl = "";
    stubFetch(async (input) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          user_settings: {
            attributes: {
              email_address: { enabled: true, required: true, used_for_first_factor: true },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const settings = await fetchUserSettings("foo.example.com", { jwt: "jwt-abc" });

    expect(settings.attributes.email_address?.enabled).toBe(true);
    expect(capturedUrl).toContain("https://foo.example.com/v1/environment");
    expect(capturedUrl).toContain("__clerk_db_jwt=jwt-abc");
    expect(capturedUrl).toContain("_clerk_js_version=6");
  });

  test("omits __clerk_db_jwt when no jwt is provided", async () => {
    let capturedUrl = "";
    stubFetch(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ user_settings: { attributes: {} } }), { status: 200 });
    });

    await fetchUserSettings("foo.example.com", {});
    expect(capturedUrl).not.toContain("__clerk_db_jwt");
  });

  test("throws FapiError on non-2xx response", async () => {
    stubFetch(async () => new Response("nope", { status: 401 }));
    await expect(fetchUserSettings("foo.example.com", {})).rejects.toThrow(FapiError);
  });

  test("throws when response has no user_settings", async () => {
    stubFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(fetchUserSettings("foo.example.com", {})).rejects.toThrow(CliError);
  });
});

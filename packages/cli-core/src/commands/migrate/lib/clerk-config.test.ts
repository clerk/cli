import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { stubFetch, useCaptureLog } from "../../../test/lib/stubs.ts";
import type { UserSettingsJSON } from "../../../lib/fapi.ts";
import { fetchInstanceSettings } from "./clerk-config.ts";

const USER_SETTINGS = {
  attributes: { email_address: { enabled: true, required: true } },
} as unknown as UserSettingsJSON;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchInstanceSettings", () => {
  const originalFetch = globalThis.fetch;
  useCaptureLog();
  const mockFetch = mock();

  beforeEach(() => {
    mockFetch.mockReset();
    stubFetch(mockFetch);
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  /** Routes the three hops: BAPI domains → FAPI dev browser → FAPI environment. */
  function route(domains: unknown): void {
    mockFetch.mockImplementation((input: string | URL) => {
      const url = String(input);
      if (url.includes("/v1/domains")) return Promise.resolve(json({ data: domains }));
      if (url.includes("/v1/dev_browser")) return Promise.resolve(json({ token: "jwt" }));
      if (url.includes("/v1/environment")) {
        return Promise.resolve(json({ user_settings: USER_SETTINGS }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
  }

  test("reads settings off the primary domain's Frontend API", async () => {
    route([{ is_satellite: false, frontend_api_url: "https://clerk.example.com" }]);

    expect(await fetchInstanceSettings("sk_test_abc")).toEqual(USER_SETTINGS);

    const urls = mockFetch.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes("clerk.example.com/v1/dev_browser"))).toBe(true);
    expect(urls.some((url) => url.includes("clerk.example.com/v1/environment"))).toBe(true);
  });

  test("prefers the primary domain over a satellite", async () => {
    route([
      { is_satellite: true, frontend_api_url: "https://satellite.example.com" },
      { is_satellite: false, frontend_api_url: "https://clerk.example.com" },
    ]);

    await fetchInstanceSettings("sk_test_abc");

    const urls = mockFetch.mock.calls.map(([input]) => String(input));
    expect(urls.every((url) => !url.includes("satellite.example.com"))).toBe(true);
  });

  test("skips the dev browser bootstrap for a production key", async () => {
    route([{ is_satellite: false, frontend_api_url: "https://clerk.example.com" }]);

    expect(await fetchInstanceSettings("sk_live_abc")).toEqual(USER_SETTINGS);

    const urls = mockFetch.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes("/v1/dev_browser"))).toBe(false);
  });

  // `null` means "unknown", so callers degrade rather than treating a failed
  // lookup as "nothing is enabled".
  test("returns null when no domain names a Frontend API URL", async () => {
    route([{ is_satellite: false }]);
    expect(await fetchInstanceSettings("sk_test_abc")).toBeNull();
  });

  test("returns null when the domains lookup fails", async () => {
    mockFetch.mockResolvedValue(new Response("nope", { status: 401 }));
    expect(await fetchInstanceSettings("sk_test_abc")).toBeNull();
  });
});

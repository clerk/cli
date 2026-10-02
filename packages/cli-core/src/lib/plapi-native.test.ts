import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { credentialStoreStubs, stubFetch } from "../test/lib/stubs.ts";

const mockGetValidToken = mock();
mock.module("./credential-store.ts", () => ({
  ...credentialStoreStubs,
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
}));

const { createIOSApplication, enableNativeApi, getNativeSettings, listIOSApplications } =
  await import("./plapi.ts");
const { ERROR_CODE, PlapiError } = await import("./errors.ts");

function captureNativeRequests(responseBody: unknown): Request[] {
  const requests: Request[] = [];
  stubFetch(async (input, init) => {
    requests.push(
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init),
    );
    return Response.json(responseBody);
  });
  return requests;
}

describe("PLAPI native application client", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockGetValidToken.mockResolvedValue(null);
    process.env.CLERK_PLATFORM_API_KEY = "ak_test_client_token";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    mockGetValidToken.mockReset();
  });

  test("gets native settings for an environment alias", async () => {
    const responseBody = { object: "native_settings" as const, api_enabled: false };
    const requests = captureNativeRequests(responseBody);

    const result = await getNativeSettings("app_abc", "development");

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.url).toBe(
      "https://api.clerk.com/v1/platform/applications/app_abc/instances/development/native_settings",
    );
    expect(request.headers.get("Authorization")).toBe("Bearer ak_test_client_token");
    expect(request.headers.get("Accept")).toBe("application/json");
    expect(request.headers.has("Idempotency-Key")).toBe(false);
    expect(result).toEqual(responseBody);
  });

  test("enables Native API with an idempotency key", async () => {
    const responseBody = { object: "native_settings" as const, api_enabled: true };
    const requests = captureNativeRequests(responseBody);

    const result = await enableNativeApi("app_abc", "ins_dev_123", {
      idempotencyKey: "enable-native-api-123",
    });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("PATCH");
    expect(request.url).toBe(
      "https://api.clerk.com/v1/platform/applications/app_abc/instances/ins_dev_123/native_settings",
    );
    expect(await request.json()).toEqual({ api_enabled: true });
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("Idempotency-Key")).toBe("enable-native-api-123");
    expect(result).toEqual(responseBody);
  });

  describe.each([
    { method: "GET", request: () => getNativeSettings("app_abc", "development") },
    {
      method: "PATCH",
      request: () =>
        enableNativeApi("app_abc", "development", { idempotencyKey: "enable-native-api-123" }),
    },
  ])("Native settings $method", ({ request }) => {
    test.each([
      { name: "an array", body: [] },
      { name: "the wrong object discriminator", body: { object: "instance", api_enabled: true } },
      {
        name: "a non-boolean enabled value",
        body: { object: "native_settings", api_enabled: "false" },
      },
    ])("rejects $name", async ({ body }) => {
      stubFetch(async () => Response.json(body));
      await expect(request()).rejects.toMatchObject({
        name: "CliError",
        code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
      });
    });
  });

  test("lists the public iOS application DTOs", async () => {
    const responseBody = [
      {
        object: "ios_application" as const,
        id: "iosapp_123",
        app_id_prefix: "ABCD123456",
        bundle_id: "com.example.coolappy",
        created_at: 1_787_000_000_000,
        updated_at: 1_787_000_000_000,
        future_field: "preserved",
      },
    ];
    const requests = captureNativeRequests(responseBody);

    const result = await listIOSApplications("app_abc", "ins_dev_123");

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.url).toBe(
      "https://api.clerk.com/v1/platform/applications/app_abc/instances/ins_dev_123/native_applications/ios",
    );
    expect(result).toEqual(responseBody);
    expect(result[0]).not.toHaveProperty("team_id");
    expect((result[0] as unknown as Record<string, unknown>).future_field).toBe("preserved");
  });

  test.each([
    { name: "a non-array root", body: {} },
    { name: "a null item", body: [null] },
    {
      name: "an incomplete item",
      body: [
        {
          object: "ios_application",
          id: "iosapp_123",
          app_id_prefix: "ABCD123456",
          created_at: 1_787_000_000_000,
          updated_at: 1_787_000_000_000,
        },
      ],
    },
    {
      name: "an item with a mistyped field",
      body: [
        {
          object: "ios_application",
          id: "iosapp_123",
          app_id_prefix: "ABCD123456",
          bundle_id: "com.example.coolappy",
          created_at: "1787000000000",
          updated_at: 1_787_000_000_000,
        },
      ],
    },
  ])("rejects $name from the iOS application list", async ({ body }) => {
    stubFetch(async () => Response.json(body));

    await expect(listIOSApplications("app_abc", "ins_dev_123")).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });
  });

  test("rejects malformed JSON from the iOS application list", async () => {
    stubFetch(async () => new Response("{", { status: 200 }));

    await expect(listIOSApplications("app_abc", "ins_dev_123")).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });
  });

  test("creates an iOS application with the public field names and idempotency key", async () => {
    const responseBody = {
      object: "ios_application" as const,
      id: "iosapp_123",
      app_id_prefix: "ABCD123456",
      bundle_id: "com.example.coolappy",
      created_at: 1_787_000_000_000,
      updated_at: 1_787_000_000_000,
    };
    const requests = captureNativeRequests(responseBody);

    const result = await createIOSApplication(
      "app_abc",
      "development",
      { appIdPrefix: "ABCD123456", bundleId: "com.example.coolappy" },
      { idempotencyKey: "create-ios-app-123" },
    );

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://api.clerk.com/v1/platform/applications/app_abc/instances/development/native_applications/ios",
    );
    expect(await request.json()).toEqual({
      app_id_prefix: "ABCD123456",
      bundle_id: "com.example.coolappy",
    });
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("Idempotency-Key")).toBe("create-ios-app-123");
    expect(result).toEqual(responseBody);
  });

  test("rejects an incomplete iOS application create response", async () => {
    stubFetch(async () =>
      Response.json(
        {
          object: "ios_application",
          id: "iosapp_123",
          app_id_prefix: "ABCD123456",
          bundle_id: "com.example.coolappy",
        },
        { status: 200 },
      ),
    );

    await expect(
      createIOSApplication(
        "app_abc",
        "development",
        { appIdPrefix: "ABCD123456", bundleId: "com.example.coolappy" },
        { idempotencyKey: "create-ios-app-123" },
      ),
    ).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });
  });

  test("rejects malformed JSON from the iOS application create response", async () => {
    stubFetch(async () => new Response("{", { status: 200 }));

    await expect(
      createIOSApplication(
        "app_abc",
        "development",
        { appIdPrefix: "ABCD123456", bundleId: "com.example.coolappy" },
        { idempotencyKey: "create-ios-app-123" },
      ),
    ).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });
  });

  test("preserves typed PLAPI errors from native endpoints without credential data", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ errors: [{ code: "resource_not_found" }] }), { status: 404 }),
    );

    try {
      await getNativeSettings("app_missing", "development");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PlapiError);
      expect((error as InstanceType<typeof PlapiError>).status).toBe(404);
      expect(JSON.stringify(error)).not.toContain("ak_test_client_token");
    }
  });
});

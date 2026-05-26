import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { credentialStoreStubs, stubFetch } from "../test/lib/stubs.ts";

const mockGetValidToken = mock();
mock.module("./credential-store.ts", () => ({
  ...credentialStoreStubs,
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
}));

const {
  fetchApplication,
  fetchInstanceConfig,
  fetchInstanceConfigSchema,
  putInstanceConfig,
  patchInstanceConfig,
  listApplications,
  createApplication,
  createProductionInstance,
  getApplicationDomainStatus,
  triggerApplicationDomainDNSCheck,
  listApplicationDomains,
} = await import("./plapi.ts");
const { AuthError, PlapiError } = await import("./errors.ts");

describe("plapi", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockGetValidToken.mockResolvedValue(null);
    process.env.CLERK_PLATFORM_API_KEY = "test_key_123";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    mockGetValidToken.mockReset();
  });

  test("throws when neither OAuth token nor env var is set", async () => {
    mockGetValidToken.mockResolvedValue(null);
    delete process.env.CLERK_PLATFORM_API_KEY;
    await expect(fetchInstanceConfig("app_1", "ins_1")).rejects.toBeInstanceOf(AuthError);
    await expect(fetchInstanceConfig("app_1", "ins_1")).rejects.toThrow("Not authenticated");
  });

  test("prefers CLERK_PLATFORM_API_KEY over OAuth token", async () => {
    mockGetValidToken.mockResolvedValue("oauth_token_abc");
    process.env.CLERK_PLATFORM_API_KEY = "env_key_xyz";
    let capturedHeaders: Headers | undefined;
    stubFetch(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await fetchInstanceConfig("app_1", "ins_1");
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer env_key_xyz");
  });

  test("falls back to OAuth token when no CLERK_PLATFORM_API_KEY", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockGetValidToken.mockResolvedValue("oauth_token_abc");
    let capturedHeaders: Headers | undefined;
    stubFetch(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await fetchInstanceConfig("app_1", "ins_1");
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer oauth_token_abc");
  });

  test("constructs correct URL", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await fetchInstanceConfig("app_abc", "ins_def");
    expect(requestedUrl).toBe(
      "https://api.clerk.com/v1/platform/applications/app_abc/instances/ins_def/config",
    );
  });

  test("sends Bearer token in Authorization header", async () => {
    let capturedHeaders: Headers | undefined;
    stubFetch(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await fetchInstanceConfig("app_1", "ins_1");
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer test_key_123");
    expect(capturedHeaders?.get("Accept")).toBe("application/json");
  });

  test("returns parsed JSON on success", async () => {
    const mockConfig = { session: { lifetime: 604800 }, sign_up: { mode: "public" } };
    stubFetch(async () => new Response(JSON.stringify(mockConfig), { status: 200 }));

    const result = await fetchInstanceConfig("app_1", "ins_1");
    expect(result).toEqual(mockConfig);
  });

  test("throws PlapiError on non-2xx response", async () => {
    stubFetch(async () => new Response("Not Found", { status: 404 }));

    try {
      await fetchInstanceConfig("app_1", "ins_bad");
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(PlapiError);
      expect((error as InstanceType<typeof PlapiError>).status).toBe(404);
      expect((error as InstanceType<typeof PlapiError>).body).toBe("Not Found");
    }
  });

  test("default base URL is api.clerk.com", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await fetchInstanceConfig("app_1", "ins_1");
    expect(requestedUrl).toStartWith("https://api.clerk.com/");
  });

  describe("fetchInstanceConfigSchema", () => {
    test("constructs schema URL without keys", async () => {
      let requestedUrl = "";
      stubFetch(async (input) => {
        requestedUrl = input.toString();
        return new Response(JSON.stringify({ properties: {} }), { status: 200 });
      });

      await fetchInstanceConfigSchema("app_abc", "ins_def");

      expect(requestedUrl).toBe(
        "https://api.clerk.com/v1/platform/applications/app_abc/instances/ins_def/config/schema",
      );
    });

    test("appends repeated keys query params", async () => {
      let requestedUrl = "";
      stubFetch(async (input) => {
        requestedUrl = input.toString();
        return new Response(JSON.stringify({ properties: {} }), { status: 200 });
      });

      await fetchInstanceConfigSchema("app_abc", "ins_def", [
        "connection_oauth_google,connection_oauth_discord",
        "connection_oauth_apple",
      ]);

      expect(requestedUrl).toBe(
        "https://api.clerk.com/v1/platform/applications/app_abc/instances/ins_def/config/schema?keys=connection_oauth_google&keys=connection_oauth_discord&keys=connection_oauth_apple",
      );
    });
  });

  describe("putInstanceConfig", () => {
    test("sends PUT method with correct URL", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      stubFetch(async (input, init) => {
        capturedUrl = input.toString();
        capturedMethod = init?.method ?? "GET";
        return new Response(JSON.stringify({}), { status: 200 });
      });

      await putInstanceConfig("app_abc", "ins_def", { session: { lifetime: 3600 } });
      expect(capturedMethod).toBe("PUT");
      expect(capturedUrl).toBe(
        "https://api.clerk.com/v1/platform/applications/app_abc/instances/ins_def/config",
      );
    });

    test("sends Content-Type and Authorization headers", async () => {
      let capturedHeaders: Headers | undefined;
      stubFetch(async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({}), { status: 200 });
      });

      await putInstanceConfig("app_1", "ins_1", {});
      expect(capturedHeaders?.get("Authorization")).toBe("Bearer test_key_123");
      expect(capturedHeaders?.get("Content-Type")).toBe("application/json");
      expect(capturedHeaders?.get("Accept")).toBe("application/json");
    });

    test("sends JSON body", async () => {
      let capturedBody = "";
      stubFetch(async (_input, init) => {
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const payload = { session: { lifetime: 3600 } };
      await putInstanceConfig("app_1", "ins_1", payload);
      expect(JSON.parse(capturedBody)).toEqual(payload);
    });

    test("returns parsed JSON on success", async () => {
      const mockResult = { session: { lifetime: 3600 }, sign_up: { mode: "restricted" } };
      stubFetch(async () => new Response(JSON.stringify(mockResult), { status: 200 }));

      const result = await putInstanceConfig("app_1", "ins_1", { session: { lifetime: 3600 } });
      expect(result).toEqual(mockResult);
    });

    test("throws PlapiError on non-2xx response", async () => {
      stubFetch(async () => new Response("Bad Request", { status: 400 }));

      try {
        await putInstanceConfig("app_1", "ins_1", {});
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(PlapiError);
        expect((error as InstanceType<typeof PlapiError>).status).toBe(400);
      }
    });
  });

  describe("patchInstanceConfig", () => {
    test("sends PATCH method with correct URL", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      stubFetch(async (input, init) => {
        capturedUrl = input.toString();
        capturedMethod = init?.method ?? "GET";
        return new Response(JSON.stringify({}), { status: 200 });
      });

      await patchInstanceConfig("app_abc", "ins_def", { session: { lifetime: 3600 } });
      expect(capturedMethod).toBe("PATCH");
      expect(capturedUrl).toBe(
        "https://api.clerk.com/v1/platform/applications/app_abc/instances/ins_def/config",
      );
    });

    test("sends Content-Type and Authorization headers", async () => {
      let capturedHeaders: Headers | undefined;
      stubFetch(async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({}), { status: 200 });
      });

      await patchInstanceConfig("app_1", "ins_1", {});
      expect(capturedHeaders?.get("Authorization")).toBe("Bearer test_key_123");
      expect(capturedHeaders?.get("Content-Type")).toBe("application/json");
    });

    test("sends JSON body", async () => {
      let capturedBody = "";
      stubFetch(async (_input, init) => {
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const payload = { sign_up: { mode: "restricted" } };
      await patchInstanceConfig("app_1", "ins_1", payload);
      expect(JSON.parse(capturedBody)).toEqual(payload);
    });

    test("returns full config after merge", async () => {
      const mockResult = { session: { lifetime: 3600 }, sign_up: { mode: "public" } };
      stubFetch(async () => new Response(JSON.stringify(mockResult), { status: 200 }));

      const result = await patchInstanceConfig("app_1", "ins_1", { session: { lifetime: 3600 } });
      expect(result).toEqual(mockResult);
    });

    test("throws PlapiError on non-2xx response", async () => {
      stubFetch(async () => new Response("Unprocessable Entity", { status: 422 }));

      try {
        await patchInstanceConfig("app_1", "ins_1", { bad: "config" });
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(PlapiError);
        expect((error as InstanceType<typeof PlapiError>).status).toBe(422);
      }
    });
  });

  describe("fetchApplication", () => {
    const mockApp = {
      application_id: "app_abc",
      instances: [
        { instance_id: "ins_1", environment_type: "development", publishable_key: "pk_test_123" },
      ],
    };

    test("always sends include_secret_keys=true", async () => {
      let requestedUrl = "";
      stubFetch(async (input) => {
        requestedUrl = input.toString();
        return new Response(JSON.stringify(mockApp), { status: 200 });
      });

      await fetchApplication("app_abc");
      const url = new URL(requestedUrl);
      expect(url.pathname).toBe("/v1/platform/applications/app_abc");
      expect(url.searchParams.get("include_secret_keys")).toBe("true");
    });

    test("returns parsed application JSON", async () => {
      stubFetch(async () => new Response(JSON.stringify(mockApp), { status: 200 }));

      const result = await fetchApplication("app_abc");
      expect(result).toEqual(mockApp);
    });

    test("throws PlapiError on non-2xx response", async () => {
      stubFetch(async () => new Response("Not Found", { status: 404 }));

      try {
        await fetchApplication("app_bad");
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(PlapiError);
        expect((error as InstanceType<typeof PlapiError>).status).toBe(404);
      }
    });
  });

  describe("createApplication", () => {
    test("sends POST to correct URL with name in body", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody = "";
      stubFetch(async (input, init) => {
        capturedUrl = input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return new Response(
          JSON.stringify({ application_id: "app_new", name: "My App", instances: [] }),
          { status: 200 },
        );
      });

      await createApplication("My App");
      expect(capturedMethod).toBe("POST");
      expect(capturedUrl).toBe("https://api.clerk.com/v1/platform/applications");
      expect(JSON.parse(capturedBody)).toEqual({ name: "My App", from_source: "cli" });
    });

    test("sends Content-Type and Authorization headers", async () => {
      let capturedHeaders: Headers | undefined;
      stubFetch(async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ application_id: "app_new", instances: [] }), {
          status: 200,
        });
      });

      await createApplication("Test");
      expect(capturedHeaders?.get("Authorization")).toBe("Bearer test_key_123");
      expect(capturedHeaders?.get("Content-Type")).toBe("application/json");
      expect(capturedHeaders?.get("Accept")).toBe("application/json");
    });

    test("returns parsed application JSON", async () => {
      const mockApp = { application_id: "app_new", name: "My App", instances: [] };
      stubFetch(async () => new Response(JSON.stringify(mockApp), { status: 200 }));

      const result = await createApplication("My App");
      expect(result).toEqual(mockApp);
    });

    test("throws PlapiError on non-2xx response", async () => {
      stubFetch(async () => new Response("Bad Request", { status: 400 }));

      try {
        await createApplication("Bad");
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(PlapiError);
        expect((error as InstanceType<typeof PlapiError>).status).toBe(400);
      }
    });
  });

  describe("listApplications", () => {
    test("constructs correct URL", async () => {
      let requestedUrl = "";
      stubFetch(async (input) => {
        requestedUrl = input.toString();
        return new Response(JSON.stringify([]), { status: 200 });
      });

      await listApplications();
      expect(requestedUrl).toBe("https://api.clerk.com/v1/platform/applications");
    });

    test("returns parsed application list", async () => {
      const mockApps = [
        { application_id: "app_1", instances: [] },
        { application_id: "app_2", instances: [] },
      ];
      stubFetch(async () => new Response(JSON.stringify(mockApps), { status: 200 }));

      const result = await listApplications();
      expect(result).toEqual(mockApps);
    });

    test("throws PlapiError on non-2xx response", async () => {
      stubFetch(async () => new Response("Forbidden", { status: 403 }));

      try {
        await listApplications();
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(PlapiError);
        expect((error as InstanceType<typeof PlapiError>).status).toBe(403);
      }
    });
  });

  describe("createProductionInstance", () => {
    test("sends POST to instances with clone params", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      let capturedBody = "";
      const responseBody = {
        instance_id: "ins_prod_123",
        environment_type: "production" as const,
        active_domain: { id: "dmn_123", name: "example.com" },
        publishable_key: "pk_live_123",
        secret_key: "sk_live_123",
        cname_targets: [
          { host: "clerk.example.com", value: "frontend-api.clerk.services", required: true },
        ],
      };
      stubFetch(async (input, init) => {
        capturedMethod = init?.method ?? "GET";
        capturedUrl = input.toString();
        capturedBody = init?.body as string;
        return new Response(JSON.stringify(responseBody), { status: 201 });
      });

      const result = await createProductionInstance("app_abc", {
        home_url: "example.com",
        clone_instance_id: "ins_dev_123",
      });

      expect(capturedMethod).toBe("POST");
      expect(capturedUrl).toBe("https://api.clerk.com/v1/platform/applications/app_abc/instances");
      expect(JSON.parse(capturedBody)).toEqual({
        home_url: "example.com",
        clone_instance_id: "ins_dev_123",
      });
      expect(result).toEqual(responseBody);
    });
  });

  describe("getApplicationDomainStatus", () => {
    test("sends GET to domain status and returns parsed status", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      const responseBody = {
        status: "complete",
        dns: { status: "complete", cnames: {} },
        ssl: { status: "complete", required: true, failure_hints: [] },
        mail: { status: "complete", required: true },
      } as const;
      stubFetch(async (input, init) => {
        capturedMethod = init?.method ?? "GET";
        capturedUrl = input.toString();
        return new Response(JSON.stringify(responseBody), { status: 200 });
      });

      const result = await getApplicationDomainStatus("app_abc", "dmn_123");

      expect(capturedMethod).toBe("GET");
      expect(capturedUrl).toBe(
        "https://api.clerk.com/v1/platform/applications/app_abc/domains/dmn_123/status",
      );
      expect(result).toEqual(responseBody);
    });
  });

  describe("triggerApplicationDomainDNSCheck", () => {
    test("sends POST to domain dns_check and returns parsed status", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      const responseBody = {
        status: "incomplete",
        domain_id: "dmn_123",
        last_run_at: 1779739200000,
        dns: { status: "not_started", cnames: {} },
        ssl: { status: "not_started", required: true, failure_hints: [] },
        mail: { status: "not_started", required: true },
      } as const;
      stubFetch(async (input, init) => {
        capturedMethod = init?.method ?? "GET";
        capturedUrl = input.toString();
        return new Response(JSON.stringify(responseBody), { status: 200 });
      });

      const result = await triggerApplicationDomainDNSCheck("app_abc", "dmn_123");

      expect(capturedMethod).toBe("POST");
      expect(capturedUrl).toBe(
        "https://api.clerk.com/v1/platform/applications/app_abc/domains/dmn_123/dns_check",
      );
      expect(result).toEqual(responseBody);
    });
  });

  describe("listApplicationDomains", () => {
    test("sends GET to application domains and returns parsed domains", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      const responseBody = {
        data: [
          {
            object: "domain" as const,
            id: "dmn_123",
            name: "example.com",
            is_satellite: false,
            is_provider_domain: false,
            frontend_api_url: "https://clerk.example.com",
            accounts_portal_url: "https://accounts.example.com",
            development_origin: "",
            cname_targets: [
              { host: "clerk.example.com", value: "frontend-api.clerk.services", required: true },
            ],
            created_at: "2026-05-06T00:00:00Z",
            updated_at: "2026-05-06T00:00:00Z",
          },
        ],
        total_count: 1,
      };
      stubFetch(async (input, init) => {
        capturedMethod = init?.method ?? "GET";
        capturedUrl = input.toString();
        return new Response(JSON.stringify(responseBody), { status: 200 });
      });

      const result = await listApplicationDomains("app_abc");

      expect(capturedMethod).toBe("GET");
      expect(capturedUrl).toBe("https://api.clerk.com/v1/platform/applications/app_abc/domains");
      expect(result).toEqual(responseBody);
    });
  });
});

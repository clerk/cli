import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { fetchInstanceConfig, putInstanceConfig, patchInstanceConfig, PlapiError } from "./plapi";

describe("plapi", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.CLERK_PLATFORM_API_KEY = "test_key_123";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  test("throws when CLERK_PLATFORM_API_KEY is not set", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await expect(fetchInstanceConfig("app_1", "ins_1")).rejects.toThrow(
      "CLERK_PLATFORM_API_KEY environment variable is required",
    );
  });

  test("constructs correct URL", async () => {
    let requestedUrl = "";
    globalThis.fetch = async (input: RequestInfo | URL) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await fetchInstanceConfig("app_abc", "ins_def");
    expect(requestedUrl).toBe(
      "https://api.clerk.com/v1/platform/applications/app_abc/instances/ins_def/config",
    );
  });

  test("sends Bearer token in Authorization header", async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await fetchInstanceConfig("app_1", "ins_1");
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer test_key_123");
    expect(capturedHeaders?.get("Accept")).toBe("application/json");
  });

  test("returns parsed JSON on success", async () => {
    const mockConfig = { session: { lifetime: 604800 }, sign_up: { mode: "public" } };
    globalThis.fetch = async () => new Response(JSON.stringify(mockConfig), { status: 200 });

    const result = await fetchInstanceConfig("app_1", "ins_1");
    expect(result).toEqual(mockConfig);
  });

  test("throws PlapiError on non-2xx response", async () => {
    globalThis.fetch = async () => new Response("Not Found", { status: 404 });

    try {
      await fetchInstanceConfig("app_1", "ins_bad");
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(PlapiError);
      expect((error as PlapiError).status).toBe(404);
      expect((error as PlapiError).body).toBe("Not Found");
    }
  });

  test("default base URL is api.clerk.com", async () => {
    let requestedUrl = "";
    globalThis.fetch = async (input: RequestInfo | URL) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await fetchInstanceConfig("app_1", "ins_1");
    expect(requestedUrl).toStartWith("https://api.clerk.com/");
  });

  describe("putInstanceConfig", () => {
    test("sends PUT method with correct URL", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = input.toString();
        capturedMethod = init?.method ?? "GET";
        return new Response(JSON.stringify({}), { status: 200 });
      };

      await putInstanceConfig("app_abc", "ins_def", { session: { lifetime: 3600 } });
      expect(capturedMethod).toBe("PUT");
      expect(capturedUrl).toBe(
        "https://api.clerk.com/v1/platform/applications/app_abc/instances/ins_def/config",
      );
    });

    test("sends Content-Type and Authorization headers", async () => {
      let capturedHeaders: Headers | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({}), { status: 200 });
      };

      await putInstanceConfig("app_1", "ins_1", {});
      expect(capturedHeaders?.get("Authorization")).toBe("Bearer test_key_123");
      expect(capturedHeaders?.get("Content-Type")).toBe("application/json");
      expect(capturedHeaders?.get("Accept")).toBe("application/json");
    });

    test("sends JSON body", async () => {
      let capturedBody = "";
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({}), { status: 200 });
      };

      const payload = { session: { lifetime: 3600 } };
      await putInstanceConfig("app_1", "ins_1", payload);
      expect(JSON.parse(capturedBody)).toEqual(payload);
    });

    test("returns parsed JSON on success", async () => {
      const mockResult = { session: { lifetime: 3600 }, sign_up: { mode: "restricted" } };
      globalThis.fetch = async () => new Response(JSON.stringify(mockResult), { status: 200 });

      const result = await putInstanceConfig("app_1", "ins_1", { session: { lifetime: 3600 } });
      expect(result).toEqual(mockResult);
    });

    test("throws PlapiError on non-2xx response", async () => {
      globalThis.fetch = async () => new Response("Bad Request", { status: 400 });

      try {
        await putInstanceConfig("app_1", "ins_1", {});
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(PlapiError);
        expect((error as PlapiError).status).toBe(400);
      }
    });
  });

  describe("patchInstanceConfig", () => {
    test("sends PATCH method with correct URL", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = input.toString();
        capturedMethod = init?.method ?? "GET";
        return new Response(JSON.stringify({}), { status: 200 });
      };

      await patchInstanceConfig("app_abc", "ins_def", { session: { lifetime: 3600 } });
      expect(capturedMethod).toBe("PATCH");
      expect(capturedUrl).toBe(
        "https://api.clerk.com/v1/platform/applications/app_abc/instances/ins_def/config",
      );
    });

    test("sends Content-Type and Authorization headers", async () => {
      let capturedHeaders: Headers | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({}), { status: 200 });
      };

      await patchInstanceConfig("app_1", "ins_1", {});
      expect(capturedHeaders?.get("Authorization")).toBe("Bearer test_key_123");
      expect(capturedHeaders?.get("Content-Type")).toBe("application/json");
    });

    test("sends JSON body", async () => {
      let capturedBody = "";
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({}), { status: 200 });
      };

      const payload = { sign_up: { mode: "restricted" } };
      await patchInstanceConfig("app_1", "ins_1", payload);
      expect(JSON.parse(capturedBody)).toEqual(payload);
    });

    test("returns full config after merge", async () => {
      const mockResult = { session: { lifetime: 3600 }, sign_up: { mode: "public" } };
      globalThis.fetch = async () => new Response(JSON.stringify(mockResult), { status: 200 });

      const result = await patchInstanceConfig("app_1", "ins_1", { session: { lifetime: 3600 } });
      expect(result).toEqual(mockResult);
    });

    test("throws PlapiError on non-2xx response", async () => {
      globalThis.fetch = async () => new Response("Unprocessable Entity", { status: 422 });

      try {
        await patchInstanceConfig("app_1", "ins_1", { bad: "config" });
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(PlapiError);
        expect((error as PlapiError).status).toBe(422);
      }
    });
  });
});

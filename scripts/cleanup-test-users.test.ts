import { afterEach, describe, expect, mock, test } from "bun:test";
import { plapiGet } from "./cleanup-test-users.ts";

const originalFetch = globalThis.fetch;

describe("cleanup-test-users", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("retries transient Platform API failures before returning JSON", async () => {
    globalThis.fetch = mock(async () => {
      const attempts = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length;
      if (attempts === 1) {
        return new Response("temporary failure", { status: 500 });
      }

      return Response.json({ instances: [] });
    }) as unknown as typeof fetch;

    const result = await plapiGet("/v1/platform/applications/app_123", "ak_test", {
      delayMs: 0,
    });

    expect(result).toEqual({ instances: [] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

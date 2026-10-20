import { describe, expect, test } from "bun:test";
import { assertStableVersion, sendCliReleaseDispatch } from "./dispatch-evals.ts";

describe("stable CLI eval dispatch", () => {
  test("rejects canary and snapshot versions", () => {
    expect(() => assertStableVersion("3.5.0-canary.1")).toThrow("stable");
    expect(() => assertStableVersion("3.5.0-snapshot.1")).toThrow("stable");
    expect(() => assertStableVersion("3.5.0")).not.toThrow();
  });

  test("sends the released version as a repository dispatch", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    await sendCliReleaseDispatch("3.5.0", "test-token", async (url, init) => {
      request = { url, init };
      return new Response(null, { status: 204 });
    });
    expect(request?.url).toBe("https://api.github.com/repos/clerk/clerk-evals/dispatches");
    expect(request?.init?.method).toBe("POST");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      event_type: "clerk_cli_released",
      client_payload: { version: "3.5.0" },
    });
  });

  test("requires the dedicated credential and reports API rejection", async () => {
    await expect(sendCliReleaseDispatch("3.5.0", "")).rejects.toThrow("CLERK_EVALS_DISPATCH_TOKEN");
    await expect(
      sendCliReleaseDispatch(
        "3.5.0",
        "test-token",
        async () => new Response('{"message":"Forbidden"}', { status: 403 }),
      ),
    ).rejects.toThrow("HTTP 403");
  });
});

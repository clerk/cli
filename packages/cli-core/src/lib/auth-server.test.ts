import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { startAuthServer } from "./auth-server.ts";
import { AUTH_TIMEOUT_MS } from "./constants.ts";
import { ERROR_CODE } from "./errors.ts";
import { useCaptureLog } from "../test/lib/stubs.ts";

describe("auth-server", () => {
  let serveSpy: ReturnType<typeof spyOn> | undefined;
  let clearTimeoutSpy: ReturnType<typeof spyOn> | undefined;
  let timeoutSpy: ReturnType<typeof spyOn> | undefined;
  let openServer: { stop: () => void } | undefined;
  useCaptureLog();

  afterEach(() => {
    serveSpy?.mockRestore();
    clearTimeoutSpy?.mockRestore();
    timeoutSpy?.mockRestore();
    openServer?.stop();
    serveSpy = undefined;
    clearTimeoutSpy = undefined;
    timeoutSpy = undefined;
    openServer = undefined;
  });

  test("starts on a random port", () => {
    const server = startAuthServer("test-state");
    expect(server.port).toBeGreaterThan(0);
    server.stop();
  });

  test("clears the timeout when Bun.serve throws", () => {
    serveSpy = spyOn(Bun, "serve").mockImplementation(() => {
      throw new Error("listen failed");
    });
    clearTimeoutSpy = spyOn(globalThis, "clearTimeout");

    expect(() => startAuthServer("test-state")).toThrow("listen failed");
    expect(serveSpy).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  // A host that forbids binding loopback fails every login on the machine —
  // worth telling apart from anything the user did.
  test("a bind failure carries the callback_bind_failed code", () => {
    serveSpy = spyOn(Bun, "serve").mockImplementation(() => {
      throw new Error("listen failed");
    });

    expect(() => startAuthServer("test-state")).toThrowError(
      expect.objectContaining({ code: ERROR_CODE.CALLBACK_BIND_FAILED }),
    );
  });

  // The wait expiring is the single most common way login ends without a
  // session; it must not look like a crash.
  test("the callback wait timing out carries the auth_timeout code", async () => {
    let fire: (() => void) | undefined;
    const realSetTimeout = globalThis.setTimeout;
    timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      // Capture only the login deadline; everything else keeps real timing.
      if (ms === AUTH_TIMEOUT_MS) {
        fire = cb;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(cb, ms, ...rest);
    }) as typeof setTimeout);

    const server = startAuthServer("test-state");
    openServer = server;
    const errorPromise = server.waitForCallback().catch((e: unknown) => e);

    expect(fire).toBeDefined();
    fire?.();

    const error = await errorPromise;
    expect(error).toMatchObject({ code: ERROR_CODE.AUTH_TIMEOUT });
    expect((error as Error).message).toContain("timed out");
  });

  test("callback resolves with code on valid request", async () => {
    const state = "my-test-state";
    const server = startAuthServer(state);

    const resultPromise = server.waitForCallback();

    const response = await fetch(
      `http://127.0.0.1:${server.port}/callback?code=auth-code-123&state=${state}`,
    );
    expect(response.status).toBe(200);

    const result = await resultPromise;
    expect(result.code).toBe("auth-code-123");
  });

  test("callback rejects on invalid state", async () => {
    const server = startAuthServer("expected-state");

    // Catch rejection immediately to prevent unhandled rejection
    const errorPromise = server.waitForCallback().catch((e: Error) => e);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/callback?code=auth-code&state=wrong-state`,
    );
    expect(response.status).toBe(400);

    const error = await errorPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Invalid state");
    expect(error).toMatchObject({ code: ERROR_CODE.OAUTH_STATE_MISMATCH });
  });

  test("callback rejects on missing code", async () => {
    const server = startAuthServer("test-state");

    const errorPromise = server.waitForCallback().catch((e: Error) => e);

    const response = await fetch(`http://127.0.0.1:${server.port}/callback?state=test-state`);
    expect(response.status).toBe(400);

    const error = await errorPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("No authorization code");
    expect(error).toMatchObject({ code: ERROR_CODE.OAUTH_NO_CODE });
  });

  test("callback rejects on OAuth error", async () => {
    const server = startAuthServer("test-state");

    const errorPromise = server.waitForCallback().catch((e: Error) => e);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/callback?error=access_denied&error_description=User+denied+access`,
    );
    expect(response.status).toBe(200);

    const error = await errorPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("User denied access");
    expect(error).toMatchObject({ code: ERROR_CODE.OAUTH_PROVIDER_ERROR });
  });

  test("root path returns waiting message", async () => {
    const server = startAuthServer("test-state");

    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const text = await response.text();
    expect(text).toContain("waiting for authentication");

    server.stop();
  });
});

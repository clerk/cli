import { test, expect, describe } from "bun:test";
import { startAuthServer } from "./auth-server";

describe("auth-server", () => {
  test("starts on a random port", () => {
    const server = startAuthServer("test-state");
    expect(server.port).toBeGreaterThan(0);
    server.stop();
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
  });

  test("callback rejects on missing code", async () => {
    const server = startAuthServer("test-state");

    const errorPromise = server.waitForCallback().catch((e: Error) => e);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/callback?state=test-state`,
    );
    expect(response.status).toBe(400);

    const error = await errorPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("No authorization code");
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
  });

  test("root path returns waiting message", async () => {
    const server = startAuthServer("test-state");

    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const text = await response.text();
    expect(text).toContain("waiting for authentication");

    server.stop();
  });
});

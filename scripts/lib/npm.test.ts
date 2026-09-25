import { describe, expect, test } from "bun:test";
import { isAlreadyPublishedError, isPublished, waitUntilPublished } from "./npm.ts";

describe("waitUntilPublished", () => {
  test("retries until npm reports the package version is published", async () => {
    const attempts: string[] = [];

    await waitUntilPublished("@clerk/cli-linux-x64", "1.2.3-canary.0", {
      intervalMs: 0,
      timeoutMs: 1_000,
      isPublished: async (name, version) => {
        attempts.push(`${name}@${version}`);
        return attempts.length === 3;
      },
    });

    expect(attempts).toEqual([
      "@clerk/cli-linux-x64@1.2.3-canary.0",
      "@clerk/cli-linux-x64@1.2.3-canary.0",
      "@clerk/cli-linux-x64@1.2.3-canary.0",
    ]);
  });
});

describe("isPublished", () => {
  const respond = (...statuses: Array<number | Error>) => {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      const next = statuses.shift()!;
      if (next instanceof Error) throw next;
      return new Response(null, { status: next });
    };
    return { urls, fetch };
  };

  test("reads the per-version document for a scoped package", async () => {
    const { urls, fetch } = respond(200);

    expect(await isPublished("@clerk/cli-linux-x64", "1.2.3-canary.0", { fetch })).toBe(true);
    expect(urls).toEqual(["https://registry.npmjs.org/%40clerk%2Fcli-linux-x64/1.2.3-canary.0"]);
  });

  test("reports a 404 as not published", async () => {
    const { fetch } = respond(404);

    expect(await isPublished("clerk", "1.2.3", { fetch })).toBe(false);
  });

  test("retries server errors and network failures", async () => {
    const { urls, fetch } = respond(503, new Error("ECONNRESET"), 200);

    expect(await isPublished("clerk", "1.2.3", { fetch, retryDelayMs: 0 })).toBe(true);
    expect(urls).toHaveLength(3);
  });

  test("throws without retrying a client error", async () => {
    const { urls, fetch } = respond(401, 200);

    await expect(isPublished("clerk", "1.2.3", { fetch, retryDelayMs: 0 })).rejects.toThrow(
      "Could not check whether clerk@1.2.3 is published",
    );
    expect(urls).toHaveLength(1);
  });
});

describe("isAlreadyPublishedError", () => {
  test("matches npm's publish conflict", () => {
    const error = new Error(
      "npm publish failed (exit 1): npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@clerk%2fcli-win32-arm64 - You cannot publish over the previously published versions: 3.4.1-canary.eeb86c5.",
    );

    expect(isAlreadyPublishedError(error)).toBe(true);
  });

  test("does not match other publish failures", () => {
    expect(isAlreadyPublishedError(new Error("npm error 403 403 Forbidden - PUT"))).toBe(false);
    expect(isAlreadyPublishedError("cannot publish over the previously published versions")).toBe(
      false,
    );
  });
});

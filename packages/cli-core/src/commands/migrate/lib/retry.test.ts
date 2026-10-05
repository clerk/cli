import { describe, expect, test } from "bun:test";
import { BapiError, CliError } from "../../../lib/errors.ts";
import { RateLimitExceededError, readRetryAfter, retryOn429 } from "./retry.ts";

const rateLimited = (headers: Record<string, string> = {}) =>
  new BapiError(
    429,
    JSON.stringify({ errors: [{ code: "e", message: "slow" }] }),
    new Headers(headers),
  );

const failed = (status: number) =>
  new BapiError(
    status,
    JSON.stringify({ errors: [{ code: "e", message: "nope" }] }),
    new Headers(),
  );

describe("readRetryAfter", () => {
  test.each([
    ["12", 12],
    ["0", undefined],
    ["-1", undefined],
    ["soon", undefined],
  ])("Retry-After: %s -> %p", (header, expected) => {
    expect(readRetryAfter(rateLimited({ "retry-after": header }))).toBe(
      expected as number | undefined,
    );
  });

  test("falls back to the error body's retryAfter meta", () => {
    const error = new BapiError(
      429,
      JSON.stringify({ errors: [{ code: "e", message: "slow", meta: { retryAfter: 7 } }] }),
      new Headers(),
    );
    expect(readRetryAfter(error)).toBe(7);
  });

  test("prefers the header over the body", () => {
    const error = new BapiError(
      429,
      JSON.stringify({ errors: [{ code: "e", message: "slow", meta: { retryAfter: 7 } }] }),
      new Headers({ "retry-after": "3" }),
    );
    expect(readRetryAfter(error)).toBe(3);
  });

  test("returns undefined when neither carries a value", () => {
    expect(readRetryAfter(rateLimited())).toBeUndefined();
  });
});

describe("retryOn429", () => {
  test("returns the value when the call succeeds first time", async () => {
    expect(await retryOn429(async () => "ok")).toBe("ok");
  });

  test("retries after a 429 and returns the eventual value", async () => {
    let attempts = 0;
    const result = await retryOn429(
      async () => {
        attempts++;
        if (attempts === 1) throw rateLimited({ "retry-after": "1" });
        return "ok";
      },
      { defaultDelayMs: 5 },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("waits the interval the server asked for", async () => {
    let attempts = 0;
    const started = performance.now();

    await retryOn429(async () => {
      attempts++;
      if (attempts === 1) throw rateLimited({ "retry-after": "1" });
      return "ok";
    });

    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
  });

  test("falls back to the default delay when no Retry-After is given", async () => {
    let attempts = 0;
    await retryOn429(
      async () => {
        attempts++;
        if (attempts === 1) throw rateLimited();
        return "ok";
      },
      { defaultDelayMs: 5 },
    );
    expect(attempts).toBe(2);
  });

  test("reports each backoff to the caller so it can log against its own run", async () => {
    const seen: { attempt: number; delaySeconds: number }[] = [];
    let attempts = 0;

    await retryOn429(
      async () => {
        attempts++;
        if (attempts <= 2) throw rateLimited();
        return "ok";
      },
      {
        defaultDelayMs: 5,
        onRetry: ({ attempt, delaySeconds }) => seen.push({ attempt, delaySeconds }),
      },
    );

    expect(seen.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(seen[0]?.delaySeconds).toBe(0.005);
  });

  test("gives up after the ceiling, distinctly from an ordinary failure", async () => {
    let attempts = 0;

    await expect(
      retryOn429(
        async () => {
          attempts++;
          throw rateLimited();
        },
        { maxRetries: 2, defaultDelayMs: 5 },
      ),
    ).rejects.toThrow(RateLimitExceededError);

    // One initial attempt plus maxRetries retries.
    expect(attempts).toBe(3);
  });

  // Only rate limiting is transient; retrying a 422 would just repeat it.
  test.each([[400], [401], [404], [422], [500]])("lets a %i through untouched", async (status) => {
    let attempts = 0;

    await expect(
      retryOn429(async () => {
        attempts++;
        throw failed(status);
      }),
    ).rejects.toThrow(BapiError);

    expect(attempts).toBe(1);
  });

  test("lets a non-API error through untouched", async () => {
    await expect(retryOn429(async () => Promise.reject(new CliError("boom")))).rejects.toThrow(
      CliError,
    );
  });
});

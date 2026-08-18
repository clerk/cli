/**
 * Rate-limit backoff, shared by `migrate import` and `migrate delete`.
 *
 * Both walk the whole user set through BAPI and hit the same limits, so they
 * back off identically rather than approximately: extracting this is what
 * makes "deletion retries the same as import" true by construction.
 */

import { BapiError } from "../../../lib/errors.ts";
import { MAX_RETRIES, RETRY_DELAY_MS, getRetryDelay } from "./instance.ts";

/** Seconds to wait per a 429's `Retry-After` header or error meta, if given. */
export function readRetryAfter(error: BapiError): number | undefined {
  const header = error.headers?.get("retry-after");
  if (header) {
    const parsed = Number(header);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const meta = error.meta?.retryAfter;
  return typeof meta === "number" && meta > 0 ? meta : undefined;
}

/** Raised once a 429 has been retried {@link MAX_RETRIES} times. */
export class RateLimitExceededError extends Error {
  constructor(public readonly attempts: number) {
    super(`Rate limit exceeded after ${attempts} retries`);
    this.name = "RateLimitExceededError";
  }
}

export type RetryOptions = {
  /** Called before each backoff, so the caller can log it against its own run. */
  onRetry?: (info: { attempt: number; delaySeconds: number; message: string }) => void;
  maxRetries?: number;
  /** Backoff when the response carries no `Retry-After`. */
  defaultDelayMs?: number;
};

/**
 * Runs `fn`, backing off and retrying whenever BAPI answers 429.
 *
 * Anything other than a 429 propagates untouched — only rate limiting is
 * transient. Exhausting the retries raises {@link RateLimitExceededError} so
 * the caller can record it distinctly from an ordinary API failure.
 */
export async function retryOn429<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const defaultDelayMs = options.defaultDelayMs ?? RETRY_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof BapiError) || error.status !== 429) throw error;
      if (attempt >= maxRetries) throw new RateLimitExceededError(maxRetries);

      const { delayMs, delaySeconds } = getRetryDelay(readRetryAfter(error), defaultDelayMs);
      options.onRetry?.({
        attempt: attempt + 1,
        delaySeconds,
        message: `Rate limit hit (429), retrying in ${delaySeconds}s (attempt ${attempt + 1}/${maxRetries})`,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Instance-type detection and the throughput limits that follow from it.
 *
 * Ported from the standalone migration-tool's `src/envs-constants.ts`, minus
 * its dotenv/Zod env bootstrap: the secret key arrives from
 * `resolveBapiSecretKey`, and only the two override knobs read the environment.
 */

/** Development instances are capped at this many users by Clerk. */
export const DEV_USER_LIMIT = 500;

/** How many times a 429 is retried before the user is recorded as failed. */
export const MAX_RETRIES = 5;

/** Fallback backoff when a 429 response carries no `Retry-After`. */
export const RETRY_DELAY_MS = 10_000;

export type InstanceType = "dev" | "prod";

/**
 * Derives the instance type from the secret key's prefix.
 *
 * @example detectInstanceType("sk_live_xxx") // "prod"
 * @example detectInstanceType("sk_test_xxx") // "dev"
 */
export function detectInstanceType(secretKey: string): InstanceType {
  return secretKey.split("_")[1] === "live" ? "prod" : "dev";
}

/**
 * Clerk's documented `POST /v1/users` rate limits, as requests per second:
 * 1000 per 10s for production, 100 per 10s for development.
 */
export function getDefaultRateLimit(instanceType: InstanceType): number {
  return instanceType === "prod" ? 100 : 10;
}

/**
 * Concurrency that saturates ~95% of the rate limit, assuming ~100ms of API
 * latency per call: N concurrent requests at 100ms each yield N * 10 req/s.
 *
 * Override with `CLERK_MIGRATE_CONCURRENCY_LIMIT` when actual latency differs.
 */
export function getDefaultConcurrencyLimit(rateLimit: number): number {
  return Math.max(1, Math.floor(rateLimit * 0.095));
}

export type ResolvedLimits = {
  instanceType: InstanceType;
  rateLimit: number;
  concurrencyLimit: number;
};

/**
 * Resolves throughput limits for a run: defaults from the detected instance
 * type, each overridable by an environment variable.
 *
 * Non-numeric or non-positive overrides are ignored in favour of the default
 * rather than failing the run — an unusable limit would stall the import.
 */
export function resolveLimits(
  secretKey: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedLimits {
  const instanceType = detectInstanceType(secretKey);

  const positive = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };

  const rateLimit = positive(env.CLERK_MIGRATE_RATE_LIMIT) ?? getDefaultRateLimit(instanceType);
  const concurrencyLimit =
    positive(env.CLERK_MIGRATE_CONCURRENCY_LIMIT) ?? getDefaultConcurrencyLimit(rateLimit);

  return { instanceType, rateLimit, concurrencyLimit };
}

/**
 * Backoff for a 429, preferring the server's `Retry-After` over the default.
 *
 * @param retryAfterSeconds - `Retry-After` value from the response, if present.
 * @param defaultDelayMs - Fallback delay in milliseconds.
 */
export function getRetryDelay(
  retryAfterSeconds: number | undefined,
  defaultDelayMs: number,
): { delayMs: number; delaySeconds: number } {
  const delayMs = retryAfterSeconds ? retryAfterSeconds * 1000 : defaultDelayMs;
  const delaySeconds = retryAfterSeconds || defaultDelayMs / 1000;
  return { delayMs, delaySeconds };
}

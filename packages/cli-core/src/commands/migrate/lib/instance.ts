/**
 * Instance-type detection and the throughput limits that follow from it.
 *
 * Ported from the standalone migration-tool's `src/envs-constants.ts`, minus
 * its dotenv/Zod env bootstrap: the secret key arrives from
 * `resolveBapiSecretKey`, and only the two override knobs read the environment.
 */

/**
 * The user limit a development instance is created with.
 *
 * Only a fallback: `GET /v1/instance` serves the real limit as
 * `max_allowed_users` (see {@link resolveUserLimit}), but an API older than
 * clerk/clerk_go#22871 leaves the field out. Then a development instance is
 * assumed to hold this many, or `CLERK_MIGRATE_DEV_USER_LIMIT` when Clerk raised
 * it, and a production instance no limit. The import stops at the first
 * `user_quota_exceeded` either way.
 */
export const DEV_USER_LIMIT = 100;

/** A positive number from the environment, or undefined. */
function positive(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * `max_allowed_users` as `GET /v1/instance` returned it: a number, `null` for
 * an instance with no limit, or `undefined` when the response had no such field
 * or could not be read.
 */
export type ServedUserLimit = number | null | undefined;

export type UserLimit = {
  /** `null` when the instance has no user limit. */
  limit: number | null;
  /**
   * `api` when `GET /v1/instance` served it, `env` from
   * `CLERK_MIGRATE_DEV_USER_LIMIT`, `default` otherwise.
   */
  source: "api" | "env" | "default";
};

/**
 * The user limit the checks hold this run to.
 *
 * A served `max_allowed_users` wins, for either instance type, over
 * `CLERK_MIGRATE_DEV_USER_LIMIT` too: it is the number Clerk enforces. Without
 * one, a development instance gets the override when it is a positive number,
 * otherwise {@link DEV_USER_LIMIT}, and a production instance no limit.
 */
export function resolveUserLimit(
  instanceType: InstanceType,
  served: ServedUserLimit,
  env: Record<string, string | undefined> = process.env,
): UserLimit {
  if (served !== undefined) return { limit: served, source: "api" };
  if (instanceType === "prod") return { limit: null, source: "default" };
  const override = positive(env.CLERK_MIGRATE_DEV_USER_LIMIT);
  return override
    ? { limit: Math.floor(override), source: "env" }
    : { limit: DEV_USER_LIMIT, source: "default" };
}

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

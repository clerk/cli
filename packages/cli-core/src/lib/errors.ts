import { isAgent } from "../mode.ts";

/** Standard process exit codes used by the CLI. */
export const EXIT_CODE = {
  /** Clean exit, no error. */
  SUCCESS: 0,
  /** General runtime error. */
  GENERAL: 1,
  /** Invalid arguments or options. */
  USAGE: 2,
  /** Interrupted by Ctrl+C (128 + SIGINT signal 2). */
  SIGINT: 130,
} as const;

type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

/**
 * Machine-readable error codes for programmatic consumption.
 *
 * Agents and CI scripts can branch on these codes instead of regex-matching
 * error messages. Every {@link CliError} should include a code from this list.
 */
export const ERROR_CODE = {
  /** Not authenticated — run `clerk auth login` or set an API key. */
  AUTH_REQUIRED: "auth_required",
  /** No project linked to this directory. */
  NOT_LINKED: "not_linked",
  /** API key has wrong prefix (e.g. sk_ where ak_ expected). */
  INVALID_KEY_FORMAT: "invalid_key_format",
  /** Invalid command arguments or options. */
  USAGE_ERROR: "usage_error",
  /** Referenced instance not found. */
  INSTANCE_NOT_FOUND: "instance_not_found",
  /** Referenced application not found or has no matching resources. */
  APP_NOT_FOUND: "app_not_found",
  /** Secret key unavailable for the target instance. */
  NO_SECRET_KEY: "no_secret_key",
  /** File not found on disk. */
  FILE_NOT_FOUND: "file_not_found",
  /** A webhook signature failed local HMAC verification. */
  INVALID_WEBHOOK_SIGNATURE: "invalid_webhook_signature",
  /** Input is not valid JSON or not an object. */
  INVALID_JSON: "invalid_json",
  /** Failed to fetch or parse the OpenAPI catalog. */
  CATALOG_ERROR: "catalog_error",
  /** Doctor checks found issues. */
  DOCTOR_FAILED: "doctor_failed",
  /** Frontend API request failed. */
  FAPI_ERROR: "fapi_error",
  /** Subscription plan does not cover the dev instance's enabled features. */
  PLAN_INSUFFICIENT: "plan_insufficient",
  /** Application already has a production instance; flow should re-derive state. */
  PRODUCTION_INSTANCE_EXISTS: "production_instance_exists",
  /** `home_url` is a provider domain (e.g. *.vercel.app) and not allowed. */
  PROVIDER_DOMAIN_NOT_ALLOWED: "provider_domain_not_allowed",
  /** `home_url` is already claimed by another instance. */
  HOME_URL_TAKEN: "home_url_taken",
  /** PLAPI rejected a request parameter as malformed. */
  FORM_PARAM_INVALID: "form_param_invalid",
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];
export const AUTH_ERROR_REASON = {
  NOT_LOGGED_IN: "not_logged_in",
  SESSION_EXPIRED: "session_expired",
} as const;

export type AuthErrorReason = (typeof AUTH_ERROR_REASON)[keyof typeof AUTH_ERROR_REASON];

interface CliErrorOptions {
  /** Machine-readable error code for programmatic consumption. */
  code?: ErrorCode;
  /** Process exit code. Defaults to {@link EXIT_CODE.GENERAL}. */
  exitCode?: ExitCode;
  /** URL to relevant documentation, printed after the error message. */
  docsUrl?: string;
}

interface AuthErrorOptions extends Omit<CliErrorOptions, "code"> {
  message?: string;
  reason: AuthErrorReason;
}

/**
 * General-purpose CLI error for user-facing messages.
 *
 * Throw this when a command encounters a known failure (e.g. missing
 * configuration, invalid input, resource not found). The global error handler
 * in `cli.ts` prints the message in red and exits with `exitCode`. Any Clerk
 * URLs in `docsUrl` will automatically have ".md" appended in agent mode to
 * link to the raw markdown version.
 *
 * For usage/validation errors, **prefer {@link throwUsageError}** over constructing
 * a `CliError` with `EXIT_CODE.USAGE` directly.
 *
 * @example
 * ```ts
 * throw new CliError("No Clerk project linked.", {
 *   code: ERROR_CODE.NOT_LINKED,
 * });
 * ```
 */
export class CliError extends Error {
  public code?: ErrorCode;
  public exitCode: ExitCode;
  public docsUrl?: string;

  constructor(message: string, options?: CliErrorOptions) {
    super(message);
    this.name = "CliError";
    this.code = options?.code;
    this.exitCode = options?.exitCode ?? EXIT_CODE.GENERAL;

    if (options?.docsUrl) {
      this.docsUrl = options.docsUrl;

      // If we're running in agent mode and the docs URL is a Clerk docs link
      // without a .md extension, add .md to get the raw markdown URL.
      if (
        isAgent() &&
        this.docsUrl.startsWith("https://clerk.com/docs/") &&
        !this.docsUrl.endsWith(".md")
      ) {
        this.docsUrl += ".md";
      }
    }
  }
}

const AUTH_ERROR_MESSAGE: Record<AuthErrorReason, string> = {
  [AUTH_ERROR_REASON.NOT_LOGGED_IN]: "Not logged in. Run `clerk auth login` to authenticate",
  [AUTH_ERROR_REASON.SESSION_EXPIRED]: "Session expired. Run `clerk auth login` to re-authenticate",
};

export class AuthError extends CliError {
  declare code: typeof ERROR_CODE.AUTH_REQUIRED;
  public reason: AuthErrorReason;

  constructor(options: AuthErrorOptions) {
    const { message, reason, ...rest } = options;
    super(message ?? AUTH_ERROR_MESSAGE[reason], {
      ...rest,
      code: ERROR_CODE.AUTH_REQUIRED,
    });
    this.name = "AuthError";
    this.code = ERROR_CODE.AUTH_REQUIRED;
    this.reason = reason;
  }
}

/**
 * Signals that the user cancelled an interactive prompt or confirmation.
 *
 * The global error handler treats this as a clean exit (`EXIT_CODE.SUCCESS`)
 * with no error message.
 *
 * **Do not construct directly** — use {@link throwUserAbort} instead.
 */
export class UserAbortError extends Error {
  constructor() {
    super("User aborted");
    this.name = "UserAbortError";
  }
}

interface ClerkErrorEntry {
  code?: string;
  message?: string;
  long_message?: string;
  meta?: Record<string, unknown>;
}

interface ClerkErrorEnvelope {
  errors?: ClerkErrorEntry[];
  clerk_trace_id?: string;
}

interface ParsedApiBody {
  code: string | null;
  message: string;
  longMessage: string | null;
  meta: Record<string, unknown> | null;
  clerkTraceId: string | null;
}

const MAX_BODY_PREVIEW = 200;

function truncateBody(body: string): string {
  return body.length > MAX_BODY_PREVIEW ? body.slice(0, MAX_BODY_PREVIEW) + "..." : body;
}

function parseApiBody(status: number, body: string): ParsedApiBody {
  const fallback = (msg: string): ParsedApiBody => ({
    code: null,
    message: msg,
    longMessage: null,
    meta: null,
    clerkTraceId: null,
  });

  if (body.length === 0) {
    return fallback(`API error (${status})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fallback(truncateBody(body));
  }

  if (parsed === null || typeof parsed !== "object") {
    return fallback(truncateBody(body));
  }

  const envelope = parsed as ClerkErrorEnvelope;
  const first = envelope.errors?.[0];
  if (!first) {
    return fallback(truncateBody(body));
  }

  return {
    code: first.code ?? null,
    message: first.message ?? `API error (${status})`,
    longMessage: first.long_message ?? null,
    meta: first.meta ?? null,
    clerkTraceId: envelope.clerk_trace_id ?? null,
  };
}

export function isPromptExitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "ExitPromptError" &&
    error.message.includes("User force closed the prompt")
  );
}

/**
 * Base class for HTTP API errors.
 *
 * Thrown when an API request returns a non-OK status. The global error handler
 * extracts the first error message from the JSON body (or truncates the raw
 * body) and prints it. Subclasses {@link BapiError} and {@link PlapiError}
 * add a labeled prefix so users know which API failed.
 *
 * @param status - HTTP status code
 * @param body - Raw response body text
 * @param headers - Response headers (optional)
 */
export class ApiError extends Error {
  public context?: string;
  public code: string | null;
  public longMessage: string | null;
  public meta: Record<string, unknown> | null;
  public clerkTraceId: string | null;

  constructor(
    public status: number,
    public body: string,
    public headers?: Headers,
  ) {
    const parsed = parseApiBody(status, body);
    super(parsed.message);
    this.name = "ApiError";
    this.code = parsed.code;
    this.longMessage = parsed.longMessage;
    this.meta = parsed.meta;
    this.clerkTraceId = parsed.clerkTraceId;
  }
}

/**
 * Error from the Clerk Platform API (PLAPI).
 *
 * Thrown by `src/lib/plapi.ts` helpers when a Platform API request fails.
 * Displayed as "Platform API request failed" in the global error handler.
 *
 * @param status - HTTP status code
 * @param body - Raw response body text
 * @param url - The URL that was requested (shown in verbose mode)
 */
export class PlapiError extends ApiError {
  constructor(
    status: number,
    body: string,
    public url?: string,
  ) {
    super(status, body);
    this.name = "PlapiError";
  }

  static fromBody(status: number, body: string, url?: string): PlapiError {
    return new PlapiError(status, body, url);
  }

  static async fromResponse(response: Response): Promise<PlapiError> {
    const body = await response.text();
    return new PlapiError(response.status, body, response.url || undefined);
  }
}

/**
 * Error from the Clerk Frontend API (FAPI).
 *
 * Thrown by `src/lib/fapi.ts` helpers when a Frontend API request fails.
 * Displayed as "Frontend API request failed" in the global error handler when
 * wrapped with `withApiContext()`. Carries the request URL so verbose mode can
 * surface it for debugging.
 *
 * @param status - HTTP status code
 * @param body - Raw response body text
 * @param url - The request URL that failed
 */
export class FapiError extends ApiError {
  constructor(
    status: number,
    body: string,
    public url?: string,
  ) {
    super(status, body);
    this.name = "FapiError";
  }

  static fromBody(status: number, body: string, url?: string): FapiError {
    return new FapiError(status, body, url);
  }

  static async fromResponse(response: Response): Promise<FapiError> {
    const body = await response.text();
    return new FapiError(response.status, body, response.url || undefined);
  }
}

/**
 * Error from the Clerk Backend API (BAPI).
 *
 * Thrown by `src/commands/api/bapi.ts` when a Backend API request fails.
 * Displayed as "Backend API request failed" in the global error handler.
 * Unlike {@link PlapiError}, `headers` is always present (required).
 *
 * @param status - HTTP status code
 * @param body - Raw response body text
 * @param headers - Response headers (always present for BAPI responses)
 */
export class BapiError extends ApiError {
  declare headers: Headers;

  constructor(status: number, body: string, headers: Headers) {
    super(status, body, headers);
    this.name = "BapiError";
  }

  static fromBody(status: number, body: string, headers: Headers): BapiError {
    return new BapiError(status, body, headers);
  }

  static async fromResponse(response: Response): Promise<BapiError> {
    const body = await response.text();
    return new BapiError(response.status, body, response.headers);
  }
}

export function isAuthError(error: unknown): error is AuthError | ApiError {
  return (
    (error instanceof CliError && error.code === ERROR_CODE.AUTH_REQUIRED) ||
    (error instanceof ApiError && (error.status === 401 || error.status === 403))
  );
}

/**
 * Throw a usage error indicating the user provided invalid arguments or options.
 *
 * Exits with `EXIT_CODE.USAGE` (2). Use this for validation failures in
 * command option parsing, missing required values, or malformed input. Any
 * Clerk URL's will automatically have ".md" appended in agent mode to link to
 * the raw markdown version.
 *
 * @param message - Error message describing the usage problem
 * @param docsUrl - Optional URL to relevant documentation
 *
 * @example
 * ```ts
 * if (!secretKey) {
 *   usageError("No secret key found. Set CLERK_SECRET_KEY or use --secret-key.");
 * }
 * ```
 */
export function throwUsageError(message: string, docsUrl?: string, code?: ErrorCode): never {
  throw new CliError(message, {
    code: code ?? ERROR_CODE.USAGE_ERROR,
    exitCode: EXIT_CODE.USAGE,
    docsUrl,
  });
}

/**
 * Signal that the user cancelled an interactive prompt.
 *
 * Call this when the user declines a confirmation dialog or exits a picker.
 * The global error handler exits cleanly with no error output.
 *
 * @example
 * ```ts
 * const confirmed = await confirm({ message: "Proceed?" });
 * if (!confirmed) userAbort();
 * ```
 */
export function throwUserAbort(): never {
  throw new UserAbortError();
}

/**
 * Wrap a promise so that any {@link ApiError} it rejects with gets a
 * human-readable `context` string attached before re-throwing.
 *
 * @example
 * ```ts
 * const config = await withApiContext(
 *   fetchInstanceConfig(appId, instanceId),
 *   "Failed to fetch config",
 * );
 * ```
 */
export function withApiContext<T>(promise: Promise<T>, context: string): Promise<T> {
  return promise.catch((error) => {
    if (error instanceof ApiError) {
      error.context = context;
    }
    throw error;
  });
}

/** Normalize an unknown thrown value to a string message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

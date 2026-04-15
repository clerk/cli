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
  /** Input is not valid JSON or not an object. */
  INVALID_JSON: "invalid_json",
  /** Failed to fetch or parse the OpenAPI catalog. */
  CATALOG_ERROR: "catalog_error",
  /** Doctor checks found issues. */
  DOCTOR_FAILED: "doctor_failed",
  /** Autoclaim of a keyless application failed. */
  AUTOCLAIM_FAILED: "autoclaim_failed",
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

interface CliErrorOptions {
  /** Machine-readable error code for programmatic consumption. */
  code?: ErrorCode;
  /** Process exit code. Defaults to {@link EXIT_CODE.GENERAL}. */
  exitCode?: ExitCode;
  /** URL to relevant documentation, printed after the error message. */
  docsUrl?: string;
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

  constructor(
    public status: number,
    public body: string,
    public headers?: Headers,
  ) {
    super(`API error (${status}): ${body}`);
    this.name = "ApiError";
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

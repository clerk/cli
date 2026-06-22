import type { Program } from "../../cli-program.ts";
import { getAuthToken } from "../../lib/plapi.ts";
import { getBapiBaseUrl, getPlapiBaseUrl } from "../../lib/environment.ts";
import { normalizeBapiPath, resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { type ApiResponse } from "../../lib/fetch.ts";
import { bapiRequest } from "../../lib/bapi.ts";
import { fapiRequest } from "../../lib/fapi.ts";
import { resolveFapiHost } from "./fapi.ts";
import {
  ApiError,
  ERROR_CODE,
  UserAbortError,
  isPromptExitError,
  throwUsageError,
  throwUserAbort,
} from "../../lib/errors.ts";
import { isHuman } from "../../mode.ts";
import { confirm } from "../../lib/prompts.ts";
import { withSpinner, intro, outro, pausedOutro } from "../../lib/spinner.ts";
import { isInsideGutter, log } from "../../lib/log.ts";

export interface ApiOptions {
  method?: string;
  data?: string;
  file?: string;
  include?: boolean;
  app?: string;
  secretKey?: string;
  instance?: string;
  platform?: boolean;
  fapi?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type RunRequest = (req: { method: string; path: string; body?: string }) => Promise<ApiResponse>;

/** Validate fapi flag combinations and emit warnings for ignored flags. */
function validateFapiOptions(options: ApiOptions): void {
  if (options.platform) {
    throwUsageError("--fapi and --platform cannot be combined.", undefined, ERROR_CODE.USAGE_ERROR);
  }
  if (options.secretKey) {
    log.warn("--secret-key is ignored when --fapi is set.");
  }
}

/** Resolve the API surface (base URL + request executor) from the flags. */
async function resolveApiTarget(
  options: ApiOptions,
): Promise<{ baseUrl: string; runRequest: RunRequest }> {
  if (options.fapi) {
    const fapiHost = await resolveFapiHost(options);
    const baseUrl = `https://${fapiHost}`;
    return { baseUrl, runRequest: (req) => fapiRequest({ ...req, fapiHost }) };
  }

  if (options.platform) {
    const secretKey = await getAuthToken();
    const baseUrl = getPlapiBaseUrl();
    return { baseUrl, runRequest: (req) => bapiRequest({ ...req, secretKey, baseUrl }) };
  }

  const secretKey = await resolveBapiSecretKey(options);
  const baseUrl = getBapiBaseUrl();
  return { baseUrl, runRequest: (req) => bapiRequest({ ...req, secretKey, baseUrl }) };
}

export async function api(
  endpoint: string | undefined,
  filter: string | undefined,
  options: ApiOptions,
): Promise<void> {
  const nested = isInsideGutter();
  if (!nested) intro("Calling Clerk API");
  let closeStatus: "success" | "failed" | "paused" | undefined;

  try {
    // Route: no args → interactive builder
    if (!endpoint) {
      const { apiInteractive } = await import("./interactive.ts");
      await apiInteractive(options);
      return;
    }

    // Route: "ls" → list endpoints
    if (endpoint === "ls") {
      const { apiLs } = await import("./ls.ts");
      await apiLs(filter, options);
      return;
    }

    // 1. Resolve the request body
    const body = await resolveBody(options);

    // 2. Determine HTTP method
    const method = (options.method ?? (body ? "POST" : "GET")).toUpperCase();

    // 3. Dry run — for --fapi, skip host resolution to avoid a real Platform API round-trip
    if (options.dryRun) {
      if (options.fapi) {
        validateFapiOptions(options);
        log.info(`[dry-run] ${method} <fapi-host>${normalizeBapiPath(endpoint)}`);
      } else {
        const { baseUrl } = await resolveApiTarget(options);
        log.info(`[dry-run] ${method} ${baseUrl}${normalizeBapiPath(endpoint)}`);
      }
      if (body) {
        prettyPrint(body);
      }
      return;
    }

    // 4. Resolve the request target (base URL + executor)
    if (options.fapi) {
      validateFapiOptions(options);
    }
    const { runRequest } = await resolveApiTarget(options);

    // 5. Confirmation for mutating methods
    if (MUTATING_METHODS.has(method) && isHuman() && !options.yes) {
      log.info(`\nAbout to ${method} ${endpoint}`);
      if (body) {
        prettyPrintToStderr(body);
      }
      const ok = await confirm({ message: "Proceed?" });
      if (!ok) {
        throwUserAbort();
      }
    }

    // 6. Execute request
    try {
      const response = await withSpinner("Executing request...", () =>
        runRequest({ method, path: endpoint, body: body ?? undefined }),
      );

      if (options.include) {
        printHeaders(response.status, response.headers);
      }
      printBody(response.body);
      closeStatus = "success";
    } catch (error) {
      // Handle API errors locally to print the raw response body to stdout
      // (for piping), rather than propagating to the global error handler.
      if (error instanceof ApiError) {
        if (options.include && error.headers) {
          printHeaders(error.status, error.headers);
        }
        prettyPrint(error.body);
        process.exitCode = 1;
        closeStatus = "failed";
        return;
      }
      throw error;
    }
  } catch (error) {
    closeStatus = error instanceof UserAbortError || isPromptExitError(error) ? "paused" : "failed";
    throw error;
  } finally {
    if (!nested) {
      if (closeStatus === "paused") {
        pausedOutro();
      } else if (closeStatus === "failed") {
        outro("Failed");
      } else {
        outro();
      }
    }
  }
}

async function resolveBody(options: { data?: string; file?: string }): Promise<string | null> {
  if (options.data) return options.data;

  if (options.file) {
    const file = Bun.file(options.file);
    if (!(await file.exists())) {
      throwUsageError(`File not found: ${options.file}`, undefined, ERROR_CODE.FILE_NOT_FOUND);
    }
    return file.text();
  }

  // Read from stdin if piped
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf-8").trim();
    if (text) return text;
  }

  return null;
}

function printHeaders(status: number, headers: Headers): void {
  log.raw(`HTTP ${status}`);
  headers.forEach((value, key) => {
    log.raw(`${key}: ${value}`);
  });
  log.blank();
}

function printBody(body: unknown): void {
  if (typeof body === "string") {
    log.data(body);
  } else {
    log.data(JSON.stringify(body, null, 2));
  }
}

/** Pretty-print a string as JSON to stdout if possible, otherwise print raw. */
function prettyPrint(text: string): void {
  try {
    log.data(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    log.data(text);
  }
}

/** Pretty-print a string as JSON to stderr if possible, otherwise print raw. */
function prettyPrintToStderr(text: string): void {
  try {
    log.raw(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    log.raw(text);
  }
}

export function registerApi(program: Program): void {
  program
    .command("api")
    .description("Make authenticated requests to the Clerk API")
    .argument(
      "[endpoint]",
      "API endpoint path, 'ls' to list endpoints, or omit for interactive mode",
    )
    .argument("[filter]", "Filter keyword (used with 'ls')")
    .option("-X, --method <method>", "HTTP method (default: GET, or POST if body provided)")
    .option("-d, --data <json>", "JSON request body")
    .option("--file <path>", "Read request body from a file")
    .option("--include", "Show response headers")
    .option("--app <id>", "Application ID to target when resolving keys")
    .option("--secret-key <key>", "Override the secret key")
    .option("--instance <id>", "Instance to target (dev, prod, or instance ID)")
    .option("--platform", "Use Platform API instead of Backend API")
    .option(
      "--fapi",
      "Use the instance's public Frontend API (unauthenticated endpoints only; host derived from the publishable key)",
    )
    .option("--dry-run", "Show the request without executing it")
    .option("--yes", "Skip confirmation for mutating requests")
    .setExamples([
      { command: "clerk api ls", description: "List all available endpoints" },
      { command: "clerk api ls users", description: 'List endpoints matching "users"' },
      { command: "clerk api /users", description: "GET /v1/users" },
      {
        command: 'clerk api /users -d \'{"first_name":"Alice"}\'',
        description: "POST with a JSON body",
      },
      {
        command: "clerk api --fapi /environment --app <id> --instance dev",
        description: "GET the public FAPI environment payload",
      },
    ])
    .action(api);
}

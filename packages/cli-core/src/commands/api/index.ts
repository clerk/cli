import type { Command } from "@commander-js/extra-typings";
import { getAuthToken } from "../../lib/plapi.ts";
import { getBapiBaseUrl, getPlapiBaseUrl } from "../../lib/environment.ts";
import { normalizeBapiPath, resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { bapiRequest } from "./bapi.ts";
import {
  BapiError,
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
  dryRun?: boolean;
  yes?: boolean;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

    // 3. Resolve authentication
    let secretKey: string;
    let baseUrl: string;

    if (options.platform) {
      secretKey = await getAuthToken();
      baseUrl = getPlapiBaseUrl();
    } else {
      secretKey = await resolveBapiSecretKey(options);
      baseUrl = getBapiBaseUrl();
    }

    // 4. Dry run
    if (options.dryRun) {
      log.info(`[dry-run] ${method} ${baseUrl}${normalizeBapiPath(endpoint)}`);
      if (body) {
        prettyPrint(body);
      }
      return;
    }

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
        bapiRequest({
          method,
          path: endpoint,
          secretKey,
          body: body ?? undefined,
          baseUrl,
        }),
      );

      if (options.include) {
        printHeaders(response.status, response.headers);
      }
      printBody(response.body);
      closeStatus = "success";
    } catch (error) {
      // Handle BapiError locally to print the raw API response body to stdout
      // (for piping), rather than propagating to the global error handler.
      if (error instanceof BapiError) {
        if (options.include) {
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

export function registerApi(program: Command): void {
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
    ])
    .action(api);
}

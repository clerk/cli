import { getAuthToken } from "../../lib/plapi.ts";
import { getBapiBaseUrl, getPlapiBaseUrl } from "../../lib/environment.ts";
import { normalizeBapiPath, resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { bapiRequest } from "./bapi.ts";
import { BapiError, ERROR_CODE, throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import { isHuman } from "../../mode.ts";
import { confirm } from "../../lib/prompts.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

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
  // Route: no args → interactive builder
  if (!endpoint) {
    const { apiInteractive } = await import("./interactive.ts");
    return apiInteractive(options);
  }

  // Route: "ls" → list endpoints
  if (endpoint === "ls") {
    const { apiLs } = await import("./ls.ts");
    return apiLs(filter, options);
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
  } catch (error) {
    // Handle BapiError locally to print the raw API response body to stdout
    // (for piping), rather than propagating to the global error handler.
    if (error instanceof BapiError) {
      if (options.include) {
        printHeaders(error.status, error.headers);
      }
      prettyPrint(error.body);
      process.exitCode = 1;
      return;
    }
    throw error;
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

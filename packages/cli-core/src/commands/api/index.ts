import type { Need } from "../../lib/deps.ts";
import type { ApiLsDeps } from "./ls.ts";
import type { ApiInteractiveDeps } from "./interactive.ts";
import {
  BapiError,
  CliError,
  ERROR_CODE,
  throwUsageError,
  throwUserAbort,
  withApiContext,
} from "../../lib/errors.ts";

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

/**
 * Slice for the `clerk api` command itself (i.e. the `clerk api <endpoint>`
 * execution path, not the ls/interactive dispatch branches).
 */
export type ApiDeps = Need<{
  bapi: "bapiRequest";
  plapi: "validateKeyPrefix" | "getAuthToken" | "fetchApplication";
  configStore: "resolveAppContext";
  environment: "getBapiBaseUrl" | "getPlapiBaseUrl";
  mode: "isHuman";
  prompts: "confirm";
  spinner: "withSpinner";
  env: "get";
  log: "info" | "data";
}>;

/**
 * The top-level `api` command dispatches to `apiLs` or `apiInteractive`
 * depending on its arguments, so its combined slice is the union of every
 * downstream slice.
 */
export type ApiCommandDeps = ApiDeps & ApiLsDeps & ApiInteractiveDeps;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function api(
  deps: ApiCommandDeps,
  endpoint: string | undefined,
  filter: string | undefined,
  options: ApiOptions,
): Promise<void> {
  // Route: no args → interactive builder
  if (!endpoint) {
    const { apiInteractive } = await import("./interactive.ts");
    return apiInteractive(deps, options);
  }

  // Route: "ls" → list endpoints
  if (endpoint === "ls") {
    const { apiLs } = await import("./ls.ts");
    return apiLs(deps, filter, options);
  }

  // 1. Resolve the request body
  const body = await resolveBody(options);

  // 2. Determine HTTP method
  const method = (options.method ?? (body ? "POST" : "GET")).toUpperCase();

  // 3. Resolve authentication
  let secretKey: string;
  let baseUrl: string;

  if (options.platform) {
    secretKey = await deps.plapi.getAuthToken();
    baseUrl = deps.environment.getPlapiBaseUrl();
  } else {
    secretKey = await resolveSecretKey(deps, options);
    baseUrl = deps.environment.getBapiBaseUrl();
  }

  // 4. Dry run
  if (options.dryRun) {
    deps.log.info(`[dry-run] ${method} ${baseUrl}${normalizePath(endpoint)}`);
    if (body) {
      prettyPrint(deps, body);
    }
    return;
  }

  // 5. Confirmation for mutating methods
  if (MUTATING_METHODS.has(method) && deps.mode.isHuman() && !options.yes) {
    deps.log.info(`\nAbout to ${method} ${endpoint}`);
    if (body) {
      prettyPrintToStderr(deps, body);
    }
    const ok = await deps.prompts.confirm({ message: "Proceed?" });
    if (!ok) {
      throwUserAbort();
    }
  }

  // 6. Execute request
  try {
    const response = await deps.spinner.withSpinner("Executing request...", () =>
      deps.bapi.bapiRequest({
        method,
        path: endpoint,
        secretKey,
        body: body ?? undefined,
        baseUrl,
      }),
    );

    if (options.include) {
      printHeaders(deps, response.status, response.headers);
    }
    printBody(deps, response.body);
  } catch (error) {
    // Handle BapiError locally to print the raw API response body to stdout
    // (for piping), rather than propagating to the global error handler.
    if (error instanceof BapiError) {
      if (options.include) {
        printHeaders(deps, error.status, error.headers);
      }
      prettyPrint(deps, error.body);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

type ResolveSecretKeyDeps = Need<{
  plapi: "validateKeyPrefix" | "fetchApplication";
  configStore: "resolveAppContext";
  env: "get";
}>;

async function resolveSecretKey(deps: ResolveSecretKeyDeps, options: ApiOptions): Promise<string> {
  if (options.secretKey) {
    deps.plapi.validateKeyPrefix(options.secretKey, "sk_");
    return options.secretKey;
  }

  const envKey = deps.env.get("CLERK_SECRET_KEY");
  if (envKey) {
    deps.plapi.validateKeyPrefix(envKey, "sk_");
    return envKey;
  }

  // Resolve from linked profile via Platform API
  let ctx: Awaited<ReturnType<ResolveSecretKeyDeps["configStore"]["resolveAppContext"]>>;
  try {
    ctx = await deps.configStore.resolveAppContext({
      app: options.app,
      instance: options.instance,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("No Clerk project linked")) {
      throwUsageError(
        "No secret key found. Provide one via:\n" +
          "  --secret-key <key>\n" +
          "  CLERK_SECRET_KEY environment variable\n" +
          "  Link a project with `clerk link`, or pass --app <app_id>",
        "https://clerk.com/docs/guides/development/clerk-environment-variables",
        ERROR_CODE.NO_SECRET_KEY,
      );
    }
    throw error;
  }

  const app = await withApiContext(
    deps.plapi.fetchApplication(ctx.appId),
    "Failed to resolve secret key",
  );
  const matched = app.instances.find((i) => i.instance_id === ctx.instanceId);
  if (!matched) {
    throw new CliError(`Instance ${ctx.instanceId} not found in application.`, {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
      docsUrl: "https://clerk.com/docs/guides/development/managing-environments",
    });
  }
  if (!matched.secret_key) {
    throw new CliError(`No secret key found for ${ctx.instanceLabel} instance.`, {
      code: ERROR_CODE.NO_SECRET_KEY,
      docsUrl: "https://clerk.com/docs/guides/development/clerk-environment-variables",
    });
  }
  return matched.secret_key;
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

function normalizePath(path: string): string {
  let p = path;
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.startsWith("/v1/")) p = `/v1${p}`;
  return p;
}

function printHeaders(deps: Need<{ log: "info" }>, status: number, headers: Headers): void {
  deps.log.info(`HTTP ${status}`);
  headers.forEach((value, key) => {
    deps.log.info(`${key}: ${value}`);
  });
  deps.log.info("");
}

function printBody(deps: Need<{ log: "data" }>, body: unknown): void {
  if (typeof body === "string") {
    deps.log.data(body);
  } else {
    deps.log.data(JSON.stringify(body, null, 2));
  }
}

/** Pretty-print a string as JSON to stdout if possible, otherwise print raw. */
function prettyPrint(deps: Need<{ log: "data" }>, text: string): void {
  try {
    deps.log.data(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    deps.log.data(text);
  }
}

/** Pretty-print a string as JSON to stderr if possible, otherwise print raw. */
function prettyPrintToStderr(deps: Need<{ log: "info" }>, text: string): void {
  try {
    deps.log.info(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    deps.log.info(text);
  }
}

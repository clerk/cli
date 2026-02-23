import { confirm } from "@inquirer/prompts";
import { resolveProfile, resolveInstanceId } from "../../lib/config.ts";
import { fetchApplication, PlapiError } from "../../lib/plapi.ts";
import { BAPI_BASE_URL, PLAPI_BASE_URL } from "../../lib/constants.ts";
import { bapiRequest, BapiError } from "./bapi.ts";
import { isHuman } from "../../mode.ts";

export interface ApiOptions {
  method?: string;
  data?: string;
  file?: string;
  include?: boolean;
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
    const key = process.env.CLERK_PLATFORM_API_KEY;
    if (!key) {
      console.error("CLERK_PLATFORM_API_KEY environment variable is required for --platform mode.");
      process.exit(1);
    }
    secretKey = key;
    baseUrl = PLAPI_BASE_URL;
  } else {
    secretKey = await resolveSecretKey(options);
    baseUrl = BAPI_BASE_URL;
  }

  // 4. Dry run
  if (options.dryRun) {
    console.error(`[dry-run] ${method} ${baseUrl}${normalizePath(endpoint)}`);
    if (body) {
      prettyPrint(body);
    }
    return;
  }

  // 5. Confirmation for mutating methods
  if (MUTATING_METHODS.has(method) && isHuman() && !options.yes) {
    console.error(`\nAbout to ${method} ${endpoint}`);
    if (body) {
      prettyPrintToStderr(body);
    }
    const ok = await confirm({ message: "Proceed?" });
    if (!ok) {
      console.error("Aborted.");
      process.exit(0);
    }
  }

  // 6. Execute request
  try {
    const response = await bapiRequest({
      method,
      path: endpoint,
      secretKey,
      body: body ?? undefined,
      baseUrl,
    });

    if (options.include) {
      printHeaders(response.status, response.headers);
    }
    printBody(response.body);
  } catch (error) {
    if (error instanceof BapiError) {
      if (options.include) {
        printHeaders(error.status, error.headers);
      }
      prettyPrint(error.body);
      process.exit(1);
    }
    if (error instanceof Error) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function resolveSecretKey(options: ApiOptions): Promise<string> {
  if (options.secretKey) return options.secretKey;

  if (process.env.CLERK_SECRET_KEY) return process.env.CLERK_SECRET_KEY;

  // Resolve from linked profile via Platform API
  const resolved = await resolveProfile(process.cwd());
  if (!resolved) {
    console.error(
      "No secret key found. Provide one via:\n" +
      "  --secret-key <key>\n" +
      "  CLERK_SECRET_KEY environment variable\n" +
      "  Link a project with `clerk init` and set CLERK_PLATFORM_API_KEY",
    );
    process.exit(1);
  }

  const { profile } = resolved;
  const platformKey = process.env.CLERK_PLATFORM_API_KEY;
  if (!platformKey) {
    console.error(
      "No secret key found. Provide one via:\n" +
      "  --secret-key <key>\n" +
      "  CLERK_SECRET_KEY environment variable\n" +
      "  Set CLERK_PLATFORM_API_KEY to auto-resolve from your linked project",
    );
    process.exit(1);
  }

  let instance: { id: string; label: string };
  try {
    instance = resolveInstanceId(profile, options.instance);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }

  try {
    const app = await fetchApplication(profile.appId);
    const matched = app.instances.find((i) => i.instance_id === instance.id);
    if (!matched) {
      console.error(`Instance ${instance.id} not found in application.`);
      process.exit(1);
    }
    return matched.secret_key;
  } catch (error) {
    if (error instanceof PlapiError) {
      console.error(`Failed to resolve secret key: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

async function resolveBody(options: { data?: string; file?: string }): Promise<string | null> {
  if (options.data) return options.data;

  if (options.file) {
    const file = Bun.file(options.file);
    if (!(await file.exists())) {
      console.error(`File not found: ${options.file}`);
      process.exit(1);
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

function printHeaders(status: number, headers: Headers): void {
  console.error(`HTTP ${status}`);
  headers.forEach((value, key) => {
    console.error(`${key}: ${value}`);
  });
  console.error("");
}

function printBody(body: unknown): void {
  if (typeof body === "string") {
    console.log(body);
  } else {
    console.log(JSON.stringify(body, null, 2));
  }
}

/** Pretty-print a string as JSON to stdout if possible, otherwise print raw. */
function prettyPrint(text: string): void {
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

/** Pretty-print a string as JSON to stderr if possible, otherwise print raw. */
function prettyPrintToStderr(text: string): void {
  try {
    console.error(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.error(text);
  }
}

import { join } from "node:path";
import {
  resolveAppContext,
  resolveFetchedApplicationInstance,
  resolveProfile,
  getActiveInstanceForApp,
} from "./config.ts";
import { parseEnvFile } from "./dotenv.ts";
import { BapiError, CliError, ERROR_CODE, throwUsageError, withApiContext } from "./errors.ts";
import { log } from "./log.ts";
import { fetchApplication, validateKeyPrefix } from "./plapi.ts";

export function normalizeBapiPath(path: string): string {
  let normalized = path;
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (!/^\/v1(?:\/|$)/.test(normalized)) normalized = `/v1${normalized}`;
  return normalized;
}

interface ResolveBapiSecretKeyOptions {
  app?: string;
  instance?: string;
  branch?: string;
  secretKey?: string;
  cwd?: string;
}

export async function describeBapiTarget(
  options: ResolveBapiSecretKeyOptions,
): Promise<string | undefined> {
  try {
    const ctx = await resolveAppContext({
      app: options.app,
      instance: options.instance,
      branch: options.branch,
    });
    return `${ctx.appLabel} (${ctx.instanceLabel})`;
  } catch (error) {
    if (
      error instanceof CliError &&
      error.code === ERROR_CODE.NOT_LINKED &&
      (options.secretKey || process.env.CLERK_SECRET_KEY)
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Where a resolved BAPI secret key came from.
 */
export type BapiKeySource =
  | "explicit" // --secret-key flag
  | "env" // ambient CLERK_SECRET_KEY
  | "env-file" // ambient CLERK_SECRET_KEY that matches the pointer-synced env file
  | "app-flag" // --app resolution
  | "flag" // --instance/--branch on the linked profile
  | "active-pointer" // persisted `clerk switch` pointer
  | "default"; // development fallback

/**
 * Resolved Backend API credential and its instance attribution.
 */
export interface BapiTarget {
  secretKey: string;
  instanceLabel?: string;
  source: BapiKeySource;
}

// The global error handler (cli-program.ts) has no channel back to the call
// site that resolved the key, so record the last resolution here. The CLI runs
// exactly one command per process, so a module-level slot cannot be clobbered
// by concurrent commands.
let lastKeySource: { source: BapiKeySource; instanceLabel?: string } | undefined;

/**
 * Return the most recent BAPI key-source attribution for global error hints.
 */
export function getLastBapiKeySource():
  | { source: BapiKeySource; instanceLabel?: string }
  | undefined {
  return lastKeySource;
}

/**
 * Clear the recorded BAPI key-source attribution between tests.
 */
export function resetLastBapiKeySource(): void {
  lastKeySource = undefined;
}

// Env files that can put CLERK_SECRET_KEY into the ambient environment
// (Bun's autoload and dotenv tooling like direnv read these), highest
// precedence first, matching `env pull`'s target-file preference.
const ENV_FILE_CANDIDATES = [".env.development.local", ".env.local", ".env"];

/**
 * Attribute an ambient CLERK_SECRET_KEY to the worktree's active instance.
 *
 * The env var outranks the persisted pointer for auth (documented precedence),
 * which goes blind when the var was merely auto-loaded from the env file that
 * `clerk switch` itself keeps in sync. If the ambient key matches the
 * CLERK_SECRET_KEY stored in the project's env file and an active pointer
 * exists, the key provably came from the pointer's instance: return its label
 * so output can say so. Local file reads only, no network.
 */
async function attributeEnvKeyToActivePointer(
  ambientKey: string,
  cwd: string,
): Promise<string | undefined> {
  const resolved = await resolveProfile(cwd);
  if (!resolved) return undefined;
  const active = await getActiveInstanceForApp(cwd, resolved.profile.appId);
  if (!active) return undefined;

  for (const candidate of ENV_FILE_CANDIDATES) {
    const file = Bun.file(join(cwd, candidate));
    if (!(await file.exists())) continue;
    const entry = parseEnvFile(await file.text()).find(
      (line) => line.type === "entry" && line.key === "CLERK_SECRET_KEY",
    );
    if (!entry || entry.type !== "entry") continue;
    // First file that defines the var decides: a match attributes the key to
    // the pointer; a mismatch (e.g. `switch --no-pull` moved the pointer but
    // not the file) means the ambient key is NOT the pointer's, so stay silent.
    return entry.value === ambientKey ? active.label : undefined;
  }
  return undefined;
}

/**
 * Resolve a Backend API secret key together with its instance attribution.
 */
export async function resolveBapiTarget(options: ResolveBapiSecretKeyOptions): Promise<BapiTarget> {
  const record = (target: BapiTarget): BapiTarget => {
    lastKeySource = { source: target.source, instanceLabel: target.instanceLabel };
    return target;
  };

  if (options.branch && options.instance) {
    throwUsageError("Cannot combine --branch and --instance. Pass only one to select an instance.");
  }
  if (options.branch && options.secretKey) {
    throwUsageError(
      "Cannot combine --branch and --secret-key. A secret key already targets a specific instance.",
    );
  }

  if (options.secretKey) {
    validateKeyPrefix(options.secretKey, "sk_");
    return record({ secretKey: options.secretKey, source: "explicit" });
  }

  if (options.app) {
    const app = await withApiContext(fetchApplication(options.app), "Failed to resolve secret key");
    const resolved = resolveFetchedApplicationInstance(
      options.app,
      app,
      options.instance,
      options.branch,
    );
    if (!resolved.found) {
      throw new CliError(`Instance ${resolved.instanceId} not found in application.`, {
        code: ERROR_CODE.INSTANCE_NOT_FOUND,
        docsUrl: "https://clerk.com/docs/guides/development/managing-environments",
      });
    }
    if (!resolved.instance.secret_key) {
      throw new CliError(`No secret key found for ${resolved.instanceLabel} instance.`, {
        code: ERROR_CODE.NO_SECRET_KEY,
        docsUrl: "https://clerk.com/docs/guides/development/clerk-environment-variables",
      });
    }
    return record({
      secretKey: resolved.instance.secret_key,
      instanceLabel: resolved.instanceLabel,
      source: "app-flag",
    });
  }

  if (process.env.CLERK_SECRET_KEY && !options.instance && !options.branch) {
    validateKeyPrefix(process.env.CLERK_SECRET_KEY, "sk_");
    const pointerLabel = await attributeEnvKeyToActivePointer(
      process.env.CLERK_SECRET_KEY,
      options.cwd ?? process.cwd(),
    );
    if (pointerLabel) {
      return record({
        secretKey: process.env.CLERK_SECRET_KEY,
        instanceLabel: pointerLabel,
        source: "env-file",
      });
    }
    return record({ secretKey: process.env.CLERK_SECRET_KEY, source: "env" });
  }

  let ctx: Awaited<ReturnType<typeof resolveAppContext>>;
  try {
    ctx = await resolveAppContext({
      app: options.app,
      instance: options.instance,
      branch: options.branch,
    });
  } catch (error) {
    if (error instanceof CliError && error.code === ERROR_CODE.NOT_LINKED) {
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

  const app = await withApiContext(fetchApplication(ctx.appId), "Failed to resolve secret key");
  const instance = app.instances.find((entry) => entry.instance_id === ctx.instanceId);
  if (!instance) {
    // A missing instance behind the active pointer usually means the branch
    // was deleted from another checkout; name the recovery command.
    const staleHint =
      ctx.instanceSource === "active-pointer"
        ? ` The active instance \`${ctx.instanceLabel}\` for this worktree may have been deleted. ` +
          "Run `clerk switch` to re-point, then retry."
        : "";
    throw new CliError(`Instance ${ctx.instanceId} not found in application.${staleHint}`, {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
      docsUrl: "https://clerk.com/docs/guides/development/managing-environments",
    });
  }
  if (!instance.secret_key) {
    throw new CliError(`No secret key found for ${ctx.instanceLabel} instance.`, {
      code: ERROR_CODE.NO_SECRET_KEY,
      docsUrl: "https://clerk.com/docs/guides/development/clerk-environment-variables",
    });
  }
  return record({
    secretKey: instance.secret_key,
    instanceLabel: ctx.instanceLabel,
    source: ctx.instanceSource,
  });
}

/**
 * Resolve the Backend API secret key for a command target.
 */
export async function resolveBapiSecretKey(options: ResolveBapiSecretKeyOptions): Promise<string> {
  return (await resolveBapiTarget(options)).secretKey;
}

export function handleBapiError(error: unknown): boolean {
  if (!(error instanceof BapiError)) {
    return false;
  }

  try {
    log.data(JSON.stringify(JSON.parse(error.body), null, 2));
  } catch {
    log.data(error.body);
  }

  process.exitCode = 1;
  return true;
}

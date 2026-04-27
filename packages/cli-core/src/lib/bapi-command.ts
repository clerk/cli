import { resolveAppContext, resolveFetchedApplicationInstance } from "./config.ts";
import { BapiError, CliError, ERROR_CODE, throwUsageError, withApiContext } from "./errors.ts";
import { log } from "./log.ts";
import { fetchApplication, validateKeyPrefix } from "./plapi.ts";

export function normalizeBapiPath(path: string): string {
  let normalized = path;
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (!normalized.startsWith("/v1/")) normalized = `/v1${normalized}`;
  return normalized;
}

interface ResolveBapiSecretKeyOptions {
  app?: string;
  instance?: string;
  secretKey?: string;
}

export async function describeBapiTarget(
  options: ResolveBapiSecretKeyOptions,
): Promise<string | undefined> {
  try {
    const ctx = await resolveAppContext({ app: options.app, instance: options.instance });
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

export async function resolveBapiSecretKey(options: ResolveBapiSecretKeyOptions): Promise<string> {
  if (options.secretKey) {
    validateKeyPrefix(options.secretKey, "sk_");
    return options.secretKey;
  }

  if (options.app) {
    const app = await withApiContext(fetchApplication(options.app), "Failed to resolve secret key");
    const resolved = resolveFetchedApplicationInstance(options.app, app, options.instance);
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
    return resolved.instance.secret_key;
  }

  if (process.env.CLERK_SECRET_KEY) {
    validateKeyPrefix(process.env.CLERK_SECRET_KEY, "sk_");
    return process.env.CLERK_SECRET_KEY;
  }

  let ctx: Awaited<ReturnType<typeof resolveAppContext>>;
  try {
    ctx = await resolveAppContext({ app: options.app, instance: options.instance });
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
    throw new CliError(`Instance ${ctx.instanceId} not found in application.`, {
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
  return instance.secret_key;
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

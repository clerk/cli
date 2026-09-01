import { resolveAppContext, resolveFetchedApplicationInstance } from "./config.ts";
import { BapiError, CliError, ERROR_CODE, throwUsageError, withApiContext } from "./errors.ts";
import { resolveKeylessTarget } from "./keyless-target.ts";
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
  secretKey?: string;
  cwd?: string;
}

export async function describeBapiTarget(
  options: ResolveBapiSecretKeyOptions,
): Promise<string | undefined> {
  // An explicit --secret-key wins in resolveBapiSecretKey, so it has no
  // app/instance context to describe.
  if (options.secretKey) return undefined;

  // Mirrors resolveBapiSecretKey's precedence: an unclaimed keyless project has
  // no app/instance to describe, only the key's own source.
  const keyless = await resolveKeylessTarget({
    app: options.app,
    instance: options.instance,
    cwd: options.cwd,
  });
  if (keyless) {
    return `this accountless application (secret key from ${keyless.source})`;
  }

  try {
    const ctx = await resolveAppContext({
      app: options.app,
      instance: options.instance,
      cwd: options.cwd,
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

  // An explicitly exported CLERK_SECRET_KEY wins over everything below,
  // including a linked profile — same precedence this command family has
  // always had. Routing it through resolveKeylessTarget instead would lose
  // both halves of that contract: the keyless resolver stands down entirely
  // when the directory is linked, and refuses --instance, which has always
  // been a no-op next to an env key that addresses exactly one instance.
  const envSecretKey = process.env.CLERK_SECRET_KEY;
  if (envSecretKey) {
    validateKeyPrefix(envSecretKey, "sk_");
    return envSecretKey;
  }

  // An unclaimed keyless application keeps its only secret key on disk
  // (.env.local, or the SDK's own keyless.json) — the same resolution `whoami`,
  // `config`, and `env pull` already share. The shipped binary is compiled with
  // --no-compile-autoload-dotenv, so without this every `users`/`api` command
  // would report "no secret key" on a perfectly live keyless project the moment
  // it wasn't run via `bun run` (which autoloads .env.local for us in dev).
  const keyless = await resolveKeylessTarget({ instance: options.instance, cwd: options.cwd });
  if (keyless) {
    return keyless.secretKey;
  }

  let ctx: Awaited<ReturnType<typeof resolveAppContext>>;
  try {
    ctx = await resolveAppContext({
      app: options.app,
      instance: options.instance,
      cwd: options.cwd,
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

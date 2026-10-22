import { resolveAppContext, resolveFetchedApplicationInstance } from "./config.ts";
import { BapiError, CliError, ERROR_CODE, throwUsageError, withApiContext } from "./errors.ts";
import { resolveKeylessTargetAndRead, type KeylessTarget } from "./keyless-target.ts";
import type { FolderRead } from "./local-keys.ts";
import { log } from "./log.ts";
import { keylessAppLabel, readUnlinkedFolder } from "./unlinked-folder.ts";
import { fetchApplication, validateKeyPrefix } from "./plapi.ts";
import { declareSoftExitError } from "./telemetry.ts";

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

/**
 * Where a Backend API call's secret key comes from: the first of these that
 * applies. `resolveBapiSecretKey` and `describeBapiTarget` both choose here,
 * so a dry run never names a different app than the run uses.
 */
type BapiKeySource =
  | { kind: "flag"; secretKey: string }
  | { kind: "app"; app: string }
  | { kind: "exported"; secretKey: string }
  | { kind: "folder"; keyless: KeylessTarget; read: FolderRead }
  | { kind: "profile" };

async function chooseBapiKeySource(options: ResolveBapiSecretKeyOptions): Promise<BapiKeySource> {
  if (options.secretKey) return { kind: "flag", secretKey: options.secretKey };
  if (options.app) return { kind: "app", app: options.app };

  // An exported CLERK_SECRET_KEY wins over everything below, a linked profile
  // included. Routed through resolveKeylessTarget, it would stand down in a
  // linked directory and refuse --instance, which has always been a no-op next
  // to a key that addresses exactly one instance.
  const exported = process.env.CLERK_SECRET_KEY;
  if (exported) return { kind: "exported", secretKey: exported };

  // An unlinked folder's own secret key, read as `clerk link` and every
  // accountless command read it (`readFolderKeys`). The shipped binary is
  // compiled with --no-compile-autoload-dotenv, so without this every
  // `users`/`api` command would report "no secret key" on a live keyless
  // project the moment it wasn't run via `bun run`.
  const found = await resolveKeylessTargetAndRead({
    instance: options.instance,
    cwd: options.cwd,
  });
  if (found) return { kind: "folder", keyless: found.target, read: found.read };

  return { kind: "profile" };
}

export async function describeBapiTarget(
  options: ResolveBapiSecretKeyOptions,
): Promise<string | undefined> {
  const source = await chooseBapiKeySource(options);
  switch (source.kind) {
    // The key alone may belong to any app, so there's none to name.
    case "flag":
    case "exported":
      return undefined;
    case "folder":
      return keylessAppLabel(
        await readUnlinkedFolder(options.cwd ?? process.cwd(), source.read),
        source.keyless.source,
      );
    case "app":
    case "profile": {
      const ctx = await resolveAppContext({
        app: options.app,
        instance: options.instance,
        cwd: options.cwd,
      });
      return `${ctx.appLabel} (${ctx.instanceLabel})`;
    }
  }
}

export async function resolveBapiSecretKey(options: ResolveBapiSecretKeyOptions): Promise<string> {
  const source = await chooseBapiKeySource(options);
  switch (source.kind) {
    case "flag":
    case "exported":
      validateKeyPrefix(source.secretKey, "sk_");
      return source.secretKey;
    case "app":
      return appSecretKey(source.app, options.instance);
    case "folder":
      return source.keyless.secretKey;
    case "profile":
      return profileSecretKey(options);
  }
}

async function appSecretKey(appId: string, instanceFlag: string | undefined): Promise<string> {
  const app = await withApiContext(fetchApplication(appId), "Failed to resolve secret key");
  const resolved = resolveFetchedApplicationInstance(appId, app, instanceFlag);
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

async function profileSecretKey(options: ResolveBapiSecretKeyOptions): Promise<string> {
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

  declareSoftExitError(error, { userSuppliedPath: false });
  process.exitCode = 1;
  return true;
}
